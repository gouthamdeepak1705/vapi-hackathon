// Evaluation of the urgency scorer against 40 hand-labelled events (eval-set.json).
// Answers the question a phone owner asks: how often does it ring when it should not, and what does it miss?
// Usage: node eval.js [--rules] [--threshold 0.8] [--sweep] [--json]
const fs = require('fs');
const path = require('path');
const cfg = require('./keys');
const makeJev = require('./jev');

const LABELS = ['call', 'brief', 'ignore'];
const CONCURRENCY = 4;

function loadSet() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval-set.json'), 'utf8'));
  if (!Array.isArray(raw) || !raw.length) throw new Error('eval-set.json must be a non-empty array');
  const now = Date.now();
  return raw.map((c, i) => {
    if (!c || !c.event || !LABELS.includes(c.expect)) throw new Error('eval-set.json case ' + i + ' needs event and expect call|brief|ignore');
    const { minutesAgo, ...event } = c.event;
    event.id = event.id || 'eval:' + String(i + 1).padStart(2, '0');
    event.ts = new Date(now - (Number(minutesAgo) || 0) * 60000).toISOString();
    event.sample = true;
    return { event, expect: c.expect, why: c.why || '', hard: !!c.hard };
  });
}

// Same rule the app uses: it rings when the decision is call and urgency reaches the threshold.
const rang = (s, threshold) => s.decision === 'call' && s.urgency >= threshold;

function rates(rows, threshold) {
  const calls = rows.filter((r) => r.expect === 'call');
  const others = rows.filter((r) => r.expect !== 'call');
  const fa = others.filter((r) => rang(r.got, threshold)).length;
  const miss = calls.filter((r) => !rang(r.got, threshold)).length;
  return {
    falseAlarms: { count: fa, of: others.length, rate: others.length ? fa / others.length : 0 },
    misses: { count: miss, of: calls.length, rate: calls.length ? miss / calls.length : 0 },
  };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

async function run(options = {}) {
  const set = loadSet();
  const base = cfg();
  const keySet = !!base.jevKey;
  const forced = !!options.rules;
  const th = Number.isFinite(Number(options.threshold)) && options.threshold !== undefined && options.threshold !== null
    ? Number(options.threshold) : Number(base.threshold);
  const useCfg = () => (forced ? { ...cfg(), jevKey: '' } : cfg());
  const jev = makeJev({ cfg: useCfg, log: () => {} });
  const profile = String(base.profile || '');

  // Rules are instant and local; Jev goes out over the network, four at a time.
  const answers = await pool(set, forced || !keySet ? set.length : CONCURRENCY, async (c) => {
    try { return await jev.score(c.event, profile); }
    catch { return { decision: 'brief', urgency: 0.35, reason: 'scorer threw', by: 'rules', ms: 0 }; }
  });
  const rows = set.map((c, i) => ({ ...c, got: answers[i] }));

  const byCount = { jev: 0, rules: 0 };
  rows.forEach((r) => { byCount[r.got.by === 'jev' ? 'jev' : 'rules']++; });
  let scorer;
  if (forced) scorer = 'rules (forced with --rules)';
  else if (!keySet) scorer = 'rules (no Jev key)';
  else if (byCount.jev === 0) scorer = 'rules (Jev key set but every request fell back)';
  else scorer = byCount.rules ? 'jev (' + byCount.rules + ' answers fell back to rules)' : 'jev';

  const correct = rows.filter((r) => r.got.decision === r.expect).length;
  const confusion = {};
  LABELS.forEach((e) => { confusion[e] = {}; LABELS.forEach((g) => { confusion[e][g] = 0; }); });
  rows.forEach((r) => { if (confusion[r.expect][r.got.decision] !== undefined) confusion[r.expect][r.got.decision]++; });

  const wrong = rows.filter((r) => r.got.decision !== r.expect).map((r) => ({
    title: r.event.title, expected: r.expect, got: r.got.decision, urgency: r.got.urgency, reason: r.got.reason, hard: r.hard,
  }));
  // A rung phone on a non-call case, or a quiet phone on a call case, can happen even when the decision label matches
  // (call below the threshold), so list those too.
  const phoneWrong = rows.filter((r) => (r.expect === 'call') !== rang(r.got, th)).map((r) => ({
    title: r.event.title, expected: r.expect, got: r.got.decision, urgency: r.got.urgency, rang: rang(r.got, th),
  }));

  const ms = rows.map((r) => Number(r.got.ms) || 0).sort((a, b) => a - b);
  const mid = Math.floor(ms.length / 2);
  const medianMs = ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2);

  const hardRows = rows.filter((r) => r.hard);
  const summary = {
    scorer, answeredBy: byCount, cases: rows.length, threshold: th,
    accuracy: correct / rows.length, correct,
    ...rates(rows, th),
    phoneErrors: phoneWrong,
    hard: { cases: hardRows.length, correct: hardRows.filter((r) => r.got.decision === r.expect).length },
    confusion, wrong, medianMs, worstMs: ms[ms.length - 1],
  };
  if (options.sweep) {
    summary.sweep = [];
    for (let i = 0; i <= 9; i++) {
      const t = Math.round((0.5 + i * 0.05) * 100) / 100;
      summary.sweep.push({ threshold: t, ...rates(rows, t) });
    }
  }
  return summary;
}

const pct = (x) => (x * 100).toFixed(1) + '%';

function print(s) {
  const out = [];
  out.push('Scorer:        ' + s.scorer);
  out.push('Answered by:   jev ' + s.answeredBy.jev + ', rules ' + s.answeredBy.rules);
  out.push('Cases:         ' + s.cases + ' (' + s.hard.cases + ' deliberately hard, ' + s.hard.correct + ' of them right)');
  out.push('Accuracy:      ' + s.correct + '/' + s.cases + ' = ' + pct(s.accuracy) + ' on call / brief / ignore');
  out.push('');
  out.push('At threshold ' + s.threshold + ' (rings when decision is call and urgency >= threshold):');
  out.push('  False alarms: ' + s.falseAlarms.count + ' of ' + s.falseAlarms.of + ' non-call cases = ' + pct(s.falseAlarms.rate) + '  (rang, should not have)');
  out.push('  Misses:       ' + s.misses.count + ' of ' + s.misses.of + ' call cases = ' + pct(s.misses.rate) + '  (should have rung, did not)');
  out.push('');
  out.push('Expected (rows) against got (columns):');
  out.push('  ' + 'expected'.padEnd(10) + LABELS.map((l) => l.padStart(8)).join(''));
  LABELS.forEach((e) => out.push('  ' + e.padEnd(10) + LABELS.map((g) => String(s.confusion[e][g]).padStart(8)).join('')));
  out.push('');
  out.push('Wrong cases (' + s.wrong.length + '):');
  if (!s.wrong.length) out.push('  none');
  s.wrong.forEach((w) => {
    out.push('  ' + (w.hard ? '[hard] ' : '') + w.title);
    out.push('      expected ' + w.expected.padEnd(7) + ' got ' + w.got.padEnd(7) + ' urgency ' + Number(w.urgency).toFixed(2) + '  ' + w.reason);
  });
  const extra = s.phoneErrors.filter((p) => !s.wrong.some((w) => w.title === p.title));
  if (extra.length) {
    out.push('');
    out.push('Right label but the phone does the wrong thing at this threshold:');
    extra.forEach((p) => out.push('  ' + p.title + ' (decision ' + p.got + ', urgency ' + Number(p.urgency).toFixed(2) + ', ' + (p.rang ? 'rang' : 'stayed quiet') + ')'));
  }
  out.push('');
  out.push('Response time: median ' + s.medianMs + ' ms, worst ' + s.worstMs + ' ms');
  if (s.sweep) {
    out.push('');
    out.push('Threshold sweep:');
    out.push('  ' + 'threshold'.padEnd(11) + 'false alarms'.padEnd(18) + 'misses');
    s.sweep.forEach((r) => out.push('  ' + r.threshold.toFixed(2).padEnd(11)
      + (r.falseAlarms.count + '/' + r.falseAlarms.of + ' (' + pct(r.falseAlarms.rate) + ')').padEnd(18)
      + r.misses.count + '/' + r.misses.of + ' (' + pct(r.misses.rate) + ')'));
  }
  console.log(out.join('\n'));
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rules') o.rules = true;
    else if (a === '--sweep') o.sweep = true;
    else if (a === '--json') o.json = true;
    else if (a === '--threshold') o.threshold = Number(argv[++i]);
    else if (a.startsWith('--threshold=')) o.threshold = Number(a.slice(12));
  }
  if ('threshold' in o && !(o.threshold >= 0 && o.threshold <= 1)) throw new Error('--threshold needs a number between 0 and 1');
  return o;
}

if (require.main === module) {
  (async () => {
    try {
      const o = parseArgs(process.argv.slice(2));
      const s = await run(o);
      if (o.json) console.log(JSON.stringify(s));
      else print(s);
    } catch (e) {
      console.error('eval failed: ' + String((e && e.message) || e).slice(0, 200));
      process.exitCode = 1;
    }
  })();
}

module.exports = { run };
