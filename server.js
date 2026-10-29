'use strict';
// Zero-dependency server: static files + POST /api/chat (SSE) + a simulated attacker server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { runAgent } = require('./agent');

const PUBLIC = path.join(__dirname, 'public');
const DEFAULT_FLAGS = { approval: false, validateArgs: false, blockExternalImages: false, removeOutboundTool: false };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function readFlagsFromFile() {
  try {
    return { ...DEFAULT_FLAGS, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'defenses.json'), 'utf8')) };
  } catch (e) {
    return { ...DEFAULT_FLAGS };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function createApp({ delayMs = 35, getFlags = readFlagsFromFile } = {}) {
  const attackerLog = []; // what the "attacker" has received
  let idCounter = 0;

  const ctx = {
    sleep: (n) => (delayMs ? new Promise((r) => setTimeout(r, delayMs * n)) : Promise.resolve()),
    newId: () => 'call_' + ++idCounter,
    sendMail: ({ to, subject, body }) => {
      if (/@evil\.test$/.test(to)) attackerLog.push({ time: new Date().toISOString(), kind: 'email', data: `to=${to} subject=${subject} body=${body}` });
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/defenses') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(getFlags()));
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let body;
      try { body = await readBody(req); } catch (e) { res.writeHead(400); return res.end('Bad JSON'); }
      if (!Array.isArray(body.messages)) { res.writeHead(400); return res.end('messages[] required'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      try {
        for await (const chunk of runAgent({ messages: body.messages, flags: getFlags(), ctx })) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'error', errorText: String(e.message || e) })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ---- Simulated attacker server ----
    if (url.pathname === '/evil/collect.png') {
      attackerLog.push({ time: new Date().toISOString(), kind: 'image-beacon', data: decodeURIComponent(url.searchParams.get('d') || '') });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(PIXEL);
    }
    if (url.pathname === '/evil/log') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(attackerLog));
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      attackerLog.length = 0;
      res.writeHead(204);
      return res.end();
    }

    // ---- Static files ----
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.join(PUBLIC, path.normalize(rel));
      if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    res.writeHead(404);
    res.end('Not found');
  });

  return { server, attackerLog };
}

module.exports = { createApp };

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().server.listen(port, () => console.log(`Chat demo running at http://localhost:${port}`));
}
