// Tests for the GitHub and Plaid event sources.  node cos/test-sources.js [--offline] [--live]
//   --offline  skip the real (read-only) GitHub poll
//   --live     also poll the real Plaid sandbox, using keys from the default settings file
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Point the settings loader at a file that does not exist, before anything requires it, so these
// tests see "no keys" whatever is in the real settings file.
const realFile = path.join(process.env.APPDATA || '.', 'desk-board', 'cos.json');
process.env.COS_CONFIG = path.join(os.tmpdir(), `cos-test-none-${process.pid}.json`);

const cfgFile = require('./keys');
const makeGithub = require('./sources/github');
const makePlaid = require('./sources/plaid');

const OFFLINE = process.argv.includes('--offline');
const LIVE = process.argv.includes('--live');
const log = () => {};
const HOUR = 3600 * 1000;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();

function checkEvent(e, source) {
  for (const f of ['id', 'source', 'kind', 'title', 'detail', 'ts', 'sample']) assert.ok(f in e, `event missing ${f}: ${JSON.stringify(e)}`);
  assert.strictEqual(e.source, source);
  for (const f of ['id', 'kind', 'title']) assert.ok(typeof e[f] === 'string' && e[f], `${f} must be a non-empty string`);
  assert.ok(typeof e.detail === 'string' && e.detail.length <= 600, 'detail must be a string of at most 600 chars');
  assert.ok(!isNaN(Date.parse(e.ts)), 'ts must parse');
  assert.strictEqual(typeof e.sample, 'boolean');
  if ('amount' in e) assert.strictEqual(typeof e.amount, 'number');
  if (e.url !== undefined) assert.strictEqual(typeof e.url, 'string');
}
const ids = (list) => list.map((e) => e.id);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('plaid without keys: sample charges, inject, stable ids', async () => {
  const p = makePlaid({ cfg: cfgFile, log });
  assert.strictEqual(p.name, 'plaid');
  const a = await p.poll();
  assert.ok(a.length >= 6 && a.length <= 12, 'about eight sample charges, got ' + a.length);
  a.forEach((e) => { checkEvent(e, 'plaid'); assert.strictEqual(e.sample, true); assert.strictEqual(e.kind, 'charge'); assert.ok(e.amount > 0); });
  assert.strictEqual(p.health(), 'sample');
  assert.strictEqual(new Set(ids(a)).size, a.length, 'ids unique');
  const b = await p.poll();
  assert.deepStrictEqual(ids(b).sort(), ids(a).sort(), 'ids stable across polls');
  const ins = p.inject({ merchant: 'Acme Wire Transfer', amount: 1240 });
  const c = await p.poll();
  assert.strictEqual(c.length, a.length + 1);
  const hit = c.find((e) => e.id === ins.id);
  assert.ok(hit && hit.amount === 1240 && hit.title === '$1,240.00 charge at Acme Wire Transfer', 'injected charge: ' + (hit && hit.title));
  checkEvent(hit, 'plaid'); assert.strictEqual(hit.sample, true);
  assert.strictEqual(new Set(ids(c)).size, c.length);
  assert.deepStrictEqual(ids(await p.poll()).sort(), ids(c).sort());
  assert.notStrictEqual(p.inject({ merchant: 'X', amount: 1 }).id, ins.id, 'inject ids unique');
});

test('plaid with fake keys and stubbed fetch', async () => {
  const calls = [];
  const syncAnswers = [
    { added: [], modified: [], removed: [], next_cursor: '', has_more: false }, // empty first answer is normal
    { added: [{ transaction_id: 'txn_1', name: 'UBER 063015 SF**POOL**', merchant_name: 'Uber', amount: 89.4, datetime: '2026-11-08T17:20:00Z', date: '2026-11-08', pending: false, personal_finance_category: { primary: 'TRANSPORTATION' } }], next_cursor: 'c1', has_more: true },
    { added: [{ transaction_id: 'txn_2', name: 'Pending Cafe', amount: 4.5, date: '2026-11-09', pending: true }], next_cursor: 'c2', has_more: false },
    { added: [], next_cursor: 'c2', has_more: false },
  ];
  const stub = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path: url.replace('https://sandbox.plaid.com', ''), body });
    assert.ok(init.signal, 'a timeout signal is passed');
    const ok = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.endsWith('/sandbox/public_token/create')) return ok({ public_token: 'public-sandbox-1' });
    if (url.endsWith('/item/public_token/exchange')) return ok({ access_token: 'access-sandbox-1' });
    if (url.endsWith('/transactions/sync')) return ok(syncAnswers.shift());
    throw new Error('unexpected call ' + url);
  };
  const p = makePlaid({ cfg: () => ({ plaidClientId: 'cid', plaidSecret: 'sec' }), log, fetch: stub });
  assert.strictEqual(p.health(), 'ok');
  assert.deepStrictEqual(await p.poll(), [], 'empty first answer gives no events and no error');
  assert.strictEqual(p.health(), 'ok');
  assert.deepStrictEqual(calls.map((c) => c.path), ['/sandbox/public_token/create', '/item/public_token/exchange', '/transactions/sync']);
  assert.deepStrictEqual(calls[0].body, { client_id: 'cid', secret: 'sec', institution_id: 'ins_109508', initial_products: ['transactions'] });
  assert.deepStrictEqual(calls[1].body, { client_id: 'cid', secret: 'sec', public_token: 'public-sandbox-1' });
  assert.strictEqual(calls[2].body.access_token, 'access-sandbox-1');

  const ev = await p.poll();
  assert.deepStrictEqual(calls.slice(3).map((c) => c.path), ['/transactions/sync', '/transactions/sync'], 'no second link; follows has_more');
  assert.strictEqual(calls[4].body.cursor, 'c1', 'second page uses the new cursor');
  assert.strictEqual(ev.length, 2);
  ev.forEach((e) => { checkEvent(e, 'plaid'); assert.strictEqual(e.sample, true); });
  const u = ev.find((e) => e.id === 'plaid:txn_1');
  assert.strictEqual(u.title, '$89.40 charge at Uber');
  assert.strictEqual(u.amount, 89.4);
  assert.strictEqual(u.ts, '2026-11-08T17:20:00.000Z');
  assert.ok(/Uber/.test(u.detail) && /Transportation/.test(u.detail) && /Posted/.test(u.detail), u.detail);
  assert.ok(/Pending/.test(ev.find((e) => e.id === 'plaid:txn_2').detail));

  p.inject({ merchant: 'Mystery LLC', amount: 1240 });
  const after = await p.poll();
  assert.strictEqual(calls[calls.length - 1].body.cursor, 'c2');
  assert.strictEqual(after.length, 3);
  assert.ok(after.some((e) => /Mystery LLC/.test(e.title)));
});

test('plaid: a failing call is reported, not thrown', async () => {
  const stub = async () => ({ ok: false, status: 400, json: async () => ({ error_code: 'INVALID_API_KEYS', error_message: 'invalid client_id or secret' }) });
  const p = makePlaid({ cfg: () => ({ plaidClientId: 'x', plaidSecret: 'y' }), log, fetch: stub });
  assert.deepStrictEqual(await p.poll(), []);
  assert.ok(/^error: INVALID_API_KEYS/.test(p.health()), p.health());
});

// canned gh: answers by the kind of command; `override(args)` may throw or return text instead
function canned(override) {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    if (override) { const r = override(args); if (r !== undefined) return r; }
    const j = JSON.stringify;
    if (args[0] === 'run') return j([
      { databaseId: 812345, displayTitle: 'Fix login redirect', workflowName: 'CI', headBranch: 'main', conclusion: 'failure', createdAt: ago(1), url: 'https://github.com/o/desk-board/actions/runs/812345', event: 'push' },
      { databaseId: 700000, displayTitle: 'Too old', workflowName: 'CI', headBranch: 'main', conclusion: 'failure', createdAt: ago(72), url: 'u', event: 'push' },
    ]);
    if (args[0] === 'issue') return j([
      { number: 7, title: 'App crashes on start', body: 'x'.repeat(2000), createdAt: ago(2), url: 'https://github.com/o/desk-board/issues/7', author: { login: 'alice' }, labels: [] },
      { number: 3, title: 'Old issue', body: 'b', createdAt: ago(100), url: 'u', author: { login: 'bob' }, labels: [] },
    ]);
    const p = args[1];
    if (/dependabot\/alerts/.test(p)) return j([{ number: 4, state: 'open', created_at: ago(5), html_url: 'https://github.com/o/desk-board/security/dependabot/4', dependency: { package: { name: 'lodash', ecosystem: 'npm' } }, security_advisory: { ghsa_id: 'GHSA-xxxx-yyyy-zzzz', cve_id: 'CVE-2026-0001', summary: 'Prototype pollution in lodash', severity: 'high' } }]);
    if (/secret-scanning\/alerts\/\d+\/locations/.test(p)) return j([{ type: 'commit', details: { path: 'config/.env', start_line: 3 } }]);
    if (/secret-scanning\/alerts/.test(p)) return j([{ number: 2, state: 'open', created_at: ago(4), html_url: 'https://github.com/o/desk-board/security/secret-scanning/2', secret_type: 'github_personal_access_token', secret_type_display_name: 'GitHub Personal Access Token', secret: 'ghp_SUPERSECRETVALUE123' }]);
    if (/^notifications/.test(p)) return j([
      { id: '501', reason: 'review_requested', updated_at: ago(0.5), subject: { title: 'Add dark mode', type: 'PullRequest', url: 'https://api.github.com/repos/o/other/pulls/9' }, repository: { full_name: 'o/other', html_url: 'https://github.com/o/other' } },
      { id: '502', reason: 'mention', updated_at: ago(0.6), subject: { title: 'Question about setup', type: 'Issue', url: 'https://api.github.com/repos/o/other/issues/11' }, repository: { full_name: 'o/other', html_url: 'https://github.com/o/other' } },
      { id: '503', reason: 'subscribed', updated_at: ago(0.7), subject: { title: 'Release notes', type: 'Release', url: null }, repository: { full_name: 'o/other', html_url: 'https://github.com/o/other' } },
      { id: '504', reason: 'subscribed', updated_at: ago(1.9), subject: { title: 'App crashes on start', type: 'Issue', url: 'https://api.github.com/repos/o/desk-board/issues/7' }, repository: { full_name: 'o/desk-board', html_url: 'https://github.com/o/desk-board' } },
    ]);
    throw new Error('unexpected gh call: ' + args.join(' '));
  };
  return { exec, calls };
}
const notFound = (what) => Object.assign(new Error(`gh: ${what} (HTTP 404)`), { code: 1 });

test('github with canned gh output maps every kind', async () => {
  const { exec, calls } = canned();
  const g = makeGithub({ cfg: () => ({ repos: ['o/desk-board'] }), log, exec });
  const ev = await g.poll();
  ev.forEach((e) => { checkEvent(e, 'github'); assert.strictEqual(e.sample, false); });
  assert.strictEqual(g.health(), 'ok');
  assert.strictEqual(new Set(ids(ev)).size, ev.length);
  const by = (id) => ev.find((e) => e.id === id);

  const run = by('gh:run:812345');
  assert.strictEqual(run.kind, 'build_failed');
  assert.strictEqual(run.title, 'Build failed on main in desk-board: Fix login redirect');
  assert.ok(!by('gh:run:700000'), 'old run left out');

  const issue = by('gh:issue:o/desk-board#7');
  assert.strictEqual(issue.kind, 'issue');
  assert.ok(/alice/.test(issue.detail) && issue.detail.length <= 600);
  assert.ok(!by('gh:issue:o/desk-board#3'), 'old issue left out');

  const dep = by('gh:dependabot:o/desk-board#4');
  assert.strictEqual(dep.kind, 'security_alert');
  assert.ok(/lodash/.test(dep.detail) && /high/.test(dep.detail) && /GHSA-xxxx-yyyy-zzzz/.test(dep.detail) && /CVE-2026-0001/.test(dep.detail) && /Prototype pollution/.test(dep.detail), dep.detail);

  const sec = by('gh:secret:o/desk-board#2');
  assert.strictEqual(sec.kind, 'security_alert');
  assert.ok(/config\/\.env/.test(sec.detail), sec.detail);
  assert.ok(!JSON.stringify(ev).includes('SUPERSECRETVALUE'), 'the secret value must never appear in an event');

  const rev = by('gh:notif:501');
  assert.strictEqual(rev.kind, 'review_request');
  assert.strictEqual(rev.url, 'https://github.com/o/other/pull/9');
  assert.strictEqual(by('gh:notif:502').kind, 'mention');
  assert.strictEqual(by('gh:notif:503').kind, 'notification');
  assert.ok(!by('gh:notif:504'), 'notification that repeats a collected issue is skipped');
  assert.ok(!ev.some((e) => 'repo' in e || 'subjectUrl' in e), 'no internal fields leak');

  for (let i = 1; i < ev.length; i++) assert.ok(Date.parse(ev[i - 1].ts) >= Date.parse(ev[i].ts), 'newest first');
  assert.strictEqual(calls.filter((a) => a[0] === 'api' && /^notifications/.test(a[1])).length, 1, 'notifications fetched once per poll');
  assert.ok(calls.every((a) => Array.isArray(a)), 'gh is called with an argument array');
});

test('github: a 404 on one feature skips it quietly and is not retried', async () => {
  const { exec, calls } = canned((args) => {
    if (args[0] === 'api' && /secret-scanning/.test(args[1])) throw notFound('Secret scanning is disabled on this repository');
    if (args[0] === 'api' && /dependabot/.test(args[1])) throw Object.assign(new Error('gh: Dependabot alerts are disabled for this repository. (HTTP 403)'), { code: 1 });
  });
  const g = makeGithub({ cfg: () => ({ repos: ['o/desk-board'] }), log, exec });
  const ev = await g.poll();
  assert.strictEqual(g.health(), 'ok');
  assert.ok(ev.some((e) => e.kind === 'build_failed') && ev.some((e) => e.kind === 'issue') && ev.some((e) => e.kind === 'review_request'));
  assert.ok(!ev.some((e) => e.kind === 'security_alert'));
  const n = calls.length;
  await g.poll();
  const second = calls.slice(n);
  assert.ok(!second.some((a) => /secret-scanning|dependabot/.test(a[1] || '')), 'switched-off features are not retried');
});

test('github: other errors set health; missing gh is reported; no repos is off', async () => {
  const g1 = makeGithub({ cfg: () => ({ repos: ['o/desk-board'] }), log, exec: async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); } });
  assert.deepStrictEqual(await g1.poll(), []);
  assert.strictEqual(g1.health(), 'error: gh is not installed');

  const g2 = makeGithub({ cfg: () => ({ repos: ['o/desk-board'] }), log, exec: async () => { throw new Error('To get started with GitHub CLI, please run:  gh auth login'); } });
  await g2.poll();
  assert.strictEqual(g2.health(), 'error: gh is not signed in');

  const { exec } = canned((a) => { if (a[0] === 'issue') throw new Error('connection reset by peer'); });
  const g3 = makeGithub({ cfg: () => ({ repos: ['o/desk-board'] }), log, exec });
  const ev = await g3.poll();
  assert.ok(ev.some((e) => e.kind === 'build_failed'), 'the rest still comes back');
  assert.ok(/^error: connection reset/.test(g3.health()), g3.health());

  const g4 = makeGithub({ cfg: () => ({ repos: [] }), log, exec });
  assert.deepStrictEqual(await g4.poll(), []);
  assert.strictEqual(g4.health(), 'off');
});

test('github: repo names that are not owner/name are never passed to gh', async () => {
  const seen = [];
  const g = makeGithub({ cfg: () => ({ repos: ['--hostile', 'a b/c'] }), log, exec: async (a) => { seen.push(a); return '[]'; } });
  assert.deepStrictEqual(await g.poll(), []);
  assert.strictEqual(seen.length, 0);
  assert.strictEqual(g.health(), 'off');
});

if (!OFFLINE) {
  test('real GitHub poll (read-only)', async () => {
    const g = makeGithub({ cfg: () => ({ repos: ['gouthamdeepak1705/desk-board'] }), log });
    const t = Date.now();
    const ev = await g.poll();
    const ms = Date.now() - t;
    ev.forEach((e) => checkEvent(e, 'github'));
    const counts = {};
    for (const e of ev) counts[e.kind] = (counts[e.kind] || 0) + 1;
    console.log(`    real poll: ${ev.length} events in ${ms} ms, health "${g.health()}", by kind ${JSON.stringify(counts)}`);
    for (const e of ev.slice(0, 5)) console.log(`      ${e.kind}: ${e.title}`);
    assert.ok(!/^error/.test(g.health()), 'real poll health: ' + g.health());
  });
}

if (LIVE) {
  test('real Plaid sandbox poll', async () => {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(realFile, 'utf8')); } catch {}
    if (!saved.plaidClientId || !saved.plaidSecret) { console.log('    skipped: no Plaid keys in ' + realFile); return; }
    const p = makePlaid({ cfg: () => saved, log });
    let ev = [];
    for (let i = 0; i < 4 && !ev.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 5000)); // sandbox data takes a few seconds to appear
      ev = await p.poll();
    }
    console.log(`    live plaid: ${ev.length} events, health "${p.health()}"`);
    ev.forEach((e) => { checkEvent(e, 'plaid'); assert.strictEqual(e.sample, true); });
    assert.strictEqual(p.health(), 'ok');
  });
}

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n       ')); }
  }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
