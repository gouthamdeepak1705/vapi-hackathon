// Tests for orders.js. Only a recording fake exec is used: no real gh command ever runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Must be set before keys.js is loaded.
const tmp = path.join(os.tmpdir(), `cos-orders-test-${process.pid}.json`);
fs.writeFileSync(tmp, JSON.stringify({ repos: ['acme/widgets'] }));
process.env.COS_CONFIG = tmp;

const cfg = require('./keys');
const make = require('./orders');

let calls = [];
let impl = async () => '';
const exec = async (args) => { calls.push(args); return impl(args); };
const orders = make({ cfg, log: () => {}, exec });

const run1 = { id: 'gh:run:812345', source: 'github', kind: 'build_failed', title: 'Build failed on main in widgets: CI', url: 'https://github.com/acme/widgets/actions/runs/812345', sample: false };
const issue = { id: 'gh:issue:acme/widgets#7', source: 'github', kind: 'issue', title: 'New issue in widgets: crash', url: 'https://github.com/acme/widgets/issues/7', sample: false };
const charge = { id: 'plaid:txn_1', source: 'plaid', kind: 'charge', title: 'Charge of $40 at Acme Cafe', merchant: 'Acme Cafe', amount: 40, sample: true };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const reset = () => { calls = []; impl = async () => ''; };

test('rerun_build args and result', async () => {
  const r = await orders.run({ action: 'rerun_build', text: '' }, run1);
  assert.deepStrictEqual(calls, [['run', 'rerun', '812345', '-R', 'acme/widgets', '--failed']]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.simulated, false);
  assert.strictEqual(r.result, 'I restarted the failed jobs on main in widgets.');
  assert.deepStrictEqual(r.ref, { kind: 'run', repo: 'acme/widgets', id: '812345' });
});

test('comment args, footer appended', async () => {
  const r = await orders.run({ action: 'comment', text: 'On it' }, issue);
  assert.deepStrictEqual(calls, [['issue', 'comment', '7', '-R', 'acme/widgets', '--body=On it\n\nSent by phone through my chief of staff.']]);
  assert.strictEqual(r.ok, true);
});

test('close_issue args', async () => {
  const r = await orders.run({ action: 'close_issue', text: '' }, issue);
  assert.deepStrictEqual(calls, [['issue', 'close', '7', '-R', 'acme/widgets']]);
  assert.strictEqual(r.ok, true);
});

test('label_urgent creates the label then adds it', async () => {
  const r = await orders.run({ action: 'label_urgent', text: '' }, issue);
  assert.deepStrictEqual(calls, [
    ['label', 'create', 'urgent', '-R', 'acme/widgets', '--color', 'B60205', '--force'],
    ['issue', 'edit', '7', '-R', 'acme/widgets', '--add-label', 'urgent'],
  ]);
  assert.strictEqual(r.ok, true);
});

test('assign_me args', async () => {
  const r = await orders.run({ action: 'assign_me', text: '' }, issue);
  assert.deepStrictEqual(calls, [['issue', 'edit', '7', '-R', 'acme/widgets', '--add-assignee', '@me']]);
  assert.strictEqual(r.ok, true);
});

test('create_issue uses event repo, parses the number, no ids or urls in the sentence', async () => {
  impl = async () => 'https://github.com/acme/widgets/issues/42\n';
  const r = await orders.run({ action: 'create_issue', text: 'Fix the login page' }, issue);
  assert.deepStrictEqual(calls, [['issue', 'create', '-R', 'acme/widgets', '--title=Fix the login page', '--body=Created by phone through my chief of staff.']]);
  assert.strictEqual(r.ok, true);
  assert.ok(/42/.test(r.result));
  assert.ok(!/https?:/.test(r.result));
  assert.deepStrictEqual(r.ref, { kind: 'issue', repo: 'acme/widgets', url: 'https://github.com/acme/widgets/issues/42' });
});

test('create_issue with no event uses the first configured repo', async () => {
  const r = await orders.run({ action: 'create_issue', text: 'Water the plants' }, null);
  assert.deepStrictEqual(calls[0].slice(0, 3), ['issue', 'create', '-R']);
  assert.strictEqual(calls[0][3], 'acme/widgets');
  assert.strictEqual(r.ok, true);
});

test('dispute_charge is always simulated and runs nothing', async () => {
  const r = await orders.run({ action: 'dispute_charge', text: '' }, charge);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.simulated, true);
  assert.strictEqual(r.result, "I've flagged the charge at Acme Cafe for dispute. This is sandbox data, so nothing was sent to a bank.");
  const live = await orders.run({ action: 'dispute_charge', text: '' }, { ...charge, sample: false, source: 'plaid' });
  assert.strictEqual(live.simulated, true);
  assert.deepStrictEqual(calls, []);
});

test('mute_similar and unknown actions are refused', async () => {
  for (const a of ['mute_similar', 'delete_repo', 'merge_pr', undefined]) {
    const r = await orders.run({ action: a, text: '' }, issue);
    assert.deepStrictEqual({ ok: r.ok, result: r.result }, { ok: false, result: "That isn't something I can do." });
  }
  const none = await orders.run(null, issue);
  assert.strictEqual(none.ok, false);
  assert.deepStrictEqual(calls, []);
});

test('repo not on the list is refused, nothing runs', async () => {
  const other = { ...issue, id: 'gh:issue:evil/other#7' };
  const r = await orders.run({ action: 'close_issue', text: '' }, other);
  assert.strictEqual(r.ok, false);
  assert.ok(/watched list/.test(r.result));
  const otherRun = { ...run1, url: 'https://github.com/evil/other/actions/runs/812345' };
  assert.strictEqual((await orders.run({ action: 'rerun_build', text: '' }, otherRun)).ok, false);
  assert.strictEqual((await orders.run({ action: 'create_issue', text: 'x' }, { ...issue, repo: 'evil/other' })).ok, false);
  assert.deepStrictEqual(calls, []);
});

test('repo match is case-insensitive', async () => {
  const r = await orders.run({ action: 'close_issue', text: '' }, { ...issue, id: 'gh:issue:ACME/Widgets#7' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 1);
});

test('bad repo characters are refused', async () => {
  for (const bad of ['acme/wid gets', 'acme/widgets;rm -rf', 'acme/widgets$(x)', '-x/widgets', 'acme/a/b']) {
    const r = await orders.run({ action: 'close_issue', text: '' }, { ...issue, id: `gh:issue:${bad}#7` });
    assert.strictEqual(r.ok, false, bad);
  }
  const r = await orders.run({ action: 'rerun_build', text: '' }, { ...run1, url: 'https://github.com/acme/wid gets/actions/runs/812345' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(calls, []);
});

test('non-numeric ids are refused', async () => {
  assert.strictEqual((await orders.run({ action: 'rerun_build', text: '' }, { ...run1, id: 'gh:run:1; rm' })).ok, false);
  assert.strictEqual((await orders.run({ action: 'close_issue', text: '' }, { ...issue, id: 'gh:issue:acme/widgets#7 --web' })).ok, false);
  assert.deepStrictEqual(calls, []);
});

test('demo and sample events are simulated, nothing executed', async () => {
  const acts = ['rerun_build', 'comment', 'close_issue', 'label_urgent', 'assign_me', 'create_issue'];
  for (const ev of [
    { ...run1, source: 'demo' }, { ...run1, sample: true },
    { ...issue, source: 'demo' }, { ...issue, sample: true },
  ]) {
    for (const a of acts) {
      if ((a === 'rerun_build') !== (ev.kind === 'build_failed') && a !== 'create_issue') continue;
      const r = await orders.run({ action: a, text: 'hello' }, ev);
      assert.strictEqual(r.ok, true, a);
      assert.strictEqual(r.simulated, true, a);
      assert.ok(r.result.startsWith('Simulated: I would have '), r.result);
    }
  }
  const r = await orders.run({ action: 'rerun_build', text: '' }, { id: 'demo:1', source: 'demo', kind: 'build_failed', title: 't' });
  assert.strictEqual(r.simulated, true);
  assert.strictEqual(r.result, 'Simulated: I would have rerun the build.');
  assert.deepStrictEqual(calls, []);
});

test('missing or wrong-kind event is refused with what it needs', async () => {
  const cases = [
    ['rerun_build', issue, /failed build/], ['rerun_build', null, /failed build/],
    ['comment', run1, /issue/], ['close_issue', null, /issue/], ['label_urgent', charge, /issue/],
    ['assign_me', run1, /issue/], ['dispute_charge', issue, /charge/], ['dispute_charge', null, /charge/],
  ];
  for (const [a, ev, re] of cases) {
    const r = await orders.run({ action: a, text: 'x' }, ev);
    assert.strictEqual(r.ok, false, a);
    assert.ok(re.test(r.result), r.result);
  }
  assert.deepStrictEqual(calls, []);
});

test('empty text is an error for comment and create_issue', async () => {
  for (const a of ['comment', 'create_issue']) {
    for (const t of ['', '   ', '\u0000\u0007', undefined]) {
      const r = await orders.run({ action: a, text: t }, issue);
      assert.strictEqual(r.ok, false);
    }
  }
  assert.deepStrictEqual(calls, []);
});

test('text starting with a dash cannot be read as a flag', async () => {
  await orders.run({ action: 'comment', text: '--delete-everything' }, issue);
  assert.strictEqual(calls[0][5], '--body=--delete-everything\n\nSent by phone through my chief of staff.');
  await orders.run({ action: 'create_issue', text: '--web' }, issue);
  assert.ok(calls[1].includes('--title=--web'));
  assert.ok(!calls[1].includes('--web'));
});

test('control characters are stripped', async () => {
  await orders.run({ action: 'comment', text: 'a\u0000b\u001b[31mc\u0007' }, issue);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(calls[0][5]));
  assert.ok(calls[0][5].startsWith('--body=ab[31mc'));
  await orders.run({ action: 'create_issue', text: 'line one\nline two\u0000' }, issue);
  assert.ok(calls[1].includes('--title=line one line two'));
});

test('over-long text is trimmed', async () => {
  await orders.run({ action: 'comment', text: 'x'.repeat(2000) }, issue);
  const body = calls[0][5].slice('--body='.length);
  assert.strictEqual(body, 'x'.repeat(500) + '\n\nSent by phone through my chief of staff.');
  await orders.run({ action: 'create_issue', text: 'y'.repeat(2000) }, issue);
  assert.ok(calls[1][4].length <= '--title='.length + 200);
});

test('arguments are always an array of strings, only known commands', async () => {
  const evFor = { rerun_build: run1, comment: issue, close_issue: issue, label_urgent: issue, assign_me: issue, create_issue: issue };
  for (const a of Object.keys(evFor)) await orders.run({ action: a, text: 'hi' }, evFor[a]);
  const allowed = new Set(['run rerun', 'issue comment', 'issue close', 'label create', 'issue edit', 'issue create']);
  assert.ok(calls.length >= 7);
  for (const c of calls) {
    assert.ok(Array.isArray(c) && c.every((x) => typeof x === 'string'));
    assert.ok(allowed.has(c[0] + ' ' + c[1]), c.join(' '));
  }
});

test('gh failure gives ok:false without throwing', async () => {
  impl = async () => { throw new Error('GraphQL: Could not resolve to an Issue with the number of 7.\nsecond line'); };
  const r = await orders.run({ action: 'close_issue', text: '' }, issue);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.simulated, false);
  assert.strictEqual(r.result, "I couldn't close the issue: GraphQL: Could not resolve to an Issue with the number of 7.");
  assert.ok(!/second line/.test(r.result));
  impl = async () => { throw new Error('z'.repeat(400)); };
  const r2 = await orders.run({ action: 'rerun_build', text: '' }, run1);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.result.startsWith("I couldn't rerun the build: "));
  assert.ok(r2.result.length <= "I couldn't rerun the build: ".length + 121);
  impl = async () => { throw null; };
  assert.strictEqual((await orders.run({ action: 'assign_me', text: '' }, issue)).ok, false);
});

test('label failure stops before the edit', async () => {
  impl = async (args) => { if (args[0] === 'label') throw new Error('permission denied'); return ''; };
  const r = await orders.run({ action: 'label_urgent', text: '' }, issue);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls.length, 1);
});

test('check: running, passed, failed', async () => {
  const order = { action: 'rerun_build', ref: { kind: 'run', repo: 'acme/widgets', id: '812345' } };
  impl = async () => JSON.stringify({ status: 'in_progress', conclusion: '' });
  assert.deepStrictEqual(await orders.check(order), { result: 'The rerun is still going.' });
  assert.deepStrictEqual(calls[0], ['run', 'view', '812345', '-R', 'acme/widgets', '--json', 'status,conclusion']);
  impl = async () => JSON.stringify({ status: 'completed', conclusion: 'success' });
  assert.deepStrictEqual(await orders.check(order), { result: 'The rerun passed.' });
  impl = async () => JSON.stringify({ status: 'completed', conclusion: 'failure' });
  assert.deepStrictEqual(await orders.check(order), { result: 'The rerun failed again.' });
});

test('check: null for other refs, bad refs, errors', async () => {
  assert.strictEqual(await orders.check({ ref: { kind: 'issue', repo: 'acme/widgets', url: 'x' } }), null);
  assert.strictEqual(await orders.check({}), null);
  assert.strictEqual(await orders.check(null), null);
  assert.strictEqual(await orders.check({ ref: { kind: 'run', repo: 'evil/other', id: '1' } }), null);
  assert.strictEqual(await orders.check({ ref: { kind: 'run', repo: 'acme/widgets', id: '1; x' } }), null);
  assert.deepStrictEqual(calls, []);
  impl = async () => { throw new Error('boom'); };
  assert.strictEqual(await orders.check({ ref: { kind: 'run', repo: 'acme/widgets', id: '1' } }), null);
  impl = async () => 'not json';
  assert.strictEqual(await orders.check({ ref: { kind: 'run', repo: 'acme/widgets', id: '1' } }), null);
});

test('describe and ACTIONS', async () => {
  const d = {
    rerun_build: 'rerun the build', comment: 'comment on the issue', close_issue: 'close the issue',
    label_urgent: 'label it urgent', assign_me: 'assign it to you', create_issue: 'open a new issue',
    mute_similar: 'stop calling about things like this', dispute_charge: 'flag the charge for dispute',
  };
  for (const [a, p] of Object.entries(d)) assert.strictEqual(orders.describe(a), p);
  assert.deepStrictEqual([...make.ACTIONS].sort(), Object.keys(d).sort());
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    reset();
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
  }
  try { fs.unlinkSync(tmp); } catch {}
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
