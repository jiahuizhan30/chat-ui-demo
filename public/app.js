// The UI. Vanilla JS, no build step. Three ideas to find in this file:
//   1. STREAMING: read the SSE response chunk by chunk and feed each chunk to the reducer.
//   2. GENERATIVE UI: map each tool part to a component (see `components`).
//   3. UNTRUSTED OUTPUT: tool inputs/outputs come from the model, so we only use textContent.
(function () {
  const renderMarkdown = window.ChatRender.renderMarkdown;
  const applyChunk = window.ChatState.applyChunk;

  const state = { messages: [], status: 'ready' };
  let flags = {};

  const $ = (id) => document.getElementById(id);
  const els = { log: $('messages'), form: $('form'), input: $('input'), status: $('status'), defenses: $('defenses'), attacker: $('attacker') };
  const msgEls = new WeakMap();
  const partEls = new WeakMap();

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent: never parses HTML
    return n;
  }

  // ---------------------------------------------------------------- generative UI
  function WeatherCard(part) {
    const o = part.output;
    const box = el('div', 'weather');
    box.append(el('span', 'temp', o.tempF + '°F'), el('span', '', o.city + ' · ' + o.condition));
    return box;
  }

  function PageCard(part) {
    const box = el('div');
    const visible = String(part.output.content).replace(/<!--[\s\S]*?-->/g, '').trim();
    box.append(el('div', 'kv', part.output.url), el('pre', '', visible));
    const d = el('details');
    d.append(el('summary', '', "What the model actually received (view source)"), el('pre', '', part.output.content));
    box.append(d);
    return box;
  }

  function EmailCard(part) {
    return el('div', 'kv', 'Email ' + part.output.status + ' to ' + part.output.to);
  }

  function GenericCard(part) {
    return el('pre', '', JSON.stringify(part.output, null, 2));
  }

  // The registry: tool name -> component. This is the whole idea of tool-based generative UI.
  const components = { showWeather: WeatherCard, fetchPage: PageCard, sendEmail: EmailCard };

  function inputSummary(part) {
    const box = el('div', 'kv');
    Object.keys(part.input || {}).forEach(function (k) { box.append(el('div', '', k + ': ' + part.input[k])); });
    return box;
  }

  function approvalButtons(part) {
    const row = el('div', 'btns');
    const yes = el('button', 'approve', 'Approve');
    const no = el('button', 'deny', 'Deny');
    function answer(ok) {
      part.approved = ok;
      part.state = 'approval-responded';
      render();
      streamChat({ resume: true });
    }
    yes.onclick = function () { answer(true); };
    no.onclick = function () { answer(false); };
    row.append(yes, no);
    return row;
  }

  // Every tool state needs a UI, not just the happy path.
  function ToolPart(part) {
    const card = el('div', 'card');
    card.dataset.state = part.state;
    card.append(el('div', 'card-title', 'tool · ' + part.toolName));
    switch (part.state) {
      case 'input-streaming': card.append(el('div', 'skeleton'), el('div', 'skeleton short')); break;
      case 'input-available': card.append(inputSummary(part), el('div', 'kv', 'running…')); break;
      case 'approval-requested':
        card.append(el('div', '', 'The assistant wants to run this tool. Allow it?'), inputSummary(part), approvalButtons(part)); break;
      case 'approval-responded': card.append(el('div', 'kv', part.approved ? 'approved, running…' : 'denied')); break;
      case 'output-available': card.append((components[part.toolName] || GenericCard)(part)); break;
      case 'output-error': card.append(el('div', 'err', 'Error: ' + part.errorText)); break;
      case 'output-denied': card.append(el('div', 'err', 'You denied this tool call.')); break;
    }
    return card;
  }

  // ---------------------------------------------------------------- rendering
  function updatePart(msg, part, node) {
    if (part.type === 'text') {
      if (node.dataset.src === part.text) return;
      node.dataset.src = part.text;
      if (msg.role === 'user') node.textContent = part.text;
      else node.innerHTML = renderMarkdown(part.text, { blockExternalImages: !!flags.blockExternalImages });
      return;
    }
    const key = JSON.stringify([part.state, part.input, part.output, part.errorText, part.approved]);
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.replaceChildren(ToolPart(part));
  }

  function render() {
    state.messages.forEach(function (msg) {
      let m = msgEls.get(msg);
      if (!m) { m = el('div', 'msg ' + msg.role); msgEls.set(msg, m); els.log.appendChild(m); }
      msg.parts.forEach(function (part) {
        let p = partEls.get(part);
        if (!p) { p = el('div', 'part ' + part.type); partEls.set(part, p); m.appendChild(p); }
        updatePart(msg, part, p);
      });
    });
    els.status.textContent = state.status;
    els.status.dataset.status = state.status;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function renderDefenses() {
    const labels = {
      approval: 'Human approval (sendEmail)', validateArgs: 'Validate tool args (policy)',
      blockExternalImages: 'Block external images', removeOutboundTool: 'Remove sendEmail tool',
    };
    els.defenses.replaceChildren();
    Object.keys(labels).forEach(function (k) {
      const li = el('li');
      li.append(el('span', '', labels[k]), el('span', flags[k] ? 'on' : 'off', flags[k] ? 'ON' : 'off'));
      els.defenses.append(li);
    });
  }

  // ---------------------------------------------------------------- streaming
  async function streamChat(opts) {
    const resume = !!(opts && opts.resume);
    state.status = 'submitted';
    render();
    try {
      flags = await (await fetch('/api/defenses')).json();
      renderDefenses();
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: state.messages }),
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {          // one SSE event = text up to a blank line
          const evt = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (evt.indexOf('data: ') !== 0) continue;
          const data = evt.slice(6);
          if (data === '[DONE]') continue;
          applyChunk(state, JSON.parse(data), { resume: resume });
          render();
        }
      }
    } catch (err) {
      console.error(err);
      state.status = 'error';
    }
    if (state.status === 'streaming' || state.status === 'submitted') state.status = 'ready';
    render();
  }

  function send(text) {
    text = text.trim();
    if (!text || state.status === 'streaming' || state.status === 'submitted') return;
    state.messages.push({ role: 'user', parts: [{ type: 'text', text: text }] });
    streamChat();
  }

  // ---------------------------------------------------------------- attacker panel
  let lastAttackerKey = '';
  async function pollAttacker() {
    try {
      const log = await (await fetch('/evil/log')).json();
      const key = JSON.stringify(log);
      if (key === lastAttackerKey) return;
      lastAttackerKey = key;
      els.attacker.replaceChildren();
      if (!log.length) { els.attacker.append(el('li', 'empty', 'nothing received')); return; }
      log.forEach(function (e) { els.attacker.append(el('li', '', '[' + e.kind + '] ' + e.data)); });
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- wiring
  els.form.addEventListener('submit', function (e) { e.preventDefault(); send(els.input.value); els.input.value = ''; });
  document.querySelectorAll('[data-q]').forEach(function (b) { b.onclick = function () { send(b.dataset.q); }; });
  $('reset').onclick = async function () {
    await fetch('/api/reset', { method: 'POST' });
    state.messages = []; state.status = 'ready';
    els.log.replaceChildren();
    lastAttackerKey = '';
    pollAttacker(); render();
  };

  fetch('/api/defenses').then(function (r) { return r.json(); }).then(function (f) { flags = f; renderDefenses(); });
  setInterval(pollAttacker, 700);
  pollAttacker();
  render();
})();
