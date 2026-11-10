// Standalone runner for the chief of staff: no Electron, only Node built-ins, so it runs the same on a Mac.
//   node serve.js                then open http://localhost:4747   (--no-open skips opening the browser)
// It hosts the orchestrator from index.js and a one-page UI (web/index.html) over HTTP + Server-Sent Events.
// This server can place phone calls, so it only listens on 127.0.0.1 and refuses requests from other web pages.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PAGE = path.join(__dirname, 'web', 'index.html');
const MAX_BODY = 10 * 1024;
const MAX_NOTES = 20;
const KEEPALIVE_MS = 20000;

const stamp = () => new Date().toTimeString().slice(0, 8);

function start({ port = process.env.PORT || 4747, open = true, appDataDir } = {}) {
  const cfg = require('./keys');
  const settingsFile = cfg.ensure();
  const dir = appDataDir || cfg.dir;

  let notes = [];          // newest first, last 20
  let notice = null;       // most recent notification
  let lastState = null;
  const clients = new Set();

  const log = (m) => console.log(`${stamp()}  ${m}`);
  const payload = (state) => ({ state: state || lastState, notes, notice, settingsFile });
  const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const broadcast = () => { const o = payload(); for (const r of clients) { try { send(r, o); } catch {} } };

  const addNote = (n) => {
    if (!n || typeof n !== 'object') return;
    notes.unshift({ title: String(n.title || ''), body: String(n.body || ''), time: new Date().toISOString() });
    if (notes.length > MAX_NOTES) notes.length = MAX_NOTES;
    broadcast();
  };
  const onState = (s) => { lastState = s; broadcast(); };
  const notify = (title, body) => {
    notice = { title: String(title || ''), body: String(body || ''), time: new Date().toISOString() };
    log(`notification: ${notice.title} - ${notice.body}`);
    broadcast();
  };

  const chief = require('./index')({ appDataDir: dir, profile: () => cfg().profile || '', addNote, onState, notify, log });
  lastState = chief.state();

  // Only this page, on this machine, may talk to the server (a call costs money and rings a real phone).
  const actualPort = () => { const a = server.address(); return a && a.port; };
  const originOk = (req) => {
    const p = actualPort();
    const o = req.headers.origin;
    if (o !== undefined && o !== `http://localhost:${p}` && o !== `http://127.0.0.1:${p}`) return false;
    // Host check blocks DNS-rebinding, where a hostile name points at 127.0.0.1
    const h = req.headers.host;
    return h === `localhost:${p}` || h === `127.0.0.1:${p}`;
  };
  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  function readBody(req, res, cb) {
    let size = 0; const chunks = []; let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        res.setHeader('Connection', 'close');
        json(res, 413, { ok: false, error: 'request too large' });
        req.resume(); // let the client finish sending so it can read the answer, then drop the socket
        setTimeout(() => req.destroy(), 300).unref();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; cb(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { done = true; });
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { return json(res, 400, { ok: false, error: 'bad url' }); }
    if (!originOk(req)) return json(res, 403, { ok: false, error: 'forbidden' });

    if (req.method === 'GET' && pathname === '/') {
      fs.readFile(PAGE, (err, buf) => {
        if (err) return json(res, 500, { ok: false, error: 'page missing: web/index.html' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
        res.end(buf);
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/state') return json(res, 200, payload(chief.state()));
    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      send(res, payload(chief.state()));
      return;
    }
    if (req.method === 'POST' && pathname === '/action') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'content-type must be application/json' });
      return readBody(req, res, async (text) => {
        let a;
        try { a = JSON.parse(text); } catch { return json(res, 400, { ok: false, error: 'body is not valid JSON' }); }
        if (!a || typeof a !== 'object' || Array.isArray(a)) return json(res, 400, { ok: false, error: 'body must be a JSON object' });
        let r;
        try { r = await chief.action(a); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
        json(res, 200, r || { ok: true });
      });
    }
    json(res, 404, { ok: false, error: 'not found' });
  });

  const keepAlive = setInterval(() => { for (const r of clients) { try { r.write(': keep-alive\n\n'); } catch {} } }, KEEPALIVE_MS);

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), '127.0.0.1', () => {
      server.removeListener('error', reject);
      const url = `http://localhost:${actualPort()}`;
      log(`settings file (paste keys here): ${settingsFile}`);
      chief.start();
      log(`chief of staff running at ${url}`);
      if (open) openBrowser(url);
      resolve(url);
    });
  });

  let closed = false;
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    clearInterval(keepAlive);
    try { chief.stop(); } catch {}
    for (const r of clients) { try { r.end(); } catch {} }
    clients.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return { server, chief, close, listening };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {}); // no browser is fine, the address is printed
    p.unref();
  } catch {}
}

module.exports = { start };

if (require.main === module) {
  const app = start({ open: !process.argv.includes('--no-open') });
  app.listening.catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? `port ${process.env.PORT || 4747} is already in use; set PORT=<other> and try again` : `could not start: ${e.message}`);
    process.exit(1);
  });
  process.on('SIGINT', () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
}
