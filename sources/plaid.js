// Event source: card charges. Sandbox only, so every event is marked sample: true.
// With Plaid sandbox keys it reads the sandbox's fake transactions; without keys it serves a fixed
// set of believable charges so the whole pipeline can be tried. inject() stages one extra charge.
const BASE = 'https://sandbox.plaid.com';
const TIMEOUT_MS = 10000;
const NEWEST = 25;
const HOUR = 3600 * 1000;

// [merchant, amount, hours ago, category]
const SAMPLES = [
  ['Blue Bottle Coffee', 5.75, 3, 'Food and drink'],
  ['Whole Foods Market', 87.32, 9, 'Groceries'],
  ['Netflix', 15.49, 20, 'Entertainment'],
  ['Uber', 23.1, 27, 'Travel'],
  ['Amazon Web Services', 41.27, 31, 'Cloud hosting'],
  ['Chipotle', 14.85, 36, 'Food and drink'],
  ['Shell', 48.2, 42, 'Gas'],
  ['Spotify', 11.99, 46, 'Entertainment'],
];

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const money = (n) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nice = (s) => { const t = String(s || '').replace(/_/g, ' ').toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : ''; };

function charge({ id, merchant, amount, ts, category, pending }) {
  return {
    id, source: 'plaid', kind: 'charge',
    title: amount < 0 ? `${money(amount)} refund from ${merchant}` : `${money(amount)} charge at ${merchant}`,
    detail: clip(`Merchant: ${merchant}. Category: ${category || 'Uncategorized'}. ${pending ? 'Pending.' : 'Posted.'}`, 600),
    amount, ts, sample: true,
  };
}

module.exports = ({ cfg, log = () => {}, fetch: fetchFn = globalThis.fetch }) => {
  const injected = [];
  let seq = 0;

  const t0 = Date.now(); // fixed at creation so sample timestamps do not drift between polls
  const samples = SAMPLES.map(([merchant, amount, hrs, category], i) =>
    charge({ id: `plaid:sample-${i + 1}`, merchant, amount, category, pending: hrs < 6, ts: new Date(t0 - hrs * HOUR).toISOString() }));

  // sandbox state, in memory only: the access token is never written anywhere
  let clientId = '';
  let accessToken = null;
  let linking = null;
  let cursor = '';
  const txns = new Map(); // transaction_id -> Event
  let status = null; // set by poll(); until then health() works it out from the settings

  async function post(path, body, keys) {
    const res = await fetchFn(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: keys.plaidClientId, secret: keys.plaidSecret, ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const e = new Error(clip(`${data.error_code || 'HTTP ' + res.status} ${data.error_message || ''}`, 100));
      e.code = data.error_code;
      throw e;
    }
    return data;
  }

  // Create a sandbox bank link and swap it for an access token, once per process.
  function link(keys) {
    if (!linking) {
      linking = (async () => {
        const pub = await post('/sandbox/public_token/create', { institution_id: 'ins_109508', initial_products: ['transactions'] }, keys);
        const ex = await post('/item/public_token/exchange', { public_token: pub.public_token }, keys);
        accessToken = ex.access_token;
      })().catch((e) => { linking = null; throw e; }); // try again on the next poll
    }
    return linking;
  }

  const toEvent = (t) => {
    const merchant = t.merchant_name || t.name || 'Unknown merchant';
    const pf = t.personal_finance_category;
    const category = (pf && nice(pf.primary)) || (Array.isArray(t.category) && t.category.join(' > ')) || '';
    const d = new Date(t.datetime || t.authorized_datetime || t.date);
    return charge({ id: `plaid:${t.transaction_id}`, merchant, amount: Number(t.amount), ts: isNaN(d) ? new Date().toISOString() : d.toISOString(), category, pending: !!t.pending });
  };

  async function sync(keys) {
    if (keys.plaidClientId !== clientId) { clientId = keys.plaidClientId; accessToken = null; linking = null; cursor = ''; txns.clear(); }
    await link(keys);
    let next = cursor;
    for (let more = true, pages = 0; more && pages < 20; pages++) {
      let r;
      try { r = await post('/transactions/sync', { access_token: accessToken, cursor: next }, keys); }
      catch (e) { if (e.code === 'PRODUCT_NOT_READY') return; throw e; } // sandbox is still making the data
      for (const t of [...(r.added || []), ...(r.modified || [])]) txns.set(t.transaction_id, toEvent(t));
      for (const t of r.removed || []) txns.delete(t.transaction_id);
      next = r.next_cursor || next;
      more = !!r.has_more;
    }
    cursor = next;
  }

  async function poll() {
    let base;
    try {
      const keys = cfg();
      if (keys.plaidClientId && keys.plaidSecret) {
        try { await sync(keys); status = 'ok'; }
        catch (e) { status = 'error: ' + clip(e && e.message, 80); log('plaid: ' + status); }
        base = [...txns.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, NEWEST);
      } else {
        status = 'sample';
        base = samples;
      }
    } catch (e) {
      status = 'error: ' + clip(e && e.message, 80);
      base = [];
    }
    return [...injected, ...base].map((e) => ({ ...e })).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  }

  // Stage a charge for a demo ("an unrecognised $1,240 charge"); it appears on the next poll.
  function inject({ merchant, amount } = {}) {
    const n = Number(amount);
    const e = charge({
      id: `plaid:injected-${Date.now().toString(36)}-${++seq}`,
      merchant: clip(merchant, 80) || 'Unknown merchant',
      amount: Number.isFinite(n) ? n : 0,
      ts: new Date().toISOString(), category: 'Uncategorized', pending: false,
    });
    injected.push(e);
    if (injected.length > 20) injected.shift();
    return { ...e };
  }

  const health = () => {
    if (status) return status;
    try { const k = cfg(); return k.plaidClientId && k.plaidSecret ? 'ok' : 'sample'; } catch { return 'sample'; }
  };

  return { name: 'plaid', poll, health, inject };
};
