// Tests for sources/watch.js with a fake fetch and a fake clock (no network). `--live` runs one real search.
const assert = require('assert');
const makeWatch = require('./sources/watch');

const KEY = 'exa-secret-key-123';
const T0 = Date.parse('2026-11-09T12:00:00Z');
const MIN = 60 * 1000;

function rig(settings, handler) {
  let t = T0;
  const calls = [];
  const conf = { exaKey: KEY, watches: ['Vapi outage'], ...settings };
  const fetch = async (url, opts) => {
    const call = { url, opts, body: JSON.parse(opts.body) };
    calls.push(call);
    return handler(call, calls.length);
  };
  const ok = (results) => ({ ok: true, status: 200, json: async () => ({ results }) });
  const bad = (status) => ({ ok: false, status, json: async () => ({}) });
  const w = makeWatch({ cfg: () => conf, log: () => {}, fetch, now: () => t });
  return { w, calls, conf, ok, bad, advance: (ms) => { t += ms; } };
}

const res = (n, extra = {}) => ({ url: 'https://example.com/' + n, title: 'Title ' + n, highlights: ['alpha  beta', 'gamma'], publishedDate: '2026-11-08T10:00:00.000Z', ...extra });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('no key gives [] and off, and no request', async () => {
  const r = rig({ exaKey: '' }, () => { throw new Error('should not be called'); });
  assert.deepStrictEqual(await r.w.poll(), []);
  assert.strictEqual(r.w.health(), 'off');
  assert.strictEqual(r.calls.length, 0);
});

test('key with no topics', async () => {
  const r = rig({ watches: undefined }, () => { throw new Error('no'); });
  assert.deepStrictEqual(await r.w.poll(), []);
  assert.strictEqual(r.w.health(), 'ok (no topics)');
  r.conf.watches = ['  ', 5, null];
  assert.deepStrictEqual(await r.w.poll(), []);
  assert.strictEqual(r.w.health(), 'ok (no topics)');
});

test('request carries the key header and expected body', async () => {
  const r = rig({}, function () { return r.ok([]); });
  await r.w.poll();
  assert.strictEqual(r.calls.length, 1);
  const c = r.calls[0];
  assert.strictEqual(c.url, 'https://api.exa.ai/search');
  assert.strictEqual(c.opts.method, 'POST');
  assert.strictEqual(c.opts.headers['x-api-key'], KEY);
  assert.strictEqual(c.body.query, 'Vapi outage');
  assert.strictEqual(c.body.numResults, 5);
  assert.strictEqual(c.body.type, 'fast');
  assert.deepStrictEqual(c.body.contents, { highlights: true });
  assert.strictEqual(c.body.startPublishedDate, new Date(T0 - 48 * 3600 * 1000).toISOString());
  assert.ok(c.opts.signal, 'has a timeout signal');
  assert.strictEqual(r.w.health(), 'ok (1 topics)');
});

test('baseline events, shape, rate limit, then only unseen URLs', async () => {
  const long = 'x'.repeat(900);
  let batch = [res(1, { highlights: [long], title: 'T'.repeat(300) }), res(2), res(3, { publishedDate: 'not a date' })];
  const r = rig({}, () => r.ok(batch));
  const first = await r.w.poll();
  assert.strictEqual(first.length, 3);
  const e = first[0];
  assert.ok(/^watch:[0-9a-f]{16}$/.test(e.id), e.id);
  assert.strictEqual(e.source, 'watch');
  assert.strictEqual(e.kind, 'news');
  assert.strictEqual(e.title, 'News on "Vapi outage": ' + 'T'.repeat(120));
  assert.strictEqual(e.detail.length, 600);
  assert.strictEqual(e.url, 'https://example.com/1');
  assert.strictEqual(e.ts, '2026-11-08T10:00:00.000Z');
  assert.strictEqual(e.sample, false);
  assert.strictEqual(e.topic, 'Vapi outage');
  assert.strictEqual(e.baseline, true);
  assert.strictEqual(first[1].detail, 'alpha beta gamma');
  assert.strictEqual(first[2].ts, new Date(T0).toISOString()); // unparseable date falls back to now
  assert.ok(first.every((x) => x.baseline === true));

  r.advance(30 * 1000);
  assert.deepStrictEqual(await r.w.poll(), []);
  assert.strictEqual(r.calls.length, 1, 'no request 30 s later');

  r.advance(5 * MIN);
  batch = [res(2), res(3), res(4)];
  const next = await r.w.poll();
  assert.strictEqual(r.calls.length, 2);
  assert.strictEqual(next.length, 1);
  assert.strictEqual(next[0].url, 'https://example.com/4');
  assert.ok(!('baseline' in next[0]));
});

test('watchMinutes is respected, with a minimum of 1', async () => {
  const r = rig({ watchMinutes: 10 }, () => r.ok([]));
  await r.w.poll();
  r.advance(9 * MIN);
  await r.w.poll();
  assert.strictEqual(r.calls.length, 1);
  r.advance(1 * MIN);
  await r.w.poll();
  assert.strictEqual(r.calls.length, 2);
  r.conf.watchMinutes = 0;
  r.advance(30 * 1000);
  await r.w.poll();
  assert.strictEqual(r.calls.length, 2, 'minimum is 1 minute');
  r.advance(31 * 1000);
  await r.w.poll();
  assert.strictEqual(r.calls.length, 3);
});

test('a topic added later is searched on the next poll with its own baseline', async () => {
  const r = rig({}, (c) => r.ok(c.body.query === 'Vapi outage' ? [res(1)] : [res(1), res(9)]));
  await r.w.poll();
  r.advance(30 * 1000);
  r.conf.watches = ['Vapi outage', 'OpenAI pricing'];
  const ev = await r.w.poll();
  assert.strictEqual(r.calls.length, 2);
  assert.strictEqual(r.calls[1].body.query, 'OpenAI pricing');
  assert.strictEqual(ev.length, 2);
  assert.ok(ev.every((x) => x.baseline === true && x.topic === 'OpenAI pricing'));
  assert.strictEqual(r.w.health(), 'ok (2 topics)');
});

test('removed topics are forgotten (a re-added topic baselines again)', async () => {
  const r = rig({}, () => r.ok([res(1)]));
  await r.w.poll();
  r.conf.watches = [];
  await r.w.poll();
  r.conf.watches = ['Vapi outage'];
  const ev = await r.w.poll();
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].baseline, true);
});

test('a 400 retries once without startPublishedDate and remembers', async () => {
  const r = rig({}, (c) => (c.body.startPublishedDate ? r.bad(400) : r.ok([res(1)])));
  const ev = await r.w.poll();
  assert.strictEqual(r.calls.length, 2);
  assert.ok('startPublishedDate' in r.calls[0].body);
  assert.ok(!('startPublishedDate' in r.calls[1].body));
  assert.strictEqual(ev.length, 1);
  r.advance(6 * MIN);
  await r.w.poll();
  assert.strictEqual(r.calls.length, 3);
  assert.ok(!('startPublishedDate' in r.calls[2].body));
});

test('a 400 without the date is an error, not a loop', async () => {
  const r = rig({}, () => r.bad(400));
  assert.deepStrictEqual(await r.w.poll(), []);
  assert.strictEqual(r.calls.length, 2);
  assert.ok(/^error: /.test(r.w.health()));
});

test('network error and 500 give [], an error health without the key, and respect the rate limit', async () => {
  let mode = 'net';
  const r = rig({}, () => {
    if (mode === 'net') throw new Error('connect ECONNREFUSED while using ' + KEY);
    if (mode === '500') return r.bad(500);
    return r.ok([res(1)]);
  });
  assert.deepStrictEqual(await r.w.poll(), []);
  let h = r.w.health();
  assert.ok(/^error: /.test(h), h);
  assert.ok(!h.includes(KEY), 'key leaked: ' + h);
  r.advance(30 * 1000);
  await r.w.poll();
  assert.strictEqual(r.calls.length, 1, 'failed search still waits out the interval');

  mode = '500';
  r.advance(5 * MIN);
  assert.deepStrictEqual(await r.w.poll(), []);
  h = r.w.health();
  assert.ok(/^error: .*500/.test(h), h);

  mode = 'ok';
  r.advance(5 * MIN);
  const ev = await r.w.poll();
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].baseline, true, 'failures do not count as the baseline');
  assert.strictEqual(r.w.health(), 'ok (1 topics)');
});

test('a hung search times out instead of hanging', async () => {
  const r = rig({}, () => new Promise(() => {}));
  const realSet = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSet(fn, ms === 6000 ? 20 : ms, ...a);
  try {
    assert.deepStrictEqual(await r.w.poll(), []);
  } finally { global.setTimeout = realSet; }
  assert.strictEqual(r.w.health(), 'error: timeout');
});

test('more than 5 topics uses only the first 5, trimmed and cut to 120', async () => {
  const r = rig({ watches: ['  a  ', 'b', '', 'c', 'd', 'e'.repeat(200), 'f', 'g'] }, () => r.ok([]));
  await r.w.poll();
  assert.deepStrictEqual(r.calls.map((c) => c.body.query), ['a', 'b', 'c', 'd', 'e'.repeat(120)]);
  assert.strictEqual(r.w.health(), 'ok (5 topics)');
});

test('topics are searched one after another', async () => {
  let active = 0, max = 0;
  const r = rig({ watches: ['a', 'b', 'c'] }, async () => {
    active++; max = Math.max(max, active);
    await new Promise((ok) => setImmediate(ok));
    active--;
    return r.ok([]);
  });
  await r.w.poll();
  assert.strictEqual(max, 1);
});

test('seen set is capped at 500 per topic', async () => {
  let batch = [];
  for (let i = 0; i < 5; i++) batch.push(res(i));
  const r = rig({}, () => r.ok(batch));
  await r.w.poll();
  for (let round = 1; round <= 110; round++) {
    r.advance(6 * MIN);
    batch = [0, 1, 2, 3, 4].map((i) => res(round * 10 + i));
    await r.w.poll();
  }
  // the oldest URLs have been evicted, so they count as unseen again
  r.advance(6 * MIN);
  batch = [res(0)];
  const ev = await r.w.poll();
  assert.strictEqual(ev.length, 1);
});

async function live() {
  const cfg = require('./keys');
  if (!cfg().exaKey) { console.log('live: skipped (no exaKey in settings)'); return; }
  const w = makeWatch({ cfg: () => ({ ...cfg(), watches: ['OpenAI API pricing'] }), log: () => {}, fetch: globalThis.fetch, now: Date.now });
  const ev = await w.poll();
  console.log(`live: ${ev.length} events, health ${w.health()}` + (ev[0] ? `, first: ${ev[0].title}` : ''));
}

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + ((e && e.message) || e)); }
  }
  if (process.argv.includes('--live')) {
    try { await live(); } catch (e) { failed++; console.log('FAIL live: ' + String((e && e.message) || e).split(KEY).join('***')); }
  }
  console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
