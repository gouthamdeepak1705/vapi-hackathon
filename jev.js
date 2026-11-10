// Urgency judge. Jev (TypeSafe "System One") is a classifier: it cannot write text, it answers typed
// questions with probabilities. One request per event asks a route, a severity and a few yes/no
// questions; the yes/no answers are what the spoken reason is built from.
// Any problem (no key, timeout, bad answer) falls back to keyword rules, so scoring never fails.
const TIMEOUT_MS = 2500;
const STATE_MAX = 4000;
const DIRECT = 'https://api.typesafe.ai/v1';
const ROUTES = {
  call_now: 'Someone should be phoned right now, because waiting an hour could cost money, expose a secret, or block other people.',
  next_briefing: 'Worth knowing about, but fine to mention in the next scheduled summary.',
  ignore: 'Routine or trivial; the person does not need to hear about it.',
};
const DECISION = { call_now: 'call', next_briefing: 'brief', ignore: 'ignore' };
const SEVERITY = [
  'Trivial: cosmetic, routine or informational, nobody is affected.',
  'Minor: ordinary work item that can wait a day or more.',
  'Serious: needs the person to act soon, within the working day.',
  'Critical: needs action within the hour; money, security or other people are at stake.',
];
// Yes/no questions. `phrase` is what ends up in the spoken reason when Jev says yes.
const YESNO = {
  money: { q: 'Could money be lost if nobody acts within the hour?', phrase: 'money at risk' },
  secret: { q: 'Might a secret, password, API key or other credential be exposed?', phrase: 'likely exposed credential' },
  blocked: { q: 'Are other people blocked until the user acts?', phrase: 'others are blocked' },
  fraud: { q: 'Does this look like fraud or a charge the user would not recognise?', phrase: 'possible fraud' },
  routine: { q: 'Is this routine and able to wait until tomorrow?', phrase: null },
};

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const clamp01 = (n) => Math.max(0, Math.min(1, n));

function ageOf(ts) {
  const t = Date.parse(ts);
  if (!t) return 'unknown';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 90 ? `${m} minutes ago` : `${Math.round(m / 60)} hours ago`;
}

function buildState(event, profile) {
  const lines = [
    `Source: ${event.source || 'unknown'}`,
    `Kind: ${event.kind || 'unknown'}`,
    `Title: ${event.title || ''}`,
    `Detail: ${String(event.detail || '').slice(0, 600)}`,
  ];
  if (typeof event.amount === 'number') lines.push(`Amount: ${event.amount}`);
  lines.push(`Happened: ${ageOf(event.ts)}`);
  let s = lines.join('\n');
  if (profile && String(profile).trim()) s += '\n\nAbout the user:\n' + String(profile).trim();
  return s.slice(0, STATE_MAX);
}

function buildQuestions() {
  // Option order bias has been reported, so the options are shuffled on every request.
  const criteria = {};
  for (const k of shuffle(Object.keys(ROUTES))) criteria[k] = ROUTES[k];
  const questions = {
    route: { type: 'choice', instructions: 'Decide how urgently the person who owns this should be told about the event described in the state.', criteria },
    severity: { type: 'score', instructions: 'How severe is this event for the person who owns it?', criteria: SEVERITY },
  };
  for (const [id, y] of Object.entries(YESNO)) questions[id] = { type: 'noul', instructions: y.q };
  return questions;
}

// Urgency = mean of normalised severity (score / (levels - 1)) and P(call_now). Severity says how bad
// the thing is, the route says whether Jev thinks it needs a call; averaging stops either alone from
// pushing an event over the threshold. If only one of them came back, that one is used.
function toScore(answers) {
  const route = answers && answers.route;
  const sev = answers && answers.severity;
  const probs = route && route.probabilities;
  let choice = route && route.choice;
  if (!DECISION[choice] && probs) choice = Object.keys(probs).filter((k) => DECISION[k]).sort((a, b) => probs[b] - probs[a])[0];
  if (!DECISION[choice]) throw new Error('no route in answer');
  const parts = [];
  if (sev && Number.isFinite(sev.score)) parts.push(clamp01(sev.score / (SEVERITY.length - 1)));
  if (probs && Number.isFinite(probs.call_now)) parts.push(clamp01(probs.call_now));
  if (!parts.length) throw new Error('no numbers in answer');
  const urgency = parts.reduce((a, b) => a + b, 0) / parts.length;
  const decision = DECISION[choice];

  const yes = Object.keys(YESNO).filter((k) => YESNO[k].phrase && answers[k] && answers[k].noul >= 0.6)
    .sort((a, b) => answers[b].noul - answers[a].noul).slice(0, 2).map((k) => YESNO[k].phrase);
  const tail = decision === 'call' ? 'needs action within the hour' : decision === 'brief' ? 'worth a look in the next briefing' : 'can wait';
  let reason;
  if (yes.length && decision !== 'ignore') {
    const lead = yes.join(' and ');
    reason = lead[0].toUpperCase() + lead.slice(1) + '; ' + tail + '.';
  } else if (decision === 'ignore') reason = 'Looks routine; can wait.';
  else reason = decision === 'call' ? 'Looks urgent; needs action within the hour.' : 'Not urgent; worth a look in the next briefing.';
  return { decision, urgency, reason };
}

const HOT = /\b(leak(ed|s)?|secrets?|api[ -]?keys?|credentials?|breach(ed)?|production (is )?down|prod(uction)? outage|outage|fraud(ulent)?|unauthori[sz]ed|exposed|private key|password)\b/i;
const TRIVIAL = /\b(typos?|spelling|grammar|readme|docs?|documentation|comment|whitespace|dependabot|bump(s|ed)?|minor|patch|lint)\b/i;
const MAIN_BRANCH = /\b(main|master|production|prod|release)\b/i;
const UNKNOWN_MERCHANT = /\b(unknown|unrecogni[sz]ed|unfamiliar|unidentified|foreign|suspicious)\b/i;

// Fallback and mock-mode scorer. Keywords and event kind only; no network.
function rules(event) {
  const t0 = Date.now();
  event = event || {};
  const text = `${event.title || ''} ${event.detail || ''}`;
  const amount = typeof event.amount === 'number' ? Math.abs(event.amount) : null;
  const make = (decision, urgency, reason) => ({ decision, urgency, reason, by: 'rules', ms: Date.now() - t0 });

  if (event.kind === 'security_alert') {
    const high = /\b(critical|high)\b/i.test(text) || HOT.test(text);
    return make('call', high ? 0.95 : 0.85, high ? 'High-severity security alert; needs action within the hour.' : 'Security alert on a watched repo; needs a look within the hour.');
  }
  if (HOT.test(text) && !(event.kind === 'charge' && amount !== null && amount < 30 && !UNKNOWN_MERCHANT.test(text) && !/fraud/i.test(text))) {
    if (/\b(secrets?|api[ -]?keys?|credentials?|private key|password|leak(ed|s)?|exposed)\b/i.test(text)) return make('call', 0.93, 'Likely exposed credential; needs action within the hour.');
    if (/fraud|unauthori[sz]ed/i.test(text)) return make('call', 0.9, 'Possible fraud; needs action within the hour.');
    return make('call', 0.9, 'Looks like a breach or outage; needs action within the hour.');
  }
  if (event.kind === 'charge') {
    if (amount !== null && amount >= 500) return make('call', 0.9, 'Large charge of about $' + Math.round(amount).toLocaleString('en-US') + '; worth confirming right away.');
    if (UNKNOWN_MERCHANT.test(text)) return make('call', 0.85, 'Charge from a merchant you may not recognise; worth confirming right away.');
    if (amount !== null && amount < 30) return make('ignore', 0.1, 'Small routine charge; can wait.');
    return make('brief', 0.4, 'Mid-size charge; worth a look in the next briefing.');
  }
  if (event.kind === 'build_failed') {
    if (MAIN_BRANCH.test(text)) return make('call', 0.8, 'The build on the main branch is failing; others are likely blocked.');
    return make('brief', 0.5, 'A build failed on a side branch; worth a look in the next briefing.');
  }
  if (event.kind === 'agent_request') {
    if (event.needs === 'done') return make('brief', 0.3, 'A coding agent finished; worth a look in the next briefing.');
    return make('call', 0.75, 'A coding agent is blocked and waiting on you.');
  }
  if (event.kind === 'market_move') {
    const pct = Number((/(\d+(?:\.\d+)?)%/.exec(text) || [])[1]);
    if (pct >= 5) return make('call', 0.8, 'A big price move of about ' + pct + '%; worth knowing right away.');
    return make('brief', 0.5, 'A notable price move; worth a look in the next briefing.');
  }
  if (TRIVIAL.test(text)) return make('ignore', 0.1, 'Looks like a typo, docs or routine dependency change; can wait.');
  if (event.kind === 'review_request') return make('brief', 0.45, 'Someone asked for your review; worth a look in the next briefing.');
  if (event.kind === 'mention') return make('brief', 0.4, 'You were mentioned; worth a look in the next briefing.');
  if (event.kind === 'issue') return make('brief', 0.4, 'New issue opened; worth a look in the next briefing.');
  return make('brief', 0.35, 'Nothing here looks urgent; worth a look in the next briefing.');
}

module.exports = ({ cfg, log }) => {
  let lastFail = null;
  const say = (...a) => { try { (log || (() => {}))(...a); } catch {} };

  async function ask(event, profile, key, c) {
    const base = String(c.jevBase || DIRECT).replace(/\/+$/, '');
    const model = c.jevModel || (/openrouter/i.test(base) ? 'typesafe/jev-1.14' : 'jev-latest');
    const ctl = new AbortController();
    let timer;
    // Race as well as abort, so a fetch that ignores the signal still cannot hold us past the limit.
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error('timeout')); }, TIMEOUT_MS); });
    const run = (async () => {
      const res = await fetch(base + '/systemone', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state: buildState(event, profile), questions: buildQuestions() }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error('http ' + res.status);
      const body = await res.json();
      return toScore(body && body.answers);
    })();
    run.catch(() => {}); // the loser of the race must not become an unhandled rejection
    try { return await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
  }

  async function score(event, profile) {
    const t0 = Date.now();
    try {
      const c = cfg();
      const key = c.jevKey;
      if (!key) return rules(event);
      const s = await ask(event, profile, key, c);
      lastFail = null;
      return { ...s, by: 'jev', ms: Date.now() - t0 };
    } catch (e) {
      lastFail = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 60);
      say('jev failed, using rules: ' + lastFail);
      try { return { ...rules(event), ms: Date.now() - t0 }; } catch { return { decision: 'brief', urgency: 0.35, reason: 'Could not judge this event; worth a look in the next briefing.', by: 'rules', ms: Date.now() - t0 }; }
    }
  }

  function health() {
    let key = '';
    try { key = cfg().jevKey; } catch {}
    if (!key) return 'off';
    return lastFail ? 'error: ' + lastFail : 'ok';
  }

  return { score, health };
};
module.exports.rules = rules;
