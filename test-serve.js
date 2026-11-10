// Test for cos/serve.js in mock mode: node cos/test-serve.js (exit 0 = pass). Touches no real keys or state.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Must be set before anything requires ./keys, so no real settings are read and no GitHub request is made.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-serve-'));
process.env.COS_CONFIG = path.join(tmp, 'cos.json');
fs.writeFileSync(process.env.COS_CONFIG, JSON.stringify({ repos: [] }));

const { start } = require('./serve');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
const post = (port, obj, headers = {}) => request(port, 'POST', '/action', { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(obj) });
const getState = async (port) => JSON.parse((await request(port, 'GET', '/state')).text);

function firstSseMessage(port) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('no SSE message within 3 s')); }, 3000);
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      assert.ok(/text\/event-stream/.test(res.headers['content-type']), 'SSE content type');
      let t = ''; res.setEncoding('utf8');
      res.on('data', (c) => {
        t += c;
        const m = t.match(/^data: (.*)\n\n/m);
        if (m) { clearTimeout(timer); req.destroy(); resolve(JSON.parse(m[1])); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

async function main() {
  const app = start({ port: 0, open: false, appDataDir: path.join(tmp, 'state') });
  try {
    await app.listening;
    const port = app.server.address().port;

    const page = await request(port, 'GET', '/');
    assert.strictEqual(page.status, 200);
    assert.ok(/text\/html/.test(page.headers['content-type']) && /<html/i.test(page.text), 'GET / returns HTML');

    const s0 = await getState(port);
    for (const k of ['events', 'calls', 'settings', 'health']) assert.ok(k in s0.state, 'state.' + k);
    assert.ok(Array.isArray(s0.state.events) && Array.isArray(s0.state.calls));
    assert.ok('threshold' in s0.state.settings && 'myPhoneSet' in s0.state.settings);
    for (const k of ['github', 'plaid', 'jev', 'exa', 'vapi']) assert.ok(k in s0.state.health, 'health.' + k);
    assert.ok(Array.isArray(s0.notes) && typeof s0.settingsFile === 'string' && 'notice' in s0);

    // typo: shows up in the feed, no call
    const typo = await post(port, { type: 'demo', scenario: 'typo' });
    assert.strictEqual(typo.status, 200);
    const typoRes = JSON.parse(typo.text);
    assert.strictEqual(typoRes.ok, true, 'typo demo ok');
    let st = (await getState(port)).state;
    const typoEv = st.events.find((e) => e.id === typoRes.id);
    assert.ok(typoEv, 'typo event is in the feed');
    assert.ok(!['calling', 'called'].includes(typoEv.status), 'typo is not called, was ' + typoEv.status);

    // foreign origin and wrong content type are refused, and no call comes of it
    const before = (await getState(port)).state.calls.length;
    const bad = await post(port, { type: 'demo', scenario: 'leak' }, { Origin: 'http://evil.example' });
    assert.strictEqual(bad.status, 403, 'foreign Origin refused');
    const okOrigin = await post(port, { type: 'refresh' }, { Origin: `http://localhost:${port}` });
    assert.strictEqual(okOrigin.status, 200, 'own origin accepted');
    const plain = await request(port, 'POST', '/action', { headers: { 'Content-Type': 'text/plain' }, body: '{"type":"refresh"}' });
    assert.strictEqual(plain.status, 415, 'non-JSON content type refused');
    const junk = await request(port, 'POST', '/action', { headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    assert.strictEqual(junk.status, 400, 'invalid JSON refused');
    const big = await request(port, 'POST', '/action', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'x', pad: 'a'.repeat(11000) }) }).catch((e) => ({ status: 413, err: e }));
    assert.strictEqual(big.status, 413, 'oversized body refused');
    assert.strictEqual((await getState(port)).state.calls.length, before, 'refused requests placed no call');

    // SSE delivers the state
    const msg = await firstSseMessage(port);
    assert.ok(msg.state && Array.isArray(msg.state.events), 'SSE message carries state');

    // leak: a mock call is placed and finishes, the event ends up 'called'
    const leak = JSON.parse((await post(port, { type: 'demo', scenario: 'leak' })).text);
    assert.strictEqual(leak.ok, true, 'leak demo ok');
    let call = null, ev = null;
    for (let i = 0; i < 50; i++) {
      st = (await getState(port)).state;
      call = st.calls.find((c) => c.eventIds.includes(leak.id));
      ev = st.events.find((e) => e.id === leak.id);
      if (call && call.status === 'done') break;
      await sleep(250);
    }
    assert.ok(call, 'a call was created for the leak');
    assert.strictEqual(call.status, 'done', 'call reached done, was ' + call.status);
    assert.strictEqual(call.mock, true, 'call is a mock');
    assert.strictEqual(ev.status, 'called', 'leak event is called, was ' + ev.status);

    // orders: the server forwards any action to the orchestrator and returns its answer.
    // Written to pass whether or not index.js knows these actions yet: the answer must be JSON with an 'ok' field.
    const ordersEv = (await getState(port)).state.events.find((e) => e.id === typoRes.id);
    for (const a of [
      { type: 'order', action: 'mute_similar', eventId: ordersEv.id, text: '' },
      { type: 'set_orders_mode', value: 'ask' },
    ]) {
      const r = await post(port, a);
      assert.strictEqual(r.status, 200, a.type + ' answered 200');
      const body = JSON.parse(r.text);
      assert.ok(body && typeof body === 'object' && typeof body.ok === 'boolean', a.type + ' answer has an ok field: ' + r.text);
      if (body.ok === false) assert.strictEqual(typeof body.error, 'string', a.type + ' failure carries an error text');
    }

    // more features: custom, watches, feedback, daily briefing. Same rule: pass before and after index.js knows them.
    for (const a of [
      { type: 'custom', text: 'prod database is at 98% disk' },
      { type: 'add_watch', topic: 'test topic' },
      { type: 'remove_watch', topic: 'test topic' },
      { type: 'feedback', eventId: ordersEv.id, value: 'good' },
      { type: 'feedback', eventId: ordersEv.id, value: null },
      { type: 'set_daily', value: '' },
    ]) {
      const r = await post(port, a);
      assert.strictEqual(r.status, 200, a.type + ' answered 200');
      const body = JSON.parse(r.text);
      assert.ok(body && typeof body === 'object' && typeof body.ok === 'boolean', a.type + ' answer has an ok field: ' + r.text);
      if (body.ok === false) assert.strictEqual(typeof body.error, 'string', a.type + ' failure carries an error text');
    }

    console.log('test-serve: all checks passed');
  } finally {
    await app.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main().then(() => process.exit(0), (e) => { console.error('test-serve FAILED:', e && e.stack || e); process.exit(1); });
setTimeout(() => { console.error('test-serve FAILED: timed out'); process.exit(1); }, 40000).unref();
