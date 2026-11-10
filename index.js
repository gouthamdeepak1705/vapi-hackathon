// Chief of staff orchestrator: polls the sources, scores every new event, shows the feed, and
// phones the user (through Vapi) only when something crosses their threshold. See CONTRACT.md.
// Everything it talks to is injectable through `mods`, so the loop can be tested with fakes.
const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 60, MAX_CALLS = 30, MAX_SEEN = 2000, MAX_ORDERS = 30, MAX_WATCHES = 5;
const PROFILE_CAP = 800, FEEDBACK_CAP = 600; // the scorer's profile text; feedback lines get at most FEEDBACK_CAP of it, last
const DAILY_TOPIC = 'Your daily briefing';
const DAY = 86400000;
const ORDER_WINDOW = 2 * 3600000; // orders newer than this go into a call's briefing
const ORDER_ACTIONS = ['rerun_build', 'comment', 'close_issue', 'label_urgent', 'assign_me', 'create_issue', 'mute_similar', 'dispute_charge'];
const ORDER_MODES = ['auto', 'ask', 'off'];
const CALL_MODES = ['phone', 'browser'];
const DEFAULT_TIMING = {
  firstPollMs: 1500,   // first poll shortly after start
  callPollMs: 3000,    // how often an active call is checked
  dueMs: 5000,         // how often scheduled calls are checked
  saveMs: 500,         // save debounce
  ctxWaitMs: 4000,     // how long a call about to be placed waits for the web context
  syncMs: 20000,       // at most one inbound-briefing sync per this long
  giveUpMs: 600000,    // stop watching a call after 10 minutes
  sourceMs: 20000,     // a source that hangs is ignored for the round
  scoreMs: 5000,       // jev should answer in 3 s; this is the backstop
  checkMs: 4000,       // a call about to be placed waits this long, in total, for fresher order results
  orderMs: 60000,      // an order that never answers is marked failed
};

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
// Resolve when p settles or after ms, whichever is first; never rejects and leaves no stray timer.
const waitUpTo = (p, ms) => new Promise((res) => {
  const t = setTimeout(res, ms);
  Promise.resolve(p).then(() => { clearTimeout(t); res(); }, () => { clearTimeout(t); res(); });
});
// Like waitUpTo but gives back the value (or null on timeout/failure).
const valueWithin = (p, ms) => new Promise((res) => {
  const t = setTimeout(() => res(null), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, () => { clearTimeout(t); res(null); });
});

const DEMOS = {
  typo: () => ({ kind: 'issue', title: "Typo in README: 'recieve' should be 'receive'", detail: "Issue opened by a visitor: the Getting started section says 'recieve' in two places. Trivial fix, no urgency." }),
  leak: () => ({ kind: 'security_alert', title: 'API keys committed in config.js are visible in the public repo',
    detail: 'Issue opened by an outside contributor: config.js on the main branch contains what look like live API keys (a sk_live_ style secret and a cloud access key). The repo is public and the file has been there for several commits, so the keys should be treated as exposed and rotated.' }),
  order: () => DEMOS.build(), // same event; its call comes back with an order (see dial)
  build: () => ({ kind: 'build_failed', title: 'Build failed on main',
    detail: 'Workflow "ci" failed on main after the last push. Error: Cannot find module \'./lib/format\' imported from src/report.js (exit code 1). Nothing has been deployed since.' }),
  charge: () => ({ kind: 'charge', title: 'Unrecognised $1,240.00 card charge at ZXQ*NORTHWND HLDGS 8841', amount: 1240,
    detail: 'A charge of $1,240.00 posted at ZXQ*NORTHWND HLDGS 8841. It does not match any merchant or recurring payment seen before.' }),
};

module.exports = ({ appDataDir, profile = () => '', addNote = () => {}, onState = () => {}, notify = () => {}, log = () => {}, mods = {}, now = Date.now, timing = {} } = {}) => {
  const T = { ...DEFAULT_TIMING, ...timing };
  const stateFile = path.join(appDataDir, 'cos-state.json');
  const L = (m) => { try { log(m); } catch {} };

  // ---- modules: anything not injected is built from the real file, and a broken one just stays off ----
  const make = (what, fn) => { try { return fn(); } catch (e) { L(`cos: ${what} unavailable: ${e.message}`); return null; } };
  const cfg = mods.cfg || make('keys', () => require('./keys'));
  if (!cfg) throw new Error('cos settings unavailable');
  const sources = mods.sources || ['github', 'plaid', 'watch', 'quotes'].map((n) => make(n, () => require('./sources/' + n)({ cfg, log: L }))).filter(Boolean);
  const jev = mods.jev || make('jev', () => require('./jev')({ cfg, log: L }));
  const exa = mods.exa || make('exa', () => require('./exa')({ cfg, log: L }));
  const vapi = mods.vapi || make('vapi', () => require('./vapi')({ cfg, log: L }));
  const ordersMod = mods.orders || make('orders', () => require('./orders')({ cfg, log: L }));

  // ---- state ----
  let events = [];          // newest first
  let calls = [];           // newest first
  let orders = [];          // orders given on calls or from the board, newest first
  let mutes = [];           // kinds of event that never place a call
  let seen = new Set();     // every event id ever shown, so repeats from a source are skipped
  let baselined = false;    // the first successful poll of a fresh install is old news
  let stopped = true;
  let placing = false;      // a call is being prepared or dialled
  let pollP = null, callsBusy = false;
  let pollTimer = null, callTimer = null, dueTimer = null, saveTimer = null, syncTimer = null;
  let lastSynced = null, lastSyncAt = 0;
  let seq = 0;
  const ctxP = new Map();   // event id -> pending context lookup (not persisted)

  const iso = (t) => new Date(t).toISOString();
  const newId = (p) => `${p}-${now().toString(36)}-${(seq++).toString(36)}`;
  const threshold = () => { const t = Number(cfg().threshold); return Number.isFinite(t) ? clamp01(t) : 0.7; };
  const callMode = () => (cfg().callMode === 'browser' ? 'browser' : 'phone');
  const noPhone = () => !!cfg().vapiKey && callMode() === 'phone' && !String(cfg().myPhone || '').trim(); // a real key with nowhere to call
  const isWeb = (c) => String(c.vapiId || '').startsWith('web-');
  // A browser call that is ringing and has not been answered or declined on the page yet
  const ringingWeb = (id) => calls.find((c) => c.id === id && c.status === 'ringing' && isWeb(c) && !c.webStep);
  const canCall = () => !!vapi && !noPhone();
  const isActive = (c) => c.status === 'ringing' || c.status === 'in-progress';
  const activeCall = () => calls.find(isActive);
  const callsLastHour = () => calls.filter((c) => c.placedAt && now() - c.placedAt < 3600000).length;
  const capOk = () => callsLastHour() < (Number(cfg().maxCallsPerHour) || 6);
  // Quiet hours like "23:00-07:00" in local time, may wrap past midnight; anything unparseable is off
  function quiet() {
    const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(cfg().quietHours || ''));
    if (!m) return false;
    const [h1, m1, h2, m2] = m.slice(1).map(Number);
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return false;
    const a = h1 * 60 + m1, b = h2 * 60 + m2;
    if (a === b) return false;
    const d = new Date(now()), t = d.getHours() * 60 + d.getMinutes();
    return a < b ? t >= a && t < b : t >= a || t < b;
  }
  const qualifies = (r) => r.score.decision === 'call' && r.score.urgency >= threshold() && (r.score.urgency >= 0.9 || !quiet());
  const ordersMode = () => { const m = cfg().ordersMode; return ORDER_MODES.includes(m) ? m : 'auto'; };
  const isMuted = (e) => mutes.some((m) => m.source === e.source && m.kind === e.kind);
  const MUTED = 'Muted by you.', OLD_NEWS = 'Already out when you started watching.', UNWANTED = "You said calls like this weren't worth it.";
  const withCap = (s, why) => ({ ...s, decision: s.decision === 'call' ? 'brief' : s.decision, reason: s.reason ? `${s.reason} ${why}` : why });
  // Feedback on a source and kind: when 'bad' outweighs 'good' by two or more, new events of it lose 0.15 urgency
  const unwanted = (e) => events.reduce((n, r) => n + (r.source === e.source && r.kind === e.kind ? (r.feedback === 'bad' ? 1 : r.feedback === 'good' ? -1 : 0) : 0), 0) >= 2;
  const withPenalty = (s) => ({ ...s, urgency: Math.max(0, Math.round((s.urgency - 0.15) * 1000) / 1000), reason: s.reason ? `${s.reason} ${UNWANTED}` : UNWANTED });
  const watchList = () => (Array.isArray(cfg().watches) ? cfg().watches : []).filter((t) => typeof t === 'string' && t.trim()).slice(0, MAX_WATCHES);
  const dailyTime = () => { const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(cfg().dailyBriefing || '')); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
  const describeOrder = (a) => { try { return (ordersMod && ordersMod.describe && ordersMod.describe(a)) || String(a); } catch { return String(a); } };
  const recent = (r) => { const t = Date.parse(r.ts); return !Number.isFinite(t) || now() - t < 7 * DAY; };

  const health = () => {
    const h = (m) => { try { return (m && m.health && m.health()) || 'off'; } catch (e) { return 'error: ' + clip(e.message, 40); } };
    const src = (name) => h(sources.find((s) => s && s.name === name));
    return { github: src('github'), plaid: src('plaid'), watch: src('watch'), quotes: src('quotes'), jev: h(jev), exa: h(exa), vapi: !vapi ? 'off' : noPhone() ? 'error: no phone number set' : h(vapi) };
  };

  function snapshot() {
    const c = cfg();
    const ring = calls.find((x) => x.status === 'ringing' && isWeb(x) && !x.webStep);
    return JSON.parse(JSON.stringify({
      events, calls: calls.map(({ placedAt, vapiId, webStep, webReason, ...pub }) => pub),
      orders, mutes,
      ring: ring ? { id: ring.id, topic: ring.topic, reason: ring.webReason || ring.topic } : null,
      // vapiPublicKey is meant for browsers; the private vapiKey never goes in the state
      settings: { threshold: threshold(), myPhoneSet: !!String(c.myPhone || '').trim(), ordersMode: ordersMode(), quietHours: String(c.quietHours || ''), watches: watchList(), dailyBriefing: dailyTime(), callMode: callMode(), tickers: Array.isArray(c.tickers) ? c.tickers.slice(0, 5) : [], moveAlertPct: Number(c.moveAlertPct) || 2, repos: Array.isArray(c.repos) ? c.repos.slice(0, 10) : [], watchMinutes: Number(c.watchMinutes) || 5, vapiPublicKey: String(c.vapiPublicKey || '') },
      health: health(),
    }));
  }

  // ---- persistence: temp file then rename, so a crash never leaves half a file ----
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    try {
      fs.mkdirSync(appDataDir, { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, baselined, seen: [...seen].slice(-MAX_SEEN), events, calls, orders, mutes }));
      fs.renameSync(tmp, stateFile);
    } catch (e) { L('cos: could not save state: ' + e.message); }
  }
  function load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    events = []; calls = []; orders = []; mutes = []; seen = new Set(); baselined = false;
    if (!d || typeof d !== 'object') return;
    baselined = !!d.baselined;
    seen = new Set(Array.isArray(d.seen) ? d.seen : []);
    events = (Array.isArray(d.events) ? d.events : []).slice(0, MAX_EVENTS);
    calls = (Array.isArray(d.calls) ? d.calls : []).slice(0, MAX_CALLS);
    const objs = (v) => (Array.isArray(v) ? v : []).filter((x) => x && typeof x === 'object');
    orders = objs(d.orders).slice(0, MAX_ORDERS);
    mutes = objs(d.mutes).filter((m) => m.source && m.kind);
    for (const o of orders) if (o.status === 'running') { o.status = 'failed'; o.result = 'Interrupted by a restart.'; }
    for (const e of events) { seen.add(e.id); if (e.status === 'calling') e.status = 'briefed'; }
    for (const c of calls) {
      if (isActive(c)) { c.status = 'failed'; c.summary = c.summary || 'The app closed during this call.'; }
      // A call due long ago was missed while the app was closed; ringing hours late would only confuse
      if (c.status === 'scheduled' && now() - Date.parse(c.at) > 30 * 60000) { c.status = 'failed'; c.summary = 'Missed: the app was closed at the time.'; }
    }
  }

  // ---- inbound sync: someone dialling in hears the current state ----
  const waitingItems = (exclude = []) => events
    .filter((e) => (e.status === 'new' || e.status === 'briefed') && e.score.decision !== 'ignore' && recent(e) && !exclude.includes(e))
    .sort((a, b) => b.score.urgency - a.score.urgency);
  const profileText = () => { try { return clip(profile(), PROFILE_CAP); } catch { return ''; } };
  // What the scorer is told about the user: the profile, then what they said about past calls (most recent first),
  // all inside PROFILE_CAP. Feedback is kept whole and the profile gives way.
  function scorerProfile() {
    let base = ''; try { base = String(profile() || ''); } catch {}
    const lines = []; let used = 0;
    const fb = events.filter((e) => e.feedback === 'good' || e.feedback === 'bad').sort((a, b) => (b.feedbackAt || 0) - (a.feedbackAt || 0)).slice(0, 6);
    for (const e of fb) {
      const l = `The user said a call about "${clip(e.title, 100)}" was ${e.feedback === 'bad' ? 'not worth it' : 'worth it'}.`;
      if (used + l.length + 1 > FEEDBACK_CAP) break;
      lines.push(l); used += l.length + 1;
    }
    const head = clip(base, PROFILE_CAP - used);
    return [head, ...lines].filter(Boolean).join('\n');
  }
  const itemLine = (e) => `- ${clip(e.title, 140)} (${e.source}, urgency ${Math.round(e.score.urgency * 100)}%): ${clip(e.score.reason, 140)}`;

  // What someone hears when they dial in: a short rundown by area, then they pick what to hear more about.
  // Demo and test events are left out unless they are minutes old, so old test data never leads the call.
  const headline = (e) => clip(String(e.title || '').replace(/^News on "[^"]*":\s*/, ''), 110);
  function inboundAreas() {
    const live = (e) => e.source !== 'demo' || now() - Date.parse(e.ts) < 10 * 60000;
    const w = waitingItems().filter(live);
    const by = (src) => w.filter((e) => src.includes(e.source));
    return { markets: by(['quotes']), news: by(['watch']), agents: by(['agent']), github: by(['github']), cards: by(['plaid']), other: w.filter((e) => !['quotes', 'watch', 'agent', 'github', 'plaid'].includes(e.source)) };
  }
  function inboundOpening() {
    const a = inboundAreas(), parts = [];
    if (a.other.length) parts.push(`First, ${headline(a.other[0])}.`);
    parts.push(a.markets.length ? `On the markets, ${a.markets.slice(0, 2).map((e) => e.title.replace(/ \(\$[\d,.]+\)$/, '')).join(' and ')}.` : 'The markets are quiet.');
    if (a.news.length) parts.push(`Top headline: ${headline(a.news[0])}.`);
    parts.push(a.agents.length ? `${clip(a.agents[0].title, 120)}.` : 'No coding agent has reported in.');
    const built = a.github.filter((e) => e.kind === 'build_failed').length;
    parts.push(built ? `${built} failed build${built > 1 ? 's' : ''} on GitHub.` : 'Nothing is broken on GitHub.');
    parts.push("Gmail isn't connected yet. Which of these do you want more on?");
    return clip(`Hi, it's your desk. Quick rundown. ${parts.join(' ')}`, 650);
  }
  function inboundBriefing() {
    const a = inboundAreas();
    const sec = (name, list, empty) => [name + ':', ...(list.length ? list.slice(0, 4).map((e) => itemLine(e) + (e.detail && e.source === 'agent' ? ` Detail: ${clip(e.detail, 200)}` : '')) : ['- ' + empty])];
    const lastCall = calls.find((c) => c.status === 'done' && c.summary);
    const out = [
      'Brief the caller area by area, in this order. Opening line already said the rundown, so when they answer, go deeper on what they pick, or walk through the areas one at a time if they say "go on" or "everything".', '',
      ...sec('MARKETS (prices of SPY and NVDA, moves of 2% or more)', a.markets, 'No big price moves.'), '',
      ...sec('NEWS ON WATCHED TOPICS (NVIDIA, the S&P 500, Trump announcements)', a.news, 'Nothing new.'), '',
      ...sec('CODING AGENTS (Claude Code and Codex)', a.agents, 'No coding agent has reported in, so say you have not heard from them. Do not guess what they are doing.'), '',
      ...sec('GITHUB AND BUILDS', a.github, 'No failed builds or alerts.'), '',
      ...sec('CARD CHARGES (sample data, not real money)', a.cards, 'No charges.'), '',
      'GMAIL: not connected yet. Say that plainly if asked, and do not make up any email.',
    ];
    if (a.other.length) out.splice(2, 0, ...sec('NEEDS YOU FIRST', a.other, ''), '');
    if (lastCall) out.push('', 'Last call summary: ' + clip(lastCall.summary, 300));
    const p = profileText(); if (p) out.push('', 'About the user: ' + p);
    return out.join('\n');
  }
  function syncInbound() {
    if (!vapi || !vapi.syncInbound || stopped) return;
    try {
      const opening = inboundOpening();
      const text = inboundBriefing();
      const key = opening + '\n' + text;
      if (key === lastSynced) return;
      const wait = lastSyncAt + T.syncMs - now();
      if (wait > 0) { if (!syncTimer) syncTimer = setTimeout(() => { syncTimer = null; syncInbound(); }, wait); return; }
      lastSynced = key; lastSyncAt = now();
      Promise.resolve(vapi.syncInbound(text, opening)).catch(() => {});
    } catch (e) { L('cos: inbound sync failed: ' + e.message); }
  }

  // ---- push + save after every change ----
  function changed() {
    if (stopped) return;
    try { onState(snapshot()); } catch (e) { L('cos: onState failed: ' + e.message); }
    if (!saveTimer) saveTimer = setTimeout(saveNow, T.saveMs);
    syncInbound();
  }

  // ---- scoring and context ----
  const FALLBACK = { decision: 'brief', urgency: 0.3, reason: 'Not scored.', by: 'rules', ms: 0 };
  async function scoreOf(e) {
    if (!jev) return { ...FALLBACK };
    const s = await valueWithin(Promise.resolve().then(() => { return jev.score(e, scorerProfile()); }), T.scoreMs);
    if (!s || typeof s !== 'object') return { ...FALLBACK };
    return { decision: ['call', 'brief', 'ignore'].includes(s.decision) ? s.decision : 'brief', urgency: clamp01(s.urgency), reason: clip(s.reason, 200), by: s.by || 'rules', ms: Number(s.ms) || 0 };
  }
  function fetchContext(rec) {
    if (!exa) return;
    const p = Promise.resolve().then(() => exa.context(clean(rec))).then((c) => {
      rec.context = c && typeof c === 'object' && c.answer ? c : null;
      changed();
    }).catch(() => {}).finally(() => { if (ctxP.get(rec.id) === p) ctxP.delete(rec.id); });
    ctxP.set(rec.id, p);
  }
  const clean = (rec) => { const { score, context, status, feedback, feedbackAt, ...ev } = rec; return ev; }; // what the source gave us

  // ---- polling ----
  function poll() {
    if (pollP) return pollP;
    pollP = (async () => {
      const results = await Promise.all(sources.map((s) => valueWithin(Promise.resolve().then(() => s.poll()), T.sourceMs).then((r) => (Array.isArray(r) ? r : null))));
      if (stopped) return;
      const anyOk = results.some((r) => r);
      const fresh = [];
      for (const list of results) for (const e of list || []) {
        if (!e || !e.id || seen.has(e.id)) continue;
        seen.add(e.id); fresh.push(e);
      }
      // First poll of a fresh install: all of it is old news. Only mark done once something answered.
      const live = baselined;
      if (anyOk) baselined = true;
      if (fresh.length) await ingest(fresh, live);
      else if (anyOk && !live) changed();
    })().catch((e) => L('cos: poll failed: ' + e.message)).finally(() => { pollP = null; });
    return pollP;
  }

  async function ingest(batch, live) {
    const scored = await Promise.all(batch.map(async (e) => ({ e, score: await scoreOf(e) })));
    if (stopped) return;
    const recs = scored.map(({ e, score: raw }) => {
      let score = unwanted(e) ? withPenalty(raw) : raw;
      if (isMuted(e)) score = withCap(score, MUTED);          // still shown and scored, but never rings the phone
      if (e.baseline) score = withCap(score, OLD_NEWS);       // already out before watching began: shown, never rings
      const status = live && qualifies({ score }) ? 'new' : 'briefed';
      return { ...e, score, context: null, status };
    }).sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
    events.unshift(...recs);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    for (const r of recs) if (r.score.decision !== 'ignore') fetchContext(r);
    changed();
    maybeCall().catch((e) => L('cos: call check failed: ' + e.message));
  }

  // ---- placing calls ----
  const waitingLine = (r) => {
    const out = [`- ${clip(r.title, 160)}`, `  Why it matters: ${clip(r.score.reason, 200)}`];
    if (r.detail) out.push(`  Detail: ${clip(r.detail, 300)}`);
    if (r.context && r.context.answer) {
      const src = (r.context.sources || []).map((s) => s && s.title).filter(Boolean).slice(0, 2).join('; ');
      out.push(`  From the web: ${clip(r.context.answer, 400)}${src ? ` (${clip(src, 120)})` : ''}`);
    }
    return out.join('\n');
  };
  const recentOrder = (o) => now() - Date.parse(o.at) < ORDER_WINDOW;
  // One look at each recent order that has something to check (did the rerun pass?), all together and bounded
  async function refreshOrders() {
    const list = ordersMod && ordersMod.check ? orders.filter((o) => o.ref && recentOrder(o)) : [];
    if (!list.length) return;
    const got = await Promise.all(list.map((o) => valueWithin(Promise.resolve().then(() => ordersMod.check(o)), T.checkMs)));
    let any = false;
    list.forEach((o, i) => { const r = got[i]; if (r && typeof r.result === 'string' && r.result.trim() && r.result !== o.result) { o.result = clip(r.result, 300); any = true; } });
    if (any) changed();
  }
  function buildBriefing(recs, topic, daily) {
    const out = [];
    if (recs.length) out.push(recs.length > 1 ? 'These items just crossed the threshold:' : 'This just crossed the threshold:', ...recs.map(waitingLine));
    else if (topic) out.push(`The user asked to be called about: ${clip(topic, 200)}`);
    else out.push('The user asked for a summary of what is waiting.');
    if (daily && !recs.length) out.push('This is their scheduled daily briefing: go through what is waiting.');
    if (recs.length && topic) out.push('', `The user also asked about: ${clip(topic, 200)}`);
    const others = waitingItems(recs).slice(0, 5);
    if (others.length) out.push('', recs.length ? 'Also waiting, most urgent first:' : 'Waiting for the user, most urgent first:', ...others.map(itemLine));
    const mine = orders.filter(recentOrder).slice(0, 5);
    if (mine.length) out.push('', 'Orders you gave:', ...mine.map((o) => `- ${describeOrder(o.action)}: ${clip(o.result, 200) || 'not done yet'}`));
    const p = profileText(); if (p) out.push('', 'About the user: ' + p);
    return out.join('\n');
  }
  const FIRST = { build_failed: 'A build just failed', issue: 'An issue was just filed', security_alert: 'A security alert came in', charge: 'A charge you may not recognise', review_request: 'A review was requested', mention: 'You were mentioned', market_move: 'A big price move', agent_request: 'A coding agent needs you', custom: 'Something came up' };
  function buildFirstMessage(recs, topic, scheduled, daily) {
    const hi = "Hi, it's your desk.";
    if (daily) return `${hi} This is your daily briefing.`;
    if (scheduled) return `${hi} You asked me to call about ${clip(topic, 70) || 'something'}.`.replace(/about something\.$/, 'back.');
    // Say something useful straight away: the headline, why it matters and the first sentence of the detail.
    // A bare "Do you want the details?" leaves the line silent until the person answers.
    const why = (r) => { const w = clip(r.score && r.score.reason, 160); return w ? (/[.!?]$/.test(w) ? w : w + '.') : ''; };
    const lead = (r) => {
      const d = clip(r.detail, 400), i = d.search(/[.!?](\s|$)/), s = i > 0 && i < 220 ? d.slice(0, i + 1) : clip(d, 200);
      return s && s.toLowerCase() !== clip(r.title, 400).toLowerCase() ? s : '';
    };
    if (recs.length > 1) return `${hi} ${recs.length} things need you. First: ${clip(recs[0].title, 100)}. ${why(recs[0])} I'll go through the rest, or stop me any time.`;
    if (recs.length === 1) return `${hi} ${FIRST[recs[0].kind] || 'Something needs you'}: ${clip(recs[0].title, 100)}. ${why(recs[0])} ${lead(recs[0])} I can go through the rest, or call you back later. What would you like?`.replace(/\s+/g, ' ');
    const n = waitingItems().length;
    return `${hi} ${n ? `Here is a quick summary of the ${n} thing${n > 1 ? 's' : ''} waiting.` : 'Nothing urgent is waiting, but you asked for a summary.'}`;
  }

  // One call, for any reason. `rec` is the existing scheduled record when a scheduled call comes due.
  async function dial({ recs = [], topic = '', rec = null }) {
    placing = true;
    try {
      // The phone can explain the event better with its web context, but never wait long for it.
      if (recs.length) await Promise.all(recs.map((r) => (ctxP.has(r.id) ? waitUpTo(ctxP.get(r.id), T.ctxWaitMs) : null)));
      await refreshOrders();
      if (stopped) return { ok: false, error: 'stopped' };
      if (rec && rec.status !== 'scheduled') return { ok: false, error: 'cancelled' };
      const scheduled = !!rec;
      const t = scheduled ? (rec.topic || '') : topic;
      const reason = recs.length ? clip(`${recs[0].title}: ${recs[0].score.reason}${recs.length > 1 ? ` (+${recs.length - 1} more)` : ''}`, 240) : clip(scheduled ? `Scheduled call: ${t}` : (t ? `Call about: ${t}` : 'Summary of what is waiting'), 240);
      const daily = !!(rec && rec.daily);
      let briefing = buildBriefing(recs, t, daily);
      // The orders demo: with no phone service the simulated call comes back with an order
      if (!cfg().vapiKey && recs.some((r) => String(r.id).startsWith('demo:order:'))) briefing += '\n[mock:order]';
      const payload = { reason, briefing, firstMessage: buildFirstMessage(recs, t, scheduled, daily) };
      let res;
      try { res = await vapi.call(payload); } catch (e) { res = { ok: false, error: e.message }; }
      res = res || { ok: false, error: 'no answer from the phone service' };
      const c = rec || { id: newId('call'), at: iso(now()), topic: recs.length ? clip(recs[0].title, 120) : (t || 'Summary of what is waiting'), status: 'ringing', eventIds: recs.map((r) => r.id), summary: '', mock: false };
      if (!rec) calls.unshift(c);
      if (res.ok) {
        Object.assign(c, { status: 'ringing', at: iso(now()), placedAt: now(), vapiId: res.callId, mock: !!res.mock, webReason: res.web ? reason : undefined });
        for (const r of recs) r.status = 'calling';
        try { notify('Your chief of staff is calling',clip(reason, 120)); } catch {}
      } else {
        c.status = 'failed'; c.summary = 'Could not place the call: ' + clip(res.error || 'unknown error', 160);
        for (const r of recs) r.status = 'briefed'; // do not retry a failing line every few seconds
      }
      ensureDaily(); trimCalls(); changed();
      return res.ok ? { ok: true, id: c.id } : { ok: false, error: res.error || 'call failed' };
    } finally { placing = false; }
  }
  function trimCalls() {
    while (calls.length > MAX_CALLS) {
      let i = -1;
      for (let k = calls.length - 1; k >= 0; k--) if (!isActive(calls[k]) && calls[k].status !== 'scheduled') { i = k; break; }
      if (i < 0) break;
      calls.splice(i, 1);
    }
  }

  // Place the call for anything urgent that is waiting: one shared call, only when the line is free.
  async function maybeCall() {
    if (stopped || placing) return;
    let pending = events.filter((e) => e.status === 'new');
    // Anything that no longer qualifies (threshold raised, or calling not possible) just waits for a briefing
    for (const e of pending) if (!qualifies(e) || !canCall()) { e.status = 'briefed'; }
    const q = pending.filter((e) => e.status === 'new').sort((a, b) => b.score.urgency - a.score.urgency);
    if (q.length !== pending.length) changed();
    if (!q.length || activeCall() || !capOk()) return;
    await dial({ recs: q });
  }

  // ---- watching calls ----
  const BAD_END = /did-not-answer|no-answer|busy|failed|error|rejected|unreachable|invalid/i;
  async function pollCalls() {
    if (stopped || callsBusy) return;
    callsBusy = true;
    try {
      for (const c of calls.filter((x) => isActive(x) && x.vapiId)) {
        if (now() - (c.placedAt || 0) > T.giveUpMs) { endCall(c, { status: 'failed', summary: 'Gave up waiting for this call to finish.' }); continue; }
        let r = null;
        try { r = await vapi.result(c.vapiId); } catch {}
        if (stopped) return;
        if (!r || typeof r !== 'object') continue;
        if (r.status === 'ended' || r.status === 'failed') endCall(c, r);
        else {
          const s = r.status === 'in-progress' ? 'in-progress' : 'ringing';
          if (c.status !== s) { c.status = s; changed(); }
        }
      }
    } finally { callsBusy = false; }
    maybeCall().catch(() => {});
  }
  function endCall(c, r) {
    const o = r.outcome && typeof r.outcome === 'object' ? r.outcome : null;
    const failed = r.status === 'failed' || (BAD_END.test(String(r.endedReason || '')) && !(o && o.acknowledged) && !r.summary);
    c.status = failed ? 'failed' : 'done';
    c.summary = clip(r.summary || (failed ? `The call did not connect${r.endedReason ? ` (${r.endedReason})` : ''}.` : ''), 1500);
    // Answered events are done; if nobody picked up they are still waiting for the next conversation
    for (const id of c.eventIds || []) { const e = events.find((x) => x.id === id); if (e && e.status === 'calling') e.status = failed ? 'briefed' : 'called'; }
    if (o) applyOutcome(o, c);
    changed();
  }
  function applyOutcome(o, c) {
    if (o.callbackAt) {
      let t = Date.parse(o.callbackAt);
      if (!Number.isFinite(t) || t < now()) t = now() + 2 * 60000; // "call me back" with no usable time
      addScheduled(t, o.callbackTopic || 'the earlier call');
    }
    if (o.noteToSelf) {
      // The note lands on a board that is committed to a public repo, so never let a card number through
      const body = String(o.noteToSelf).replace(/\b(?:\d[ -]?){13,19}\b/g, '[number removed]');
      try { addNote({ title: 'From your call', body, color: 'purple', category: 'calls' }); } catch (e) { L('cos: could not add note: ' + e.message); }
    }
    try { takeOrders(o, c); } catch (e) { L('cos: could not handle orders: ' + e.message); }
  }

  // ---- orders ----
  function addOrder({ action, eventId = null, text = '', callId = null }) {
    const e = eventId ? events.find((x) => x.id === eventId) : null;
    const o = { id: newId('order'), at: iso(now()), action, eventId: e ? e.id : null, title: e ? clip(e.title, 160) : '', text: clip(text, 500), status: 'waiting', result: '', simulated: false, callId };
    orders.unshift(o);
    if (orders.length > MAX_ORDERS) orders.length = MAX_ORDERS;
    return o;
  }
  // What the call produced: the target is the first event it was about
  function takeOrders(o, c) {
    if (!Array.isArray(o.orders)) return;
    const mode = ordersMode();
    for (const g of o.orders.slice(0, 3)) {
      if (!g || !ORDER_ACTIONS.includes(g.action)) continue;
      const order = addOrder({ action: g.action, eventId: (c.eventIds || [])[0], text: g.text, callId: c.id });
      if (mode === 'off') { order.status = 'skipped'; order.result = 'Orders are turned off, so I did nothing.'; }
      else if (mode === 'auto' && g.confirmed === true) runOrder(order).catch((e) => L('cos: order failed: ' + e.message));
    }
  }
  function kindWords(e) {
    const k = String(e.kind).replace(/_failed$/, ' failure').replace(/_/g, ' ');
    return `${e.source} ${/s$/.test(k) ? k : k + 's'}`;
  }
  // Muting is ours, not orders.js's: later events of the kind are capped at brief, and so are waiting ones
  function addMute(e) {
    if (!e || !e.source || !e.kind) return { ok: false, result: "There's no event to mute, so I didn't change anything." };
    const label = kindWords(e);
    if (!isMuted(e)) {
      mutes.unshift({ id: newId('mute'), source: e.source, kind: e.kind, label, at: iso(now()) });
      for (const r of events) {
        if (r.source !== e.source || r.kind !== e.kind || r.score.decision !== 'call' || (r.status !== 'new' && r.status !== 'briefed')) continue;
        r.score = withCap(r.score, MUTED);
        if (r.status === 'new') r.status = 'briefed';
      }
    }
    return { ok: true, simulated: false, ref: null, result: `I won't call about ${label} again. They'll still show on the board.` };
  }
  async function runOrder(order) {
    order.status = 'running'; order.result = ''; changed();
    const e = order.eventId ? events.find((x) => x.id === order.eventId) || null : null;
    let r;
    try {
      if (order.action === 'mute_similar') r = addMute(e);
      else if (!ordersMod) r = { ok: false, result: "I can't carry out orders right now." };
      else r = await valueWithin(ordersMod.run({ action: order.action, text: order.text }, e ? clean(e) : null), T.orderMs);
    } catch (err) { r = null; L('cos: order run failed: ' + err.message); }
    if (!r || typeof r !== 'object') r = { ok: false, result: "I couldn't carry that out." };
    order.status = r.ok ? 'done' : 'failed';
    order.result = clip(r.result, 300) || (r.ok ? 'Done.' : "I couldn't carry that out.");
    order.simulated = !!r.simulated;
    order.ref = r.ref || null;
    changed();
    try { notify(`Your order: ${describeOrder(order.action)}`, clip(order.result, 200)); } catch {}
  }
  function addScheduled(t, topic) {
    const c = { id: newId('call'), at: iso(t), topic: clip(topic, 160), status: 'scheduled', eventIds: [], summary: '', mock: false };
    calls.unshift(c); trimCalls();
    return c;
  }

  // The daily briefing: while it is set there is exactly one pending call with daily: true, at the next HH:MM.
  // `after` (a time) keeps a cancelled call's own slot from being scheduled again. Returns true if it changed anything.
  function ensureDaily(after = 0) {
    const val = dailyTime();
    const pending = calls.filter((c) => c.daily && c.status === 'scheduled');
    const hhmm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    if (!val) { if (!pending.length) return false; calls = calls.filter((c) => !pending.includes(c)); return true; }
    if (pending.length === 1 && hhmm(Date.parse(pending[0].at)) === val) return false;
    calls = calls.filter((c) => !pending.includes(c));
    const base = Math.max(now(), after);
    const d = new Date(base); d.setHours(+val.slice(0, 2), +val.slice(3), 0, 0);
    if (d.getTime() <= base) d.setDate(d.getDate() + 1);
    addScheduled(d.getTime(), DAILY_TOPIC).daily = true;
    return true;
  }

  // ---- scheduled calls ----
  async function dueTick() {
    if (stopped || placing) return;
    if (ensureDaily()) changed();
    if (!activeCall() && capOk()) {
      const due = calls.filter((c) => c.status === 'scheduled' && Date.parse(c.at) <= now()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
      if (due) {
        if (!canCall()) { due.status = 'failed'; due.summary = vapi ? 'No phone number set.' : 'Calling is turned off.'; ensureDaily(); changed(); }
        else { await dial({ rec: due }); return; }
      }
    }
    await maybeCall(); // also retries anything held back by the hourly cap
  }

  // ---- actions ----
  const DEMO_SEQ = { n: 0 };
  async function action(a) {
    try {
      if (!a || typeof a !== 'object') return { ok: false, error: 'no action given' };
      switch (a.type) {
        case 'refresh': await poll(); return { ok: true };
        case 'call_now': {
          if (!canCall()) return { ok: false, error: vapi ? 'no phone number set' : 'calling is off' };
          if (placing || activeCall()) return { ok: false, error: 'a call is already in progress' };
          if (!capOk()) return { ok: false, error: 'hourly call limit reached' };
          let recs = [];
          if (a.eventId) {
            const r = events.find((e) => e.id === a.eventId);
            if (!r) return { ok: false, error: 'event not found' };
            recs = [r];
          }
          return await dial({ recs, topic: clip(a.topic, 200) });
        }
        case 'dismiss': {
          const r = events.find((e) => e.id === a.eventId);
          if (!r) return { ok: false, error: 'event not found' };
          r.status = 'dismissed'; changed(); return { ok: true };
        }
        case 'schedule': {
          let t = NaN;
          if (a.at) t = Date.parse(a.at);
          else if (Number(a.inMinutes) >= 0 && a.inMinutes !== '' && a.inMinutes != null) t = now() + Number(a.inMinutes) * 60000;
          if (!Number.isFinite(t)) return { ok: false, error: 'give a time (at) or a number of minutes (inMinutes)' };
          if (t < now() - 60000) return { ok: false, error: 'that time has already passed' };
          const c = addScheduled(t, a.topic || 'a check-in'); changed();
          return { ok: true, id: c.id, at: c.at };
        }
        case 'cancel_call': {
          const c = calls.find((x) => x.id === a.id);
          if (!c) return { ok: false, error: 'call not found' };
          if (c.status !== 'scheduled') return { ok: false, error: 'only a scheduled call can be cancelled' };
          c.status = 'cancelled';
          if (c.daily) ensureDaily(Date.parse(c.at)); // the next one, not the same slot again
          changed(); return { ok: true };
        }
        case 'set_threshold': {
          const v = Number(a.value);
          if (!Number.isFinite(v)) return { ok: false, error: 'value must be a number between 0 and 1' };
          if (cfg.save) cfg.save({ threshold: clamp01(v) });
          changed(); return { ok: true, threshold: clamp01(v) };
        }
        case 'order': {
          if (!ORDER_ACTIONS.includes(a.action)) return { ok: false, error: 'unknown order ' + a.action };
          if (a.eventId && !events.some((e) => e.id === a.eventId)) return { ok: false, error: 'event not found' };
          const o = addOrder({ action: a.action, eventId: a.eventId, text: a.text });
          if (ordersMode() === 'off') changed(); // recorded, and waits for the run button
          else runOrder(o).catch((e) => L('cos: order failed: ' + e.message));
          return { ok: true, id: o.id };
        }
        case 'run_order': case 'skip_order': {
          const o = orders.find((x) => x.id === a.id);
          if (!o) return { ok: false, error: 'order not found' };
          if (o.status !== 'waiting') return { ok: false, error: 'only a waiting order can be ' + (a.type === 'run_order' ? 'run' : 'skipped') };
          if (a.type === 'run_order') runOrder(o).catch((e) => L('cos: order failed: ' + e.message));
          else { o.status = 'skipped'; o.result = 'You skipped it.'; changed(); }
          return { ok: true };
        }
        case 'unmute': {
          const i = mutes.findIndex((m) => m.id === a.id);
          if (i < 0) return { ok: false, error: 'mute not found' };
          mutes.splice(i, 1); changed(); return { ok: true };
        }
        case 'set_orders_mode': {
          if (!ORDER_MODES.includes(a.value)) return { ok: false, error: "value must be 'auto', 'ask' or 'off'" };
          if (cfg.save) cfg.save({ ordersMode: a.value });
          changed(); return { ok: true, ordersMode: a.value };
        }
        case 'web_offer': {
          const c = ringingWeb(a.id);
          if (!c) return { ok: false, error: 'that call is not ringing in the browser' };
          const o = vapi && vapi.offer ? vapi.offer(c.vapiId) : null;
          if (!o || !o.assistant) return { ok: false, error: 'the call is no longer waiting to be answered' };
          return { ok: true, assistant: o.assistant };
        }
        case 'web_started': {
          const c = ringingWeb(a.id);
          if (!c) return { ok: false, error: 'that call is not ringing in the browser' };
          if (!vapi.attach(c.vapiId, a.vapiCallId)) return { ok: false, error: 'the call could not be linked: that call id does not look right' };
          c.webStep = 'answered'; changed(); return { ok: true };
        }
        case 'web_declined': {
          const c = ringingWeb(a.id);
          if (!c) return { ok: false, error: 'that call is not ringing in the browser' };
          if (vapi.decline) vapi.decline(c.vapiId);
          c.webStep = 'declined'; changed(); return { ok: true };
        }
        case 'set_call_mode': {
          if (!CALL_MODES.includes(a.value)) return { ok: false, error: "value must be 'phone' or 'browser'" };
          if (cfg.save) cfg.save({ callMode: a.value });
          changed(); return { ok: true, callMode: a.value };
        }
        case 'custom': {
          const text = String(a.text == null ? '' : a.text).trim();
          if (text.length < 3 || text.length > 300) return { ok: false, error: 'describe the event in 3 to 300 characters' };
          let id;
          do { id = 'custom:' + newId('c'); } while (seen.has(id));
          seen.add(id);
          // typed by hand, so it is never old news: it takes the normal path, as a live event
          await ingest([{ id, source: 'custom', kind: 'custom', title: clip(text, 140), detail: text, ts: iso(now()), sample: true }], true);
          return { ok: true, id };
        }
        case 'agent': {
          // A coding agent (Claude Code, Codex) reporting in: it is blocked, needs a decision, hit an error or finished.
          // It is a live event like any other, so Jev decides whether it is worth a call or can wait for a briefing.
          const who = { claude: 'Claude Code', codex: 'Codex' }[String(a.agent || '').toLowerCase()] || 'A coding agent';
          const needs = ['input', 'permission', 'error', 'done'].includes(a.needs) ? a.needs : 'input';
          const text = clip(String(a.text == null ? '' : a.text).replace(/\s+/g, ' ').trim(), 300);
          if (text.length < 3) return { ok: false, error: 'say what the agent needs, in at least 3 characters' };
          const project = clip(String(a.project == null ? '' : a.project).replace(/\s+/g, ' ').trim(), 60);
          const verb = { input: 'needs your input', permission: 'needs your permission', error: 'hit an error', done: 'finished' }[needs];
          let id;
          do { id = 'agent:' + newId('a'); } while (seen.has(id));
          seen.add(id);
          await ingest([{ id, source: 'agent', kind: 'agent_request', needs, title: clip(`${who}${project ? ' in ' + project : ''} ${verb}: ${text}`, 140), detail: text, ts: iso(now()) }], true);
          return { ok: true, id };
        }
        case 'add_watch': {
          const topic = String(a.topic == null ? '' : a.topic).replace(/\s+/g, ' ').trim();
          if (topic.length < 3 || topic.length > 120) return { ok: false, error: 'a topic needs 3 to 120 characters' };
          const list = watchList();
          if (list.some((t) => t.trim().toLowerCase() === topic.toLowerCase())) return { ok: false, error: 'you are already watching that' };
          if (list.length >= MAX_WATCHES) return { ok: false, error: `you can watch at most ${MAX_WATCHES} topics` };
          if (cfg.save) cfg.save({ watches: [...list, topic] });
          changed();
          if (!stopped) poll().catch(() => {}); // look right away, without waiting for the answer
          return { ok: true, topic };
        }
        case 'remove_watch': {
          const topic = String(a.topic == null ? '' : a.topic).replace(/\s+/g, ' ').trim().toLowerCase();
          const list = watchList();
          if (!list.some((t) => t.trim().toLowerCase() === topic)) return { ok: false, error: 'you are not watching that' };
          if (cfg.save) cfg.save({ watches: list.filter((t) => t.trim().toLowerCase() !== topic) });
          changed(); return { ok: true };
        }
        case 'feedback': {
          const r = events.find((e) => e.id === a.eventId);
          if (!r) return { ok: false, error: 'event not found' };
          if (a.value !== 'good' && a.value !== 'bad' && a.value !== null) return { ok: false, error: "value must be 'good', 'bad' or null" };
          if (a.value) { r.feedback = a.value; r.feedbackAt = now(); } else { delete r.feedback; delete r.feedbackAt; }
          changed(); return { ok: true };
        }
        case 'set_daily': {
          const v = a.value == null ? '' : String(a.value).trim();
          const m = /^(\d{1,2}):(\d{2})$/.exec(v);
          if (v && !(m && +m[1] < 24 && +m[2] < 60)) return { ok: false, error: "give a time like 09:00, or leave it empty to turn the briefing off" };
          const val = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
          if (cfg.save) cfg.save({ dailyBriefing: val });
          ensureDaily(); changed(); return { ok: true, dailyBriefing: val };
        }
        case 'demo': {
          const make1 = DEMOS[a.scenario];
          if (!make1) return { ok: false, error: 'unknown scenario' };
          const ev = { id: `demo:${a.scenario}:${now().toString(36)}-${DEMO_SEQ.n++}`, source: 'demo', ...make1(), ts: iso(now()), sample: true };
          seen.add(ev.id);
          await ingest([ev], true); // a made-up event takes the normal path, as a live one
          return { ok: true, id: ev.id };
        }
        default: return { ok: false, error: 'unknown action ' + a.type };
      }
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // ---- lifecycle ----
  function start() {
    if (!stopped) return;
    stopped = false;
    load();
    try { ensureDaily(); } catch (e) { L('cos: daily briefing: ' + e.message); }
    const loop = (delay) => {
      pollTimer = setTimeout(async () => {
        await poll();
        if (!stopped) loop(Math.max(0.05, Number(cfg().pollSeconds) || 30) * 1000);
      }, delay);
    };
    loop(T.firstPollMs);
    callTimer = setInterval(() => pollCalls().catch(() => {}), T.callPollMs);
    dueTimer = setInterval(() => dueTick().catch(() => {}), T.dueMs);
    changed();
  }
  function stop() {
    if (stopped) return;
    saveNow();
    stopped = true;
    for (const t of [pollTimer, saveTimer, syncTimer]) clearTimeout(t);
    clearInterval(callTimer); clearInterval(dueTimer);
    pollTimer = callTimer = dueTimer = saveTimer = syncTimer = null;
  }

  return { start, stop, state: snapshot, action };
};
