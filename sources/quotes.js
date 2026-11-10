// Event source: big price moves. Watches a few tickers (settings "tickers", default SPY and NVDA) and
// turns a day move of at least "moveAlertPct" percent (default 2) into an event, once per ticker per
// direction per whole percent, so 2.4% and then 3.1% are two events. Quotes come from Yahoo's public
// chart feed (no key). Information only: it never trades and never says buy or sell.
// poll() never throws; problems go to health().
const URL_ = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const TIMEOUT_MS = 6000;
const EVERY_MS = 60 * 1000;
const DEFAULT_TICKERS = ['SPY', 'NVDA'];
const DEFAULT_PCT = 2;
const MAX_TICKERS = 5;

const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = ({ cfg, log = () => {}, fetch: fetchFn = globalThis.fetch, now = Date.now }) => {
  let lastRun = 0;
  let lastError = null;
  let seenOk = false;
  let running = false;

  const say = (m) => { try { log(m); } catch {} };
  const settings = () => {
    let c = {};
    try { c = cfg() || {}; } catch {}
    const list = (Array.isArray(c.tickers) ? c.tickers : DEFAULT_TICKERS)
      .map((t) => String(t || '').trim().toUpperCase())
      .filter((t) => /^[A-Z.\-]{1,6}$/.test(t))
      .slice(0, MAX_TICKERS);
    const pct = Number(c.moveAlertPct);
    return { tickers: list.length ? list : DEFAULT_TICKERS, pct: pct > 0 && pct < 50 ? pct : DEFAULT_PCT };
  };

  async function quote(sym) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchFn(`${URL_}${encodeURIComponent(sym)}?interval=1d&range=5d`, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`${sym}: quote feed answered ${res.status}`);
      const r = (await res.json()).chart.result[0];
      const closes = (r.indicators.quote[0].close || []).filter((x) => typeof x === 'number');
      const price = Number(r.meta.regularMarketPrice);
      const prev = closes.length >= 2 ? closes[closes.length - 2] : NaN; // last bar is today's; the one before is the prior close
      if (!(price > 0) || !(prev > 0)) throw new Error(`${sym}: no usable prices`);
      return { sym, price, prev, name: r.meta.shortName || r.meta.symbol || sym, type: r.meta.instrumentType || '', at: Number(r.meta.regularMarketTime) * 1000 || now() };
    } finally { clearTimeout(timer); }
  }

  async function poll() {
    if (running || now() - lastRun < EVERY_MS) return [];
    running = true; lastRun = now();
    const { tickers, pct } = settings();
    const out = [];
    try {
      const results = await Promise.all(tickers.map((t) => quote(t).catch((e) => { lastError = String(e.message || e).slice(0, 120); return null; })));
      if (results.some(Boolean)) { seenOk = true; if (results.every(Boolean)) lastError = null; }
      for (const q of results) {
        if (!q) continue;
        const change = ((q.price - q.prev) / q.prev) * 100;
        if (Math.abs(change) < pct) continue;
        const dir = change > 0 ? 'up' : 'down';
        const day = new Date(q.at).toISOString().slice(0, 10);
        const word = q.type === 'ETF' ? 'ETF' : 'stock';
        out.push({
          id: `quote:${q.sym}:${day}:${dir}:${Math.floor(Math.abs(change))}`,
          source: 'quotes', kind: 'market_move',
          title: `${q.sym} ${dir} ${Math.abs(change).toFixed(2)}% (${money(q.price)})`,
          detail: `${q.name} (${word}) moved ${change > 0 ? '+' : '-'}${Math.abs(change).toFixed(2)}% against the previous close of ${money(q.prev)}. Alert threshold is ${pct}%. Information only, not a recommendation.`,
          ts: new Date(q.at).toISOString(),
          url: `https://finance.yahoo.com/quote/${encodeURIComponent(q.sym)}`,
        });
      }
    } catch (e) { lastError = String(e.message || e).slice(0, 120); say('quotes: ' + lastError); }
    finally { running = false; }
    return out;
  }

  function health() { return lastError ? (seenOk ? 'ok (some tickers failing)' : 'error: ' + lastError) : seenOk ? 'ok' : 'ok (not polled yet)'; }

  return { name: 'quotes', poll, health };
};
