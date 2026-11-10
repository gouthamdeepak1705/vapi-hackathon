// Background lookup for the phone call, via Exa web search. Only public facts leave the machine: for a
// charge that is the merchant name alone (never the amount or account), for an alert the advisory id
// or package name, for a failed build one error line.
const ANSWER_MS = 5000;
const SEARCH_MS = 3000;
const BASE = 'https://api.exa.ai';

const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function merchantOf(event) {
  let m = event.merchant;
  if (!m) {
    const t = String(event.title || '');
    const at = t.match(/\b(?:at|from|to)\s+(.+)$/i);
    m = at ? at[1] : t.replace(/^\s*(charge|purchase|payment|card)\b[:\s-]*/i, '');
  }
  m = String(m)
    .replace(/[$£€]\s?\d[\d,.]*/g, ' ')                   // amounts
    .replace(/\b\d[\d,.]*\s?(usd|dollars?)\b/gi, ' ')
    .replace(/\s(for|on|via|using)\s.*$/i, ' ')            // "... for $12 on card"
    .replace(/\s[-–—(].*$/, ' ')
    .replace(/\b\d{4,}\b/g, ' ');                          // card or account digits
  m = clean(m, 60).replace(/^[\s:,.-]+|[\s:,.-]+$/g, '');
  return m || null;
}

function errorLine(detail) {
  const lines = String(detail || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => /\berror\b|exception|TypeError|ReferenceError/i.test(l)) ||
    lines.find((l) => /fail|cannot|can't|not found|undefined|exit code|denied/i.test(l));
  if (!pick) return null;
  // Local paths can carry a user name, so they are dropped.
  return clean(pick.replace(/[A-Za-z]:\\\S*|\/(?:home|Users)\/\S*/g, ''), 200) || null;
}

// The search question for an event, or null when a web lookup would add nothing.
function queryFor(event) {
  if (!event) return null;
  const text = `${event.title || ''} ${event.detail || ''}`;
  if (event.kind === 'charge') {
    const m = merchantOf(event);
    return m ? `What is the business '${m}' and is it a known subscription or a known scam?` : null;
  }
  if (event.kind === 'security_alert') {
    const ids = text.match(/CVE-\d{4}-\d{4,}|GHSA(?:-[a-z0-9]{4}){3}/gi) || [];
    const pkg = text.match(/\bpackage\s+[`'"]?(@?[\w.-]+(?:\/[\w.-]+)?)/i) || text.match(/`(@?[\w.-]+(?:\/[\w.-]+)?)`/);
    const who = [...new Set(ids.map((i) => i.toUpperCase().replace(/^GHSA/, 'GHSA')))].slice(0, 2).concat(pkg ? [pkg[1]] : []);
    return (who.length ? who.join(' ') : clean(event.title, 120)) + ' severity and fix';
  }
  if (event.kind === 'build_failed') {
    const l = errorLine(event.detail);
    return l ? `${l} cause and fix` : null;
  }
  return null;
}

module.exports = ({ cfg, log }) => {
  let lastFail = null;
  const cache = new Map(); // query -> { at, value }; successes are kept, failures only briefly
  const say = (...a) => { try { (log || (() => {}))(...a); } catch {} };

  async function post(path, key, body, ms) {
    const ctl = new AbortController();
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error('timeout')); }, ms); });
    const run = (async () => {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    })();
    run.catch(() => {});
    try { return await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
  }

  const sourcesOf = (list) => (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r.url === 'string' && r.url)
    .slice(0, 3).map((r) => ({ title: clean(r.title || r.url, 120), url: r.url }));
  const trim = (s) => { s = clean(s, 100000); return s.length > 400 ? s.slice(0, 399).trimEnd() + '…' : s; };

  async function lookup(query, key) {
    try {
      const r = await post('/answer', key, { query, text: false }, ANSWER_MS);
      const answer = r && trim(r.answer);
      if (!answer) throw new Error('empty answer');
      return { answer, sources: sourcesOf(r.citations) };
    } catch (e) {
      say('exa answer failed: ' + ((e && e.message) || e));
    }
    // /answer can take several seconds; /search is quicker and still gives a usable snippet.
    const r = await post('/search', key, { query, numResults: 3, type: 'fast', contents: { highlights: true } }, SEARCH_MS);
    const results = (r && r.results) || [];
    const first = results.map((x) => x && Array.isArray(x.highlights) && x.highlights[0]).find(Boolean);
    const answer = first && trim(first);
    if (!answer) throw new Error('no results');
    return { answer, sources: sourcesOf(results) };
  }

  async function context(event) {
    try {
      const key = cfg().exaKey;
      if (!key) return null;
      const query = queryFor(event);
      if (!query) return null;
      const hit = cache.get(query);
      if (hit && (hit.value || Date.now() - hit.at < 60000)) return hit.value;
      let value = null;
      try {
        value = await lookup(query, key);
        lastFail = null;
      } catch (e) {
        lastFail = clean((e && e.message) || e, 60);
        say('exa failed: ' + lastFail);
      }
      cache.set(query, { at: Date.now(), value });
      return value;
    } catch { return null; }
  }

  function health() {
    let key = '';
    try { key = cfg().exaKey; } catch {}
    if (!key) return 'off';
    return lastFail ? 'error: ' + lastFail : 'ok';
  }

  return { context, health };
};
module.exports.queryFor = queryFor;
