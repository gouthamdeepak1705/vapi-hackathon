// Offline checks for sources/quotes.js: threshold, direction, dedupe ids, rate limit, failure handling.
const assert = require('assert');
const make = require('./sources/quotes');

let n = 0;
const ok = (name) => { n++; console.log('ok   ' + name); };
const chart = (price, prev, extra = {}) => ({ ok: true, status: 200, json: async () => ({ chart: { result: [{
  meta: { regularMarketPrice: price, regularMarketTime: Date.parse('2026-11-09T21:00:00Z') / 1000, shortName: 'Test Co', instrumentType: 'EQUITY', ...extra },
  indicators: { quote: [{ close: [1, 2, prev, price] }] } }] } }) });

(async () => {
  let clock = 1e12;
  const prices = { SPY: [102.4, 100], NVDA: [95, 100] };
  const calls = [];
  const fetch = async (url) => { calls.push(url); const s = decodeURIComponent(url.split('/chart/')[1].split('?')[0]); return chart(...prices[s], s === 'SPY' ? { instrumentType: 'ETF' } : {}); };
  const src = make({ cfg: () => ({}), fetch, now: () => clock });

  let ev = await src.poll();
  assert.strictEqual(ev.length, 2); ok('default tickers SPY and NVDA both over 2% give two events');
  const spy = ev.find((e) => e.title.startsWith('SPY')), nv = ev.find((e) => e.title.startsWith('NVDA'));
  assert.ok(/SPY up 2\.40%/.test(spy.title) && /ETF/.test(spy.detail)); ok('SPY: up 2.40%, labelled ETF');
  assert.ok(/NVDA down 5\.00%/.test(nv.title) && /stock/.test(nv.detail)); ok('NVDA: down 5.00%, labelled stock');
  assert.ok(/not a recommendation/i.test(spy.detail) && !/\b(buy|sell)\b/i.test(spy.title)); ok('information only, no buy or sell wording');
  assert.strictEqual(spy.kind, 'market_move'); ok('kind is market_move');
  assert.strictEqual(src.health(), 'ok'); ok('health ok');

  assert.deepStrictEqual(await src.poll(), []); assert.strictEqual(calls.length, 2); ok('polls at most once a minute');

  clock += 61000; prices.SPY = [102.45, 100]; ev = await src.poll();
  assert.strictEqual(ev.find((e) => e.title.startsWith('SPY')).id, spy.id); ok('same percent bucket keeps the same id (loop dedupes it)');
  clock += 61000; prices.SPY = [103.2, 100]; ev = await src.poll();
  assert.notStrictEqual(ev.find((e) => e.title.startsWith('SPY')).id, spy.id); ok('next whole percent gives a new id');

  clock += 61000; prices.SPY = [101.9, 100]; prices.NVDA = [99, 100]; ev = await src.poll();
  assert.deepStrictEqual(ev, []); ok('under the threshold gives nothing');

  const custom = make({ cfg: () => ({ tickers: ['spy', 'bad ticker!', 'NVDA'], moveAlertPct: 5 }), fetch, now: () => (clock += 61000) });
  prices.SPY = [103, 100]; prices.NVDA = [94, 100]; ev = await custom.poll();
  assert.deepStrictEqual(ev.map((e) => e.title.split(' ')[0]), ['NVDA']); ok('custom tickers and threshold; bad ticker ignored');

  const bad = make({ cfg: () => ({}), fetch: async () => ({ ok: false, status: 500 }), now: () => (clock += 61000) });
  assert.deepStrictEqual(await bad.poll(), []); assert.ok(/^error/.test(bad.health())); ok('a 500 gives [] and an error health, never throws');
  const down = make({ cfg: () => ({}), fetch: async () => { throw new Error('offline'); }, now: () => (clock += 61000) });
  assert.deepStrictEqual(await down.poll(), []); ok('network failure gives []');
  const junk = make({ cfg: () => ({}), fetch: async () => ({ ok: true, json: async () => ({}) }), now: () => (clock += 61000) });
  assert.deepStrictEqual(await junk.poll(), []); ok('garbage response gives []');

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
