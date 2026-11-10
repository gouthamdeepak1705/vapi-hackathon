// Tests for cos/jev.js and cos/exa.js. `node cos/test-decide.js`; add --live to also hit the real services.
const os = require('os');
const path = require('path');
const LIVE = process.argv.includes('--live');
// Must happen before anything requires cos/keys.js, so no real keys are read in the offline run.
if (!LIVE) process.env.COS_CONFIG = path.join(os.tmpdir(), 'desk-board-no-such-cos-' + process.pid + '.json');

const assert = require('assert');
const cfgReal = require('./keys');
const createJev = require('./jev');
const createExa = require('./exa');
const { rules } = createJev;
const { queryFor } = createExa;

const ev = (o) => ({ id: 'x', source: 'demo', ts: new Date().toISOString(), detail: '', ...o });
const realFetch = global.fetch;
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + (e && e.stack || e)); process.exitCode = 1; }
}

(async () => {
  const none = () => ({ jevKey: '', exaKey: '' });

  await t('rules: leaked key issue -> call', () => {
    const s = rules(ev({ kind: 'issue', title: 'Leaked API key in config.js', detail: 'The secret is committed in the repo.' }));
    assert.strictEqual(s.decision, 'call'); assert(s.urgency >= 0.85); assert.strictEqual(s.by, 'rules'); assert(s.reason);
  });
  await t('rules: $1,240 unknown charge -> call', () => {
    const s = rules(ev({ kind: 'charge', title: '$1,240.00 at UNKNOWN MERCHANT', amount: 1240 }));
    assert.strictEqual(s.decision, 'call'); assert(s.urgency >= 0.85);
  });
  await t('rules: typo issue -> ignore', () => {
    assert.strictEqual(rules(ev({ kind: 'issue', title: 'Fix typo in README' })).decision, 'ignore');
  });
  await t('rules: $4 coffee -> ignore', () => {
    assert.strictEqual(rules(ev({ kind: 'charge', title: '$4.50 at Blue Bottle Coffee', amount: 4.5 })).decision, 'ignore');
  });
  await t('rules: ordinary issue -> brief', () => {
    assert.strictEqual(rules(ev({ kind: 'issue', title: 'Export button does nothing on the settings page' })).decision, 'brief');
  });
  await t('rules: other cases', () => {
    assert.strictEqual(rules(ev({ kind: 'security_alert', title: 'Dependabot alert: lodash' })).decision, 'call');
    assert.strictEqual(rules(ev({ kind: 'build_failed', title: 'CI failed on main' })).decision, 'call');
    assert.strictEqual(rules(ev({ kind: 'build_failed', title: 'CI failed on feature/x' })).decision, 'brief');
    assert.strictEqual(rules(ev({ kind: 'review_request', title: 'Review requested: add export' })).decision, 'brief');
    assert.strictEqual(rules(ev({ kind: 'charge', title: '$80 at Hardware Store', amount: 80 })).decision, 'brief');
    assert.strictEqual(rules(ev({ kind: 'issue', title: 'Bump left-pad minor version' })).decision, 'ignore');
    assert.strictEqual(rules(ev({ kind: 'charge', title: '$12 at Netflix subscription', amount: 12 })).decision, 'ignore');
    assert.strictEqual(rules(ev({ kind: 'issue', title: 'Production down, customers cannot log in' })).decision, 'call');
  });

  await t('jev: no key -> rules, no throw, health off', async () => {
    const jev = createJev({ cfg: none });
    const s = await jev.score(ev({ kind: 'issue', title: 'Fix typo' }), '');
    assert.strictEqual(s.by, 'rules'); assert.strictEqual(s.decision, 'ignore'); assert.strictEqual(jev.health(), 'off');
  });
  await t('exa: no key -> null, health off', async () => {
    const exa = createExa({ cfg: none });
    assert.strictEqual(await exa.context(ev({ kind: 'charge', title: '$9 at Acme' })), null);
    assert.strictEqual(exa.health(), 'off');
  });

  await t('exa query: charge has merchant, not amount', () => {
    const q = queryFor(ev({ kind: 'charge', title: 'Charge of $1,240.00 at ZENITH HOLDINGS LLC', detail: 'Card ending 4242, account 99887766', amount: 1240 }));
    assert(q.includes('ZENITH HOLDINGS LLC'), q);
    assert(!/1,?240|4242|99887766|\$/.test(q), q);
    const q2 = queryFor(ev({ kind: 'charge', title: 'ACME Corp', amount: 77.31 }));
    assert(q2.includes('ACME Corp') && !q2.includes('77'), q2);
  });
  await t('exa query: other kinds', () => {
    assert(/CVE-2024-1234/.test(queryFor(ev({ kind: 'security_alert', title: 'Alert', detail: 'CVE-2024-1234 in package express' }))));
    assert(/severity and fix$/.test(queryFor(ev({ kind: 'security_alert', title: 'Alert', detail: 'CVE-2024-1234 in package express' }))));
    const b = queryFor(ev({ kind: 'build_failed', title: 'CI failed', detail: 'step 1 ok\nError: Cannot find module "foo" at C:\\Users\\me\\x.js\nstep 3' }));
    assert(/Cannot find module/.test(b) && /cause and fix$/.test(b) && !/Users/.test(b), b);
    assert.strictEqual(queryFor(ev({ kind: 'issue', title: 'Fix typo' })), null);
    assert.strictEqual(queryFor(ev({ kind: 'review_request', title: 'Please review' })), null);
  });

  await t('jev: canned response parsed to by:jev', async () => {
    let seen;
    global.fetch = async (url, opts) => {
      seen = { url, opts, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ model: 'jev-latest', answers: {
        route: { type: 'choice', choice: 'call_now', confidence: 0.9, probabilities: { call_now: 0.8, next_briefing: 0.15, ignore: 0.05 } },
        severity: { type: 'score', score: 2.7, confidence: 0.8, probabilities: {} },
        money: { type: 'noul', noul: 0.2 }, secret: { type: 'noul', noul: 0.92 }, blocked: { type: 'noul', noul: 0.3 },
        fraud: { type: 'noul', noul: 0.1 }, routine: { type: 'noul', noul: 0.05 },
      } }) };
    };
    const jev = createJev({ cfg: () => ({ jevKey: 'k1' }) });
    assert.strictEqual(jev.health(), 'ok');
    const s = await jev.score(ev({ kind: 'issue', title: 'x', ts: new Date(Date.now() - 600000).toISOString() }), 'I run a shop');
    assert.strictEqual(s.by, 'jev'); assert.strictEqual(s.decision, 'call');
    assert(Math.abs(s.urgency - 0.85) < 1e-9, String(s.urgency));
    assert(/exposed credential/i.test(s.reason) && /^[A-Z].*\.$/.test(s.reason), s.reason);
    assert(Number.isFinite(s.ms)); assert.strictEqual(jev.health(), 'ok');
    assert.strictEqual(seen.url, 'https://api.typesafe.ai/v1/systemone');
    assert.strictEqual(seen.opts.headers.Authorization, 'Bearer k1');
    assert.strictEqual(seen.body.model, 'jev-latest');
    assert(seen.body.state.includes('I run a shop') && seen.body.state.length <= 4000);
    assert.deepStrictEqual(Object.keys(seen.body.questions.route.criteria).sort(), ['call_now', 'ignore', 'next_briefing']);
    assert.strictEqual(seen.body.questions.severity.criteria.length, 4);
    // shuffled on each request: over 30 requests more than one order must appear
    const orders = new Set();
    for (let i = 0; i < 30; i++) { await jev.score(ev({ kind: 'issue', title: 'x' }), ''); orders.add(Object.keys(seen.body.questions.route.criteria).join()); }
    assert(orders.size > 1, 'option order never changed');
    await createJev({ cfg: () => ({ jevKey: 'k', jevBase: 'https://openrouter.ai/api/v1/' }) }).score(ev({ kind: 'issue', title: 'x' }), '');
    assert.strictEqual(seen.url, 'https://openrouter.ai/api/v1/systemone'); assert.strictEqual(seen.body.model, 'typesafe/jev-1.14');
  });
  await t('jev: bad answers and http errors fall back, health reports', async () => {
    const jev = createJev({ cfg: () => ({ jevKey: 'k' }) });
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    let s = await jev.score(ev({ kind: 'issue', title: 'Fix typo' }), '');
    assert.strictEqual(s.by, 'rules'); assert(/^error: /.test(jev.health()), jev.health());
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ answers: { route: {} } }) });
    s = await jev.score(ev({ kind: 'issue', title: 'Fix typo' }), '');
    assert.strictEqual(s.by, 'rules');
    global.fetch = async () => { throw new Error('boom'); };
    s = await jev.score(ev({ kind: 'issue', title: 'Fix typo' }), '');
    assert.strictEqual(s.by, 'rules');
  });
  await t('jev: hung fetch falls back to rules within 3 s', async () => {
    global.fetch = (url, opts) => new Promise(() => {}); // ignores the abort signal on purpose
    const jev = createJev({ cfg: () => ({ jevKey: 'k' }) });
    const t0 = Date.now();
    const s = await jev.score(ev({ kind: 'charge', title: '$4 at Cafe', amount: 4 }), '');
    const dt = Date.now() - t0;
    assert(dt < 3000, 'took ' + dt); assert.strictEqual(s.by, 'rules'); assert.strictEqual(s.decision, 'ignore');
    assert.strictEqual(jev.health(), 'error: timeout');
  });

  await t('exa: canned /answer parsed, trimmed, cached', async () => {
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ answer: 'x'.repeat(900), citations: [1, 2, 3, 4].map((i) => ({ title: 'T' + i, url: 'https://e.com/' + i })) }) };
    };
    const exa = createExa({ cfg: () => ({ exaKey: 'ek' }) });
    const e = ev({ kind: 'charge', title: 'Charge of $1,240.00 at ZENITH LLC', amount: 1240 });
    const c = await exa.context(e);
    assert.strictEqual(c.answer.length, 400); assert.strictEqual(c.sources.length, 3);
    assert.deepStrictEqual(c.sources[0], { title: 'T1', url: 'https://e.com/1' });
    assert.strictEqual(calls[0].url, 'https://api.exa.ai/answer'); assert.strictEqual(calls[0].opts.headers['x-api-key'], 'ek');
    assert(!/1,?240/.test(calls[0].opts.body));
    await exa.context(e); assert.strictEqual(calls.length, 1, 'second lookup should hit the cache');
    assert.strictEqual(await exa.context(ev({ kind: 'issue', title: 'Fix typo' })), null); assert.strictEqual(calls.length, 1);
    assert.strictEqual(exa.health(), 'ok');
  });
  await t('exa: /answer failure falls back to /search', async () => {
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      if (url.endsWith('/answer')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ results: [{ title: 'A', url: 'https://a.com', highlights: ['First highlight.'] }, { title: 'B', url: 'https://b.com', highlights: ['Second.'] }] }) };
    };
    const c = await createExa({ cfg: () => ({ exaKey: 'ek' }) }).context(ev({ kind: 'charge', title: '$9 at Acme' }));
    assert.strictEqual(c.answer, 'First highlight.'); assert.strictEqual(c.sources.length, 2);
    assert.deepStrictEqual(urls.map((u) => u.split('/').pop()), ['answer', 'search']);
  });
  await t('exa: total failure -> null, health error, within 9 s', async () => {
    global.fetch = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const exa = createExa({ cfg: () => ({ exaKey: 'ek' }) });
    const t0 = Date.now();
    assert.strictEqual(await exa.context(ev({ kind: 'charge', title: '$9 at Acme' })), null);
    assert(Date.now() - t0 < 9000); assert(/^error: /.test(exa.health()), exa.health());
  });

  global.fetch = realFetch;

  if (LIVE) {
    const c = cfgReal();
    const sample = ev({ kind: 'charge', title: '$1,240.00 at ZENITH HOLDINGS LLC', amount: 1240, detail: 'Card purchase' });
    if (c.jevKey) {
      const t0 = Date.now();
      const s = await createJev({ cfg: cfgReal, log: console.log }).score(sample, 'Small business owner; money questions matter most.');
      console.log('LIVE jev', Date.now() - t0, 'ms', JSON.stringify(s));
    } else console.log('LIVE jev skipped: no jevKey');
    if (c.exaKey) {
      const t0 = Date.now();
      const r = await createExa({ cfg: cfgReal, log: console.log }).context(sample);
      console.log('LIVE exa', Date.now() - t0, 'ms', JSON.stringify(r));
    } else console.log('LIVE exa skipped: no exaKey');
  }

  console.log(process.exitCode ? 'FAILED' : `all ${passed} passed`);
})();
