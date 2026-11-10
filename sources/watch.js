// Event source: topics the person asked to watch ("Vapi outage", "my company name"). Each topic is
// searched with Exa every few minutes; results not seen before for that topic become events.
// The first successful search of a topic is a baseline (already out when watching began), flagged so
// the app shows those without ever phoning about them. poll() never throws; problems go to health().
const crypto = require('crypto');

const URL_ = 'https://api.exa.ai/search';
const TIMEOUT_MS = 6000;
const MAX_TOPICS = 5;
const TOPIC_CHARS = 120;
const SEEN_CAP = 500;
const WINDOW_MS = 48 * 3600 * 1000;
const DEFAULT_MINUTES = 5;

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

module.exports = ({ cfg, log = () => {}, fetch: fetchFn = globalThis.fetch, now = Date.now }) => {
  const topics = new Map(); // topic -> { seen: Set<url> (oldest first), baselined: bool, last: ms of last attempt }
  let noDate = false;       // Exa rejected startPublishedDate once; do not send it again
  let lastError = null;
  let running = false;

  const say = (m) => { try { log(m); } catch {} };
  const clock = () => { const t = now(); return t instanceof Date ? t.getTime() : Number(t); };
  const keyOf = () => { try { return String(cfg().exaKey || ''); } catch { return ''; } };

  // Never let a key reach a message, even if a library echoes it back.
  const safe = (e, key) => {
    let m = String((e && e.message) || e || 'failed');
    if (key) m = m.split(key).join('***');
    return clip(m, 80) || 'failed';
  };

  function topicList() {
    let raw;
    try { raw = cfg().watches; } catch { raw = null; }
    const out = [];
    for (const t of Array.isArray(raw) ? raw : []) {
      if (out.length >= MAX_TOPICS) break;
      const s = typeof t === 'string' ? clip(t, TOPIC_CHARS) : '';
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }

  function intervalMs() {
    let m;
    try { m = Number(cfg().watchMinutes); } catch { m = NaN; }
    if (!Number.isFinite(m)) m = DEFAULT_MINUTES;
    return Math.max(1, m) * 60 * 1000;
  }

  async function post(body, key) {
    const ctl = new AbortController();
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error('timeout')); }, TIMEOUT_MS); });
    const run = (async () => {
      const res = await fetchFn(URL_, {
        method: 'POST',
        headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) { const e = new Error('http ' + res.status); e.status = res.status; throw e; }
      return res.json();
    })();
    run.catch(() => {});
    try { return await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
  }

  async function search(topic, key) {
    const body = { query: topic, numResults: 5, type: 'fast', contents: { highlights: true } };
    if (!noDate) body.startPublishedDate = new Date(clock() - WINDOW_MS).toISOString();
    try {
      return await post(body, key);
    } catch (e) {
      if (e && e.status === 400 && body.startPublishedDate) {
        noDate = true;
        delete body.startPublishedDate;
        return post(body, key);
      }
      throw e;
    }
  }

  function toEvent(r, topic) {
    const url = r.url;
    const d = new Date(r.publishedDate);
    const hl = Array.isArray(r.highlights) ? r.highlights.filter((h) => typeof h === 'string') : [];
    return {
      id: 'watch:' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 16),
      source: 'watch', kind: 'news',
      title: `News on "${topic}": ${clip(r.title || url, 120)}`,
      detail: clip(hl.join(' '), 600),
      url,
      ts: r.publishedDate && !isNaN(d) ? d.toISOString() : new Date(clock()).toISOString(),
      sample: false,
      topic,
    };
  }

  async function poll() {
    if (running) return []; // a slow search is still going; the next poll picks up
    running = true;
    try {
      const key = keyOf();
      if (!key) return [];
      const list = topicList();
      for (const t of [...topics.keys()]) if (!list.includes(t)) topics.delete(t);
      const every = intervalMs();
      const events = [];

      for (const topic of list) {
        let st = topics.get(topic);
        if (!st) { st = { seen: new Set(), baselined: false, last: 0 }; topics.set(topic, st); }
        if (st.last && clock() - st.last < every) continue;
        st.last = clock(); // set before the call so a failure also waits out the interval
        try {
          const data = await search(topic, key);
          const results = Array.isArray(data && data.results) ? data.results : [];
          for (const r of results) {
            if (!r || typeof r.url !== 'string' || !r.url || st.seen.has(r.url)) continue;
            st.seen.add(r.url);
            if (st.seen.size > SEEN_CAP) st.seen.delete(st.seen.values().next().value);
            const ev = toEvent(r, topic);
            if (!st.baselined) ev.baseline = true;
            events.push(ev);
          }
          st.baselined = true;
          lastError = null;
        } catch (e) {
          lastError = safe(e, key);
          say('watch: ' + lastError);
        }
      }
      return events;
    } catch (e) {
      lastError = safe(e, keyOf());
      return [];
    } finally {
      running = false;
    }
  }

  function health() {
    if (!keyOf()) return 'off';
    const n = topicList().length;
    if (!n) return 'ok (no topics)';
    return lastError ? 'error: ' + lastError : `ok (${n} topics)`;
  }

  return { name: 'watch', poll, health };
};
