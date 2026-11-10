// Tests for the orchestrator, using fake modules and a temp folder. Run: node cos/test-core.js
// With --real it also builds the chief from the real modules (no keys) and fires the 'leak' demo.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-core-'));
process.env.COS_CONFIG = path.join(tmp, 'cos.json'); // before anything loads cos/keys

const createChief = require('./index');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return; await sleep(15); }
  throw new Error('timed out waiting for ' + what);
}

// ---- fakes ----
const vals = { vapiKey: '', myPhone: '+15550100', threshold: 0.7, pollSeconds: 0.08, maxCallsPerHour: 99 };
const cfg = () => ({ ...vals });
cfg.save = (patch) => Object.assign(vals, patch);

const found = [];                      // what the fake source currently reports
let profileNow = 'Goutham, solo developer, owns desk-board.';
const wfound = [];                     // what the fake watch source reports
const watchPolls = { n: 0 };
const watchSrc = { name: 'watch', poll: async () => { watchPolls.n++; return wfound.map((e) => ({ ...e })); }, health: () => 'ok' };
const github = { name: 'github', poll: async () => found.map((e) => ({ ...e })), health: () => 'ok' };
const broken1 = { name: 'broken1', poll: () => Promise.reject(new Error('source down')), health: () => 'error: down' };
const broken2 = { name: 'broken2', poll: () => { throw new Error('sync throw'); }, health: () => 'error: down' };
let evN = 0;
const ev = (title, extra = {}) => ({ id: 'fake:' + ++evN, source: 'github', kind: 'issue', title, detail: 'detail of ' + title, ts: new Date().toISOString(), sample: true, ...extra });

const profiles = {};                   // the profile text the scorer was given, by event title
const jev = {
  health: () => 'ok',
  score: async (e, p) => {
    profiles[e.title] = p;
    if (/JEVFAIL/.test(e.title)) throw new Error('jev down');
    if (/U95/.test(e.title)) return { decision: 'call', urgency: 0.95, reason: 'Very urgent.', by: 'jev', ms: 1 };
    if (/U80/.test(e.title)) return { decision: 'call', urgency: 0.8, reason: 'Fairly urgent.', by: 'jev', ms: 1 };
    if (/URGENT/.test(e.title)) return { decision: 'call', urgency: 0.9, reason: 'It is urgent.', by: 'jev', ms: 1 };
    if (/IGNORE/.test(e.title)) return { decision: 'ignore', urgency: 0.05, reason: 'Noise.', by: 'rules', ms: 1 };
    return { decision: 'brief', urgency: 0.2, reason: 'Can wait.', by: 'rules', ms: 1 };
  },
};
const exaCalls = [];
const exa = {
  health: () => 'ok',
  context: async (e) => {
    exaCalls.push(e.title);
    await sleep(40);
    if (/EXAFAIL/.test(e.title)) throw new Error('exa down');
    return { answer: 'Web says: ' + e.title, sources: [{ title: 'A page', url: 'https://example.com' }] };
  },
};

const placed = [];   // every vapi.call payload
const syncs = [];
const outcomes = []; // queued outcomes for the next calls that end
const vapi = {
  health: () => 'mock',
  call: async (p) => { placed.push({ ...p, polls: 0 }); return { ok: true, callId: 'v' + placed.length, mock: true }; },
  result: async (id) => {
    const c = placed[Number(id.slice(1)) - 1];
    c.polls++;
    if (c.polls === 1) return { status: 'ringing' };
    if (c.polls === 2) return { status: 'in-progress' };
    if (!c.outcome) c.outcome = outcomes.shift() || { acknowledged: true, callbackAt: null, callbackTopic: null, noteToSelf: null };
    return { status: 'ended', endedReason: 'hangup', summary: 'Talked it through.', outcome: c.outcome };
  },
  syncInbound: async (b) => { syncs.push(b); return { ok: true }; },
};

// Fake orders module: records what it was asked, and `check` answers whatever checkAnswer holds
const orderRuns = [], orderChecks = [];
let checkAnswer = null;
const ordersFake = {
  describe: (a) => String(a).replace(/_/g, ' ').replace(/^rerun build$/, 'rerun the build'),
  run: async (o, e) => {
    orderRuns.push({ action: o.action, text: o.text, eventId: e ? e.id : null });
    await sleep(o.text === 'HANG' ? 800 : 20);
    return { ok: true, result: 'Fake did ' + o.action + '.', simulated: false, ref: o.action === 'rerun_build' ? { kind: 'run', repo: 'a/b', id: 1 } : null };
  },
  check: async (o) => { orderChecks.push(o.id); return checkAnswer; },
};

const notes = [], pushes = [], notices = [];
const timing = { firstPollMs: 20, callPollMs: 30, dueMs: 40, saveMs: 30, ctxWaitMs: 300, syncMs: 100, sourceMs: 500 };
const build = () => createChief({
  appDataDir: tmp, profile: () => profileNow,
  addNote: (n) => notes.push(n), onState: (s) => pushes.push(s), notify: (t, b) => notices.push([t, b]), log: () => {},
  mods: { cfg, sources: [broken1, broken2, github, watchSrc], jev, exa, vapi, orders: ordersFake }, timing,
});
const find = (chief, title) => chief.state().events.find((e) => e.title === title);

async function main() {
  // 1. A fresh install: what the first poll finds is shown but never rings the phone
  found.push(ev('URGENT old build failure'), ev('LOW old typo'));
  let chief = build();
  chief.start();
  await waitFor(() => chief.state().events.length === 2, 'first poll');
  await sleep(300);
  assert.strictEqual(placed.length, 0, 'old news must not trigger a call');
  assert.ok(chief.state().events.every((e) => e.status === 'briefed' && e.score), 'old events shown, scored, briefed');
  assert.strictEqual(chief.state().health.github, 'ok');
  assert.strictEqual(chief.state().health.vapi, 'mock');
  assert.strictEqual(chief.state().settings.myPhoneSet, true);
  assert.ok(pushes.length > 0, 'state was pushed');

  // 2. A later urgent event causes exactly one call and ends up 'called' with the summary
  found.push(ev('URGENT keys leaked'));
  await waitFor(() => placed.length === 1, 'the call');
  assert.ok(placed[0].briefing.includes('URGENT keys leaked'), 'title in the briefing');
  assert.ok(placed[0].briefing.includes('Web says: URGENT keys leaked'), 'context in the briefing');
  assert.ok(placed[0].briefing.includes('solo developer'), 'profile in the briefing');
  assert.ok(placed[0].firstMessage.split(/\s+/).length < 30 && placed[0].firstMessage.startsWith("Hi, it's your desk."), 'first message: ' + placed[0].firstMessage);
  assert.ok(notices.length >= 1, 'desktop was notified');
  await waitFor(() => find(chief, 'URGENT keys leaked').status === 'called', 'event called');
  const c1 = chief.state().calls.find((c) => c.eventIds.length);
  assert.strictEqual(c1.status, 'done');
  assert.strictEqual(c1.summary, 'Talked it through.');
  await sleep(250);
  assert.strictEqual(placed.length, 1, 'exactly one call');
  assert.strictEqual(find(chief, 'URGENT keys leaked').context.answer, 'Web says: URGENT keys leaked', 'context kept on the event');

  // 3. Low urgency is briefed with no call; an ignored one gets no context lookup
  found.push(ev('LOW typo in docs'), ev('IGNORE bot chatter'));
  await waitFor(() => find(chief, 'LOW typo in docs') && find(chief, 'IGNORE bot chatter'), 'low events');
  await sleep(250);
  assert.strictEqual(find(chief, 'LOW typo in docs').status, 'briefed');
  assert.strictEqual(placed.length, 1);
  assert.ok(exaCalls.includes('LOW typo in docs'), 'brief events get context');
  assert.ok(!exaCalls.includes('IGNORE bot chatter'), 'ignored events get no context lookup');
  await waitFor(() => syncs.length >= 1, 'inbound sync');
  assert.ok(syncs.some((s) => s.includes('LOW typo in docs')) || syncs.some((s) => s.includes('Items waiting')), 'inbound briefing lists what waits');

  // 4. Failing jev and exa do not stop the loop, and the broken sources did not either
  found.push(ev('JEVFAIL something odd'), ev('LOW EXAFAIL thing'));
  await waitFor(() => find(chief, 'JEVFAIL something odd') && find(chief, 'LOW EXAFAIL thing'), 'events despite failures');
  assert.strictEqual(find(chief, 'JEVFAIL something odd').score.decision, 'brief', 'jev failure falls back to brief');
  found.push(ev('LOW after failures'));
  await waitFor(() => find(chief, 'LOW after failures'), 'loop still running');

  // 5. Raising the threshold above the urgency stops the call
  assert.deepStrictEqual(await chief.action({ type: 'set_threshold', value: 5 }), { ok: true, threshold: 1 });
  assert.strictEqual(vals.threshold, 1, 'clamped and saved');
  found.push(ev('URGENT but threshold high'));
  await waitFor(() => find(chief, 'URGENT but threshold high'), 'event');
  await sleep(250);
  assert.strictEqual(find(chief, 'URGENT but threshold high').status, 'briefed');
  assert.strictEqual(placed.length, 1, 'no call above threshold');
  await chief.action({ type: 'set_threshold', value: 0.7 });
  assert.strictEqual(chief.state().settings.threshold, 0.7);

  // 6. A call back requested on the call leads to a second call with that topic; the note lands without card data
  outcomes.push({ acknowledged: true, callbackAt: new Date(Date.now() + 700).toISOString(), callbackTopic: 'the release build', noteToSelf: 'Rotate keys. Card 4111 1111 1111 1111 was exposed.' });
  found.push(ev('URGENT second problem'));
  await waitFor(() => placed.length === 2, 'second call');
  await waitFor(() => placed.length === 3, 'call back');
  assert.ok(placed[2].briefing.includes('the release build'), 'call back topic in briefing');
  assert.ok(placed[2].firstMessage.includes('the release build'), 'call back says why: ' + placed[2].firstMessage);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].title, 'From your call');
  assert.strictEqual(notes[0].color, 'purple');
  assert.strictEqual(notes[0].category, 'calls');
  assert.ok(!/4111/.test(notes[0].body), 'no card number in the note');
  await waitFor(() => !chief.state().calls.some((c) => c.status === 'ringing' || c.status === 'in-progress'), 'call back finished');

  // A call back time that is unparseable still gets a call (two minutes out)
  outcomes.push({ acknowledged: true, callbackAt: 'sometime soon', callbackTopic: 'soon thing', noteToSelf: null });
  found.push(ev('URGENT third problem'));
  await waitFor(() => placed.length === 4, 'fourth call');
  await waitFor(() => chief.state().calls.some((c) => c.status === 'scheduled' && c.topic === 'soon thing'), 'two-minute call back scheduled');
  const soon = chief.state().calls.find((c) => c.status === 'scheduled' && c.topic === 'soon thing');
  assert.ok(Math.abs(Date.parse(soon.at) - (Date.now() + 120000)) < 15000, 'about two minutes out');
  await chief.action({ type: 'cancel_call', id: soon.id });
  await waitFor(() => !chief.state().calls.some((c) => c.status === 'ringing' || c.status === 'in-progress'), 'quiet');

  // 7. Scheduling places a call when due; cancelling prevents it
  const r1 = await chief.action({ type: 'schedule', inMinutes: 0.01, topic: 'standup' });
  assert.ok(r1.ok);
  await waitFor(() => placed.length === 5, 'scheduled call');
  assert.ok(placed[4].briefing.includes('standup') && placed[4].firstMessage.includes('standup'));
  await waitFor(() => !chief.state().calls.some((c) => c.status === 'ringing' || c.status === 'in-progress'), 'quiet');
  const r2 = await chief.action({ type: 'schedule', inMinutes: 0.02, topic: 'never happens' });
  assert.ok((await chief.action({ type: 'cancel_call', id: r2.id })).ok);
  await sleep(1500);
  assert.strictEqual(placed.length, 5, 'cancelled call was not placed');
  assert.strictEqual((await chief.action({ type: 'schedule', topic: 'x' })).ok, false, 'schedule needs a time');
  assert.strictEqual((await chief.action({ type: 'nonsense' })).ok, false);

  // 8. The hourly cap holds
  vals.maxCallsPerHour = 6; // five placed so far
  found.push(ev('URGENT cap one'));
  await waitFor(() => placed.length === 6, 'sixth call');
  await waitFor(() => !chief.state().calls.some((c) => c.status === 'ringing' || c.status === 'in-progress'), 'quiet');
  found.push(ev('URGENT cap two'));
  await waitFor(() => find(chief, 'URGENT cap two'), 'cap event');
  await sleep(400);
  assert.strictEqual(placed.length, 6, 'cap holds');
  assert.strictEqual(find(chief, 'URGENT cap two').status, 'new', 'held back, still waiting');
  assert.strictEqual((await chief.action({ type: 'call_now' })).ok, false, 'call_now respects the cap');
  await chief.action({ type: 'dismiss', eventId: find(chief, 'URGENT cap two').id });
  assert.strictEqual(find(chief, 'URGENT cap two').status, 'dismissed');

  // 9. State survives stop and a fresh start, with no new calls about old events
  const before = chief.state();
  chief.stop();
  assert.ok(fs.existsSync(path.join(tmp, 'cos-state.json')), 'state file written');
  vals.maxCallsPerHour = 99; // so the cap is not the reason nothing is called
  chief = build();
  chief.start();
  await sleep(500);
  assert.strictEqual(placed.length, 6, 'no repeat calls after restart');
  const after = chief.state();
  assert.strictEqual(after.events.length, before.events.length, 'events survived');
  assert.strictEqual(after.calls.filter((c) => c.status === 'done').length, before.calls.filter((c) => c.status === 'done').length, 'calls survived');
  assert.ok(after.events.some((e) => e.title === 'URGENT keys leaked' && e.status === 'called'));

  // 10. call_now with an event, then every demo scenario
  const target = find(chief, 'LOW typo in docs');
  const cn = await chief.action({ type: 'call_now', eventId: target.id });
  assert.ok(cn.ok, JSON.stringify(cn));
  assert.ok(placed[6].briefing.includes('LOW typo in docs'), 'call_now ignores the threshold');
  assert.strictEqual((await chief.action({ type: 'call_now', eventId: target.id })).ok, false, 'one call at a time');
  await waitFor(() => !chief.state().calls.some((c) => c.status === 'ringing' || c.status === 'in-progress'), 'quiet');
  for (const scenario of ['typo', 'leak', 'build', 'charge']) {
    const n = chief.state().events.length;
    const r = await chief.action({ type: 'demo', scenario });
    assert.ok(r.ok, scenario);
    const e = chief.state().events.find((x) => x.id === r.id);
    assert.ok(e && chief.state().events.length === n + 1 && e.source === 'demo' && e.sample === true && e.title && e.ts, 'demo ' + scenario);
  }
  assert.strictEqual((await chief.action({ type: 'demo', scenario: 'nope' })).ok, false);

  // 11. Orders given on a call
  const idle = () => !chief.state().calls.some((c) => c.status === 'ringing' || c.status === 'in-progress');
  const orderOf = (id) => chief.state().orders.find((o) => o.id === id);
  const newest = () => chief.state().orders[0];
  const callWith = async (title, orderList, extra = {}) => {
    const n = placed.length, k = chief.state().orders.length;
    outcomes.push({ acknowledged: true, callbackAt: null, callbackTopic: null, noteToSelf: null, orders: orderList });
    found.push(ev(title, extra));
    await waitFor(() => placed.length === n + 1, 'call for ' + title);
    await waitFor(idle, 'call ended: ' + title);
    await waitFor(() => chief.state().orders.length >= k + orderList.length, 'orders recorded for ' + title);
    return find(chief, title);
  };
  assert.ok(String(process.env.COS_CONFIG).startsWith(tmp), 'settings live in the temp folder');
  assert.strictEqual(chief.state().orders.length, 0, 'no orders yet');
  assert.strictEqual(chief.state().settings.ordersMode, 'auto');
  assert.strictEqual(chief.state().settings.quietHours, '');

  // auto mode, confirmed: runs at once and ends done with the result
  const evA = await callWith('URGENT build broke', [{ action: 'rerun_build', text: '', confirmed: true }]);
  await waitFor(() => newest().status === 'done', 'auto order done');
  const oA = newest();
  assert.strictEqual(oA.result, 'Fake did rerun_build.');
  assert.strictEqual(oA.simulated, false);
  assert.deepStrictEqual(oA.ref, { kind: 'run', repo: 'a/b', id: 1 });
  assert.ok(oA.eventId === evA.id && oA.title === evA.title && oA.action === 'rerun_build');
  assert.strictEqual(oA.callId, chief.state().calls.find((c) => c.eventIds.includes(evA.id)).id, 'order remembers its call');
  assert.deepStrictEqual(orderRuns, [{ action: 'rerun_build', text: '', eventId: evA.id }], 'asked to run on the first event of the call');
  assert.ok(notices.some((x) => x[1].includes('Fake did rerun_build.')), 'result was announced');

  // auto mode, not confirmed: waits; the board can run one and skip another
  const evB = await callWith('URGENT second build broke', [{ action: 'comment', text: 'looks fine to me', confirmed: false }, { action: 'label_urgent', text: '', confirmed: false }]);
  const oB1 = chief.state().orders.find((o) => o.action === 'comment'), oB2 = chief.state().orders.find((o) => o.action === 'label_urgent');
  assert.ok(oB1 && oB2 && oB1.status === 'waiting' && oB2.status === 'waiting' && oB1.eventId === evB.id);
  await sleep(100);
  assert.strictEqual(orderRuns.length, 1, 'unconfirmed orders do not run');

  // the next call's briefing carries the orders, with the fresher result from check
  checkAnswer = { result: 'The rerun passed.' };
  assert.ok((await chief.action({ type: 'call_now', topic: 'status check' })).ok);
  const brief = placed[placed.length - 1].briefing;
  assert.ok(brief.includes('Orders you gave:'), 'orders section');
  assert.ok(brief.includes('- rerun the build: The rerun passed.'), 'check result replaced the stored one: ' + brief);
  assert.ok(brief.includes('- comment: not done yet') && brief.includes('- label urgent: not done yet'));
  assert.strictEqual(orderOf(oA.id).result, 'The rerun passed.', 'stored result replaced');
  assert.ok(orderChecks.length >= 1 && orderChecks.every((id) => id === oA.id), 'only orders with a ref are checked');
  checkAnswer = null;
  await waitFor(idle, 'quiet');

  assert.ok((await chief.action({ type: 'run_order', id: oB1.id })).ok);
  await waitFor(() => orderOf(oB1.id).status === 'done', 'run_order');
  assert.deepStrictEqual(orderRuns[1], { action: 'comment', text: 'looks fine to me', eventId: evB.id });
  assert.ok((await chief.action({ type: 'skip_order', id: oB2.id })).ok);
  assert.strictEqual(orderOf(oB2.id).status, 'skipped');
  assert.strictEqual(orderRuns.length, 2, 'a skipped order never runs');
  for (const bad of [{ type: 'run_order', id: oB1.id }, { type: 'run_order', id: oB2.id }, { type: 'skip_order', id: oB1.id }, { type: 'run_order', id: 'nope' }, { type: 'skip_order', id: 'nope' }]) {
    const r = await chief.action(bad);
    assert.ok(r.ok === false && typeof r.error === 'string' && r.error, JSON.stringify(bad));
  }

  // 'ask' mode: nothing runs, even a confirmed order; 'off' mode: recorded as skipped
  assert.deepStrictEqual(await chief.action({ type: 'set_orders_mode', value: 'ask' }), { ok: true, ordersMode: 'ask' });
  assert.strictEqual(vals.ordersMode, 'ask', 'saved through cfg.save');
  assert.strictEqual(chief.state().settings.ordersMode, 'ask');
  await callWith('URGENT ask thing', [{ action: 'assign_me', text: '', confirmed: true }]);
  assert.strictEqual(newest().status, 'waiting');
  await chief.action({ type: 'set_orders_mode', value: 'off' });
  await callWith('URGENT off thing', [{ action: 'rerun_build', text: '', confirmed: true }]);
  assert.strictEqual(newest().status, 'skipped');
  await sleep(100);
  assert.strictEqual(orderRuns.length, 2, 'ask and off mode ran nothing');
  const bm = await chief.action({ type: 'set_orders_mode', value: 'sometimes' });
  assert.ok(bm.ok === false && bm.error);
  assert.strictEqual(vals.ordersMode, 'off', 'a bad mode changes nothing');

  // the board's own order: waits in off mode, runs at once otherwise
  const bo = await chief.action({ type: 'order', action: 'close_issue', eventId: evA.id });
  assert.ok(bo.ok && orderOf(bo.id).status === 'waiting' && orderOf(bo.id).callId === null);
  assert.ok((await chief.action({ type: 'run_order', id: bo.id })).ok);
  await waitFor(() => orderOf(bo.id).status === 'done', 'board order run by hand');
  assert.strictEqual(orderRuns[2].eventId, evA.id);
  await chief.action({ type: 'set_orders_mode', value: 'auto' });
  const bo2 = await chief.action({ type: 'order', action: 'create_issue', text: 'write the tests' });
  assert.ok(bo2.ok);
  await waitFor(() => orderOf(bo2.id).status === 'done', 'board order');
  assert.deepStrictEqual(orderRuns[3], { action: 'create_issue', text: 'write the tests', eventId: null });
  for (const bad of [{ type: 'order', action: 'merge_pr' }, { type: 'order' }, { type: 'order', action: 'close_issue', eventId: 'nope' }]) {
    const r = await chief.action(bad);
    assert.ok(r.ok === false && r.error, JSON.stringify(bad));
  }
  const nm = await chief.action({ type: 'order', action: 'mute_similar' });
  await waitFor(() => orderOf(nm.id).status === 'failed', 'mute with no target fails');
  assert.ok(/no event/.test(orderOf(nm.id).result) && chief.state().mutes.length === 0);

  // mute_similar: later events of the kind never call, and unmute brings calling back
  const evM = await callWith('URGENT mention one', [{ action: 'mute_similar', text: '', confirmed: true }], { kind: 'mention' });
  await waitFor(() => chief.state().mutes.length === 1, 'mute added');
  const mute1 = chief.state().mutes[0];
  assert.ok(mute1.id && mute1.source === 'github' && mute1.kind === 'mention' && mute1.label === 'github mentions' && mute1.at);
  assert.strictEqual(newest().status, 'done');
  assert.strictEqual(newest().result, "I won't call about github mentions again. They'll still show on the board.");
  const nBefore = placed.length;
  found.push(ev('URGENT mention two', { kind: 'mention' }));
  await waitFor(() => find(chief, 'URGENT mention two'), 'muted event shown');
  await sleep(300);
  const m2 = find(chief, 'URGENT mention two');
  assert.ok(m2.score.decision === 'brief' && m2.score.urgency === 0.9 && m2.status === 'briefed', 'capped at brief, still scored');
  assert.ok(m2.score.reason.endsWith(' Muted by you.'), m2.score.reason);
  assert.strictEqual(placed.length, nBefore, 'a muted event places no call');
  await chief.action({ type: 'order', action: 'mute_similar', eventId: evM.id });
  await sleep(100);
  assert.strictEqual(chief.state().mutes.length, 1, 'no duplicate mutes');
  // an event already waiting to call is capped when its kind is muted
  vals.maxCallsPerHour = 1; // hold the call back
  found.push(ev('URGENT review waiting', { kind: 'review_request' }));
  await waitFor(() => find(chief, 'URGENT review waiting'), 'waiting event');
  await sleep(100);
  const w = find(chief, 'URGENT review waiting');
  assert.ok(w.status === 'new' && w.score.decision === 'call', 'held back by the cap');
  const wm = await chief.action({ type: 'order', action: 'mute_similar', eventId: w.id });
  await waitFor(() => orderOf(wm.id).status === 'done', 'second mute');
  assert.ok(chief.state().mutes.length === 2 && find(chief, w.title).status === 'briefed' && find(chief, w.title).score.decision === 'brief' && find(chief, w.title).score.reason.endsWith(' Muted by you.'));
  vals.maxCallsPerHour = 99;
  await sleep(300);
  assert.strictEqual(placed.length, nBefore, 'the capped waiting event is not called later');
  assert.strictEqual((await chief.action({ type: 'unmute', id: 'nope' })).ok, false);
  assert.ok((await chief.action({ type: 'unmute', id: mute1.id })).ok);
  assert.strictEqual(chief.state().mutes.length, 1);
  found.push(ev('URGENT mention three', { kind: 'mention' }));
  await waitFor(() => placed.length === nBefore + 1, 'calling again after unmute');
  assert.ok(placed[nBefore].briefing.includes('URGENT mention three'));
  await waitFor(idle, 'quiet');

  // 12. Quiet hours: inside them only urgency 0.9 and up places the call; local time, may wrap
  const hhmm = (m) => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const m0 = new Date().getHours() * 60 + new Date().getMinutes();
  vals.quietHours = hhmm(m0 - 30) + '-' + hhmm(m0 + 30);
  assert.strictEqual(chief.state().settings.quietHours, vals.quietHours);
  let n12 = placed.length;
  found.push(ev('U80 held at night'));
  await waitFor(() => find(chief, 'U80 held at night'), 'quiet event');
  await sleep(300);
  assert.ok(placed.length === n12 && find(chief, 'U80 held at night').status === 'briefed', 'a 0.8 event waits during quiet hours');
  found.push(ev('U95 wakes you'));
  await waitFor(() => placed.length === n12 + 1, 'urgent call in quiet hours');
  await waitFor(idle, 'quiet');
  assert.ok((await chief.action({ type: 'call_now', topic: 'any time' })).ok, 'call_now ignores quiet hours');
  await waitFor(idle, 'quiet');
  n12 = placed.length;
  vals.quietHours = hhmm(m0 + 60) + '-' + hhmm(m0 - 60); // wraps past midnight, and now is outside it
  found.push(ev('U80 in the daytime'));
  await waitFor(() => placed.length === n12 + 1, 'call outside quiet hours');
  await waitFor(idle, 'quiet');
  for (const off of ['banana', '25:00-07:00', '12:00-12:00', '']) {
    vals.quietHours = off; n12 = placed.length;
    found.push(ev('U80 unparseable ' + (off || 'empty')));
    await waitFor(() => placed.length === n12 + 1, 'quiet hours off for ' + JSON.stringify(off));
    await waitFor(idle, 'quiet');
  }

  // 13. Orders and mutes survive a stop and reload; an order left running becomes failed
  const hang = await chief.action({ type: 'order', action: 'comment', text: 'HANG' });
  assert.ok(hang.ok && orderOf(hang.id).status === 'running');
  const pre = chief.state();
  chief.stop();
  chief = build();
  chief.start();
  await sleep(300);
  const post = chief.state();
  assert.deepStrictEqual(post.orders.map((o) => o.id), pre.orders.map((o) => o.id), 'orders survived');
  assert.deepStrictEqual(post.mutes, pre.mutes, 'mutes survived');
  assert.deepStrictEqual(post.orders.find((o) => o.id === oA.id), pre.orders.find((o) => o.id === oA.id), 'a finished order is unchanged, ref included');
  assert.ok(orderOf(hang.id).status === 'failed' && orderOf(hang.id).result === 'Interrupted by a restart.');
  const n13 = placed.length;
  found.push(ev('U95 muted again', { kind: 'review_request' }));
  await waitFor(() => find(chief, 'U95 muted again'), 'event after reload');
  await sleep(300);
  assert.ok(find(chief, 'U95 muted again').score.decision === 'brief' && placed.length === n13, 'the mute still applies after a reload');

  // 14. The order list is capped at 30, newest first
  await chief.action({ type: 'set_orders_mode', value: 'off' });
  for (let i = 0; i < 35; i++) await chief.action({ type: 'order', action: 'assign_me', text: 'n' + i });
  assert.strictEqual(chief.state().orders.length, 30);
  assert.strictEqual(chief.state().orders[0].text, 'n34');
  // 15. "Try to fool it": any event typed in your own words
  await chief.action({ type: 'set_orders_mode', value: 'auto' });
  const n15 = placed.length;
  const cu = await chief.action({ type: 'custom', text: '  U80 my own words about a thing  ' });
  assert.ok(cu.ok && /^custom:/.test(cu.id), JSON.stringify(cu));
  const cuE = chief.state().events.find((e) => e.id === cu.id);
  assert.ok(cuE && cuE.source === 'custom' && cuE.kind === 'custom' && cuE.sample === true && cuE.title === 'U80 my own words about a thing' && cuE.detail === 'U80 my own words about a thing' && cuE.ts, 'custom event shape');
  await waitFor(() => placed.length === n15 + 1, 'call for the custom event');
  assert.ok(placed[n15].briefing.includes('U80 my own words about a thing'));
  await waitFor(idle, 'quiet');
  const cu2 = await chief.action({ type: 'custom', text: 'plain custom words' });
  assert.ok(cu2.ok && cu2.id !== cu.id);
  await sleep(300);
  const cuE2 = chief.state().events.find((e) => e.id === cu2.id);
  assert.ok(cuE2 && cuE2.status === 'briefed' && cuE2.score.decision === 'brief', 'below the threshold it only shows in the feed');
  assert.strictEqual(placed.length, n15 + 1, 'no call for the quiet custom event');
  const cu3 = await chief.action({ type: 'custom', text: 'plain custom words' });
  assert.ok(cu3.ok && cu3.id !== cu2.id && chief.state().events.filter((e) => e.title === 'plain custom words').length === 2, 'the same words twice are two events');
  for (const bad of [{ type: 'custom' }, { type: 'custom', text: 'ab' }, { type: 'custom', text: '   a   ' }, { type: 'custom', text: 'x'.repeat(301) }, { type: 'custom', text: 42 }]) {
    const r = await chief.action(bad);
    assert.ok(r.ok === false && r.error, JSON.stringify(bad));
  }
  const nEv = chief.state().events.length;
  assert.ok((await chief.action({ type: 'custom', text: 'abc' })).ok, '3 characters are fine');
  assert.ok((await chief.action({ type: 'custom', text: 'y'.repeat(300) })).ok, '300 characters are fine');
  assert.strictEqual(chief.state().events.length, nEv + 2);
  assert.strictEqual(chief.state().events[0].title.length, 140, 'title cut to 140');
  assert.strictEqual(chief.state().events[0].detail.length, 300, 'detail keeps the whole text');

  // 16. Watching the web: baseline events show but never ring; a later fresh one does
  assert.ok(chief.state().settings.watches.length === 0 && chief.state().health.watch === 'ok' && chief.state().settings.dailyBriefing === '', 'new state fields');
  const wev = (title, extra = {}) => ({ id: 'watch:' + ++evN, source: 'watch', kind: 'news', topic: 'OpenAI API pricing', title, detail: 'detail of ' + title, ts: new Date().toISOString(), sample: false, ...extra });
  const n16 = placed.length;
  wfound.push(wev('U95 old pricing story', { baseline: true }), wev('LOW old other story', { baseline: true }));
  await waitFor(() => find(chief, 'U95 old pricing story') && find(chief, 'LOW old other story'), 'baseline events shown');
  await sleep(300);
  const bl = find(chief, 'U95 old pricing story');
  assert.ok(bl.baseline === true && bl.topic === 'OpenAI API pricing' && bl.score.decision === 'brief' && bl.score.urgency === 0.95 && bl.status === 'briefed', 'baseline event capped at brief');
  assert.ok(bl.score.reason.endsWith(' Already out when you started watching.'), bl.score.reason);
  assert.strictEqual(find(chief, 'LOW old other story').score.decision, 'brief');
  assert.strictEqual(placed.length, n16, 'baseline events place no call');
  wfound.push(wev('U95 fresh pricing story'));
  await waitFor(() => placed.length === n16 + 1, 'call for a fresh watch event');
  assert.ok(placed[n16].briefing.includes('U95 fresh pricing story') && !find(chief, 'U95 fresh pricing story').baseline);
  await waitFor(idle, 'quiet');

  // add_watch / remove_watch
  assert.deepStrictEqual(await chief.action({ type: 'add_watch', topic: '  OpenAI   API pricing  ' }), { ok: true, topic: 'OpenAI API pricing' });
  assert.deepStrictEqual(vals.watches, ['OpenAI API pricing'], 'saved through cfg.save');
  assert.deepStrictEqual(chief.state().settings.watches, ['OpenAI API pricing']);
  for (const bad of [{ type: 'add_watch', topic: 'openai api PRICING' }, { type: 'add_watch', topic: 'ab' }, { type: 'add_watch', topic: '    ' }, { type: 'add_watch', topic: 'z'.repeat(121) }, { type: 'add_watch' }, { type: 'add_watch', topic: 7 }, { type: 'remove_watch', topic: 'never added' }, { type: 'remove_watch' }]) {
    const r = await chief.action(bad);
    assert.ok(r.ok === false && r.error, JSON.stringify(bad));
  }
  assert.deepStrictEqual(vals.watches, ['OpenAI API pricing'], 'bad input saves nothing');
  assert.ok((await chief.action({ type: 'add_watch', topic: 'z'.repeat(120) })).ok, '120 characters are fine');
  for (const t of ['topic two', 'topic three', 'topic four']) assert.ok((await chief.action({ type: 'add_watch', topic: t })).ok, t);
  assert.strictEqual(chief.state().settings.watches.length, 5);
  const six = await chief.action({ type: 'add_watch', topic: 'topic six' });
  assert.ok(six.ok === false && /5/.test(six.error) && vals.watches.length === 5, 'at most 5 topics');
  assert.ok((await chief.action({ type: 'remove_watch', topic: 'TOPIC TWO' })).ok, 'remove ignores case');
  assert.deepStrictEqual(chief.state().settings.watches, ['OpenAI API pricing', 'z'.repeat(120), 'topic three', 'topic four']);
  assert.ok((await chief.action({ type: 'add_watch', topic: 'topic six' })).ok, 'room again after a removal');
  vals.watches = [];
  assert.deepStrictEqual(chief.state().settings.watches, []);

  // 17. Feedback: set, cleared, reaches the scorer, and a pattern of 'bad' takes 0.15 off
  const fbA = await callWith('U95 call about the fb thing', [], { kind: 'fbkind' });
  assert.ok(fbA && fbA.status === 'called');
  await sleep(5);
  assert.deepStrictEqual(await chief.action({ type: 'feedback', eventId: fbA.id, value: 'bad' }), { ok: true });
  assert.strictEqual(find(chief, fbA.title).feedback, 'bad');
  found.push(ev('LOW probe one'));
  await waitFor(() => profiles['LOW probe one'] !== undefined, 'probe scored');
  assert.ok(profiles['LOW probe one'].startsWith('Goutham, solo developer') && profiles['LOW probe one'].endsWith('The user said a call about "U95 call about the fb thing" was not worth it.'), profiles['LOW probe one']);
  await chief.action({ type: 'feedback', eventId: fbA.id, value: 'good' });
  found.push(ev('LOW probe two'));
  await waitFor(() => profiles['LOW probe two'] !== undefined, 'probe two scored');
  assert.ok(profiles['LOW probe two'].endsWith('The user said a call about "U95 call about the fb thing" was worth it.'), profiles['LOW probe two']);
  assert.deepStrictEqual(await chief.action({ type: 'feedback', eventId: fbA.id, value: null }), { ok: true });
  assert.strictEqual(find(chief, fbA.title).feedback, undefined, 'cleared');
  found.push(ev('LOW probe three'));
  await waitFor(() => profiles['LOW probe three'] !== undefined, 'probe three scored');
  assert.ok(!/The user said/.test(profiles['LOW probe three']), 'no feedback, no lines');
  for (const bad of [{ type: 'feedback', eventId: 'nope', value: 'bad' }, { type: 'feedback', eventId: fbA.id, value: 'meh' }, { type: 'feedback', eventId: fbA.id }]) {
    const r = await chief.action(bad);
    assert.ok(r.ok === false && r.error, JSON.stringify(bad));
  }
  assert.strictEqual(find(chief, fbA.title).feedback, undefined);
  // one 'bad' is not yet a pattern; two are
  await chief.action({ type: 'feedback', eventId: fbA.id, value: 'bad' });
  const nFb = placed.length;
  found.push(ev('U80 fb before the pattern', { kind: 'fbkind' }));
  await waitFor(() => placed.length === nFb + 1, 'no penalty after one bad');
  await waitFor(idle, 'quiet');
  const fbB = find(chief, 'U80 fb before the pattern');
  assert.ok(fbB.score.urgency === 0.8 && !/weren't worth it/.test(fbB.score.reason), 'one bad changes nothing');
  await sleep(5);
  await chief.action({ type: 'feedback', eventId: fbB.id, value: 'bad' });
  found.push(ev('U80 fb after the pattern', { kind: 'fbkind' }));
  await waitFor(() => find(chief, 'U80 fb after the pattern'), 'penalised event');
  await sleep(300);
  const fbC = find(chief, 'U80 fb after the pattern');
  assert.strictEqual(fbC.score.urgency, 0.65, 'taken 0.15 off');
  assert.ok(fbC.score.reason.endsWith(" You said calls like this weren't worth it."), fbC.score.reason);
  assert.ok(fbC.score.decision === 'call' && fbC.status === 'briefed' && placed.length === nFb + 1, 'now under the threshold: no call');
  assert.strictEqual(find(chief, fbB.title).score.urgency, 0.8, 'old events are not rescored');
  found.push(ev('U80 other kind'));
  await waitFor(() => placed.length === nFb + 2, 'other kinds are not penalised');
  await waitFor(idle, 'quiet');
  assert.strictEqual(find(chief, 'U80 other kind').score.urgency, 0.8);
  // the penalty never goes below 0
  await chief.action({ type: 'feedback', eventId: fbC.id, value: 'bad' });
  found.push(ev('IGNORE fb floor', { kind: 'fbkind' }));
  await waitFor(() => find(chief, 'IGNORE fb floor'), 'floor event');
  assert.strictEqual(find(chief, 'IGNORE fb floor').score.urgency, 0, 'not below 0');
  // the feedback lines stay inside the profile cap, feedback last, most recent first
  profileNow = 'p'.repeat(900);
  for (let i = 0; i < 7; i++) {
    const r = await chief.action({ type: 'custom', text: i + ' ' + 'long title '.repeat(20) });
    await sleep(5);
    await chief.action({ type: 'feedback', eventId: r.id, value: i % 2 ? 'good' : 'bad' });
  }
  found.push(ev('LOW probe long'));
  await waitFor(() => profiles['LOW probe long'] !== undefined, 'long probe scored');
  const lp = profiles['LOW probe long'], lines = lp.split('\n');
  assert.ok(lp.length <= 800 && lp.startsWith('pppp'), 'profile cap: ' + lp.length);
  const fbl = lines.filter((l) => /^The user said a call about "/.test(l));
  assert.ok(fbl.length >= 1 && fbl.length <= 6 && lines.slice(-fbl.length).every((l) => /^The user said/.test(l)), 'feedback lines come last');
  assert.ok(fbl[0].includes('"6 long title') && fbl[0].endsWith('was not worth it.'), 'most recent first: ' + fbl[0]);
  profileNow = 'Goutham, solo developer, owns desk-board.';

  // 18. Daily briefing, on an injected clock
  const dir18 = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-daily-'));
  let clock = new Date(2030, 0, 15, 10, 0, 0).getTime();
  const buildAt = () => createChief({
    appDataDir: dir18, profile: () => '', addNote: () => {}, onState: () => {}, notify: () => {}, log: () => {}, now: () => clock,
    mods: { cfg, sources: [], jev, exa, vapi, orders: ordersFake }, timing,
  });
  vals.maxCallsPerHour = 99; vals.watches = [];
  let d = buildAt();
  d.start();
  const dailies = () => d.state().calls.filter((c) => c.daily);
  const sched = () => dailies().filter((c) => c.status === 'scheduled');
  const at = (c) => { const t = new Date(c.at); return [t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds()]; };
  const dIdle = () => !d.state().calls.some((c) => c.status === 'ringing' || c.status === 'in-progress');
  assert.strictEqual(sched().length, 0, 'off by default');
  assert.deepStrictEqual(await d.action({ type: 'set_daily', value: '9:00' }), { ok: true, dailyBriefing: '09:00' });
  assert.strictEqual(vals.dailyBriefing, '09:00');
  assert.strictEqual(d.state().settings.dailyBriefing, '09:00');
  assert.strictEqual(sched().length, 1);
  assert.deepStrictEqual(at(sched()[0]), [2030, 0, 16, 9, 0, 0], 'already past today: tomorrow');
  assert.ok(sched()[0].topic === 'Your daily briefing' && sched()[0].daily === true && sched()[0].eventIds.length === 0);
  await d.action({ type: 'set_daily', value: '09:00' });
  assert.strictEqual(sched().length, 1, 'setting the same time does not double it');
  await d.action({ type: 'set_daily', value: '11:30' });
  assert.strictEqual(dailies().length, 1, 'changing replaces the pending one');
  assert.deepStrictEqual(at(sched()[0]), [2030, 0, 15, 11, 30, 0], 'still ahead today');
  await d.action({ type: 'set_daily', value: '' });
  assert.strictEqual(dailies().length, 0, 'cleared');
  assert.strictEqual(d.state().settings.dailyBriefing, '');
  for (const bad of [{ value: '25:00' }, { value: '9:75' }, { value: 'banana' }, { value: '0930' }, { value: 5 }]) {
    const r = await d.action({ type: 'set_daily', ...bad });
    assert.ok(r.ok === false && r.error, JSON.stringify(bad));
  }
  assert.strictEqual(vals.dailyBriefing, '', 'bad input saves nothing');
  await d.action({ type: 'set_daily', value: '11:30' });
  const dId = sched()[0].id;
  // a stop and reload does not schedule a second one
  d.stop(); d = buildAt(); d.start();
  assert.ok(sched().length === 1 && sched()[0].id === dId, 'no double after a reload');
  d.stop(); d = buildAt(); d.start(); d.stop(); d = buildAt(); d.start();
  assert.strictEqual(sched().length, 1);
  // custom works on a fresh install too: nothing has polled, and it is still not old news
  const n18 = placed.length;
  assert.ok((await d.action({ type: 'custom', text: 'U80 typed on a fresh install' })).ok);
  await waitFor(() => placed.length === n18 + 1, 'custom call on a fresh install');
  await waitFor(dIdle, 'quiet');
  // it comes due: placed, and the next one is scheduled for tomorrow
  clock = new Date(2030, 0, 15, 11, 31, 0).getTime();
  await waitFor(() => placed.length === n18 + 2, 'the daily call');
  assert.ok(placed[n18 + 1].briefing.includes('Your daily briefing') && /daily briefing/.test(placed[n18 + 1].firstMessage), placed[n18 + 1].firstMessage);
  assert.ok(dailies().find((c) => c.id === dId).status !== 'scheduled');
  assert.strictEqual(sched().length, 1, 'exactly one next call');
  assert.ok(sched()[0].id !== dId);
  assert.deepStrictEqual(at(sched()[0]), [2030, 0, 16, 11, 30, 0]);
  await waitFor(dIdle, 'quiet');
  await sleep(250);
  assert.strictEqual(placed.length, n18 + 2, 'only one daily call placed');
  // it counts toward the hourly cap like any scheduled call (the custom call was 90 fake minutes ago)
  vals.maxCallsPerHour = 1;
  const cap = await d.action({ type: 'call_now' });
  assert.ok(cap.ok === false && /limit/.test(cap.error), 'the daily call used up the hour');
  vals.maxCallsPerHour = 99;
  // cancelling it schedules the one after, not the same slot again
  assert.ok((await d.action({ type: 'cancel_call', id: sched()[0].id })).ok);
  assert.strictEqual(sched().length, 1);
  assert.deepStrictEqual(at(sched()[0]), [2030, 0, 17, 11, 30, 0], 'the day after the cancelled one');
  // closed for days: the missed one is marked failed and only one new one exists
  d.stop();
  clock = new Date(2030, 0, 20, 8, 0, 0).getTime();
  d = buildAt(); d.start();
  assert.strictEqual(sched().length, 1);
  assert.deepStrictEqual(at(sched()[0]), [2030, 0, 20, 11, 30, 0]);
  assert.ok(dailies().some((c) => c.status === 'failed' && /Missed/.test(c.summary)), 'the missed one is recorded');
  d.stop();
  fs.rmSync(dir18, { recursive: true, force: true });
  vals.dailyBriefing = '';

  chief.stop();
  console.log(`core tests passed (${placed.length} calls, ${pushes.length} state pushes, ${orderRuns.length} orders run)`);
}

// ---- optional: the real modules with no keys ----
async function real() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-real-'));
  // repos: [] so the github source does not touch the network
  fs.writeFileSync(process.env.COS_CONFIG, JSON.stringify({ repos: [], pollSeconds: 3 }));
  const chief = createChief({ appDataDir: dir, profile: () => '', addNote: (n) => console.log('note:', n.title), onState: () => {}, notify: (t, b) => console.log('notify:', t, '|', b), log: (m) => console.log('log:', m) });
  chief.start();
  console.log('demo leak ->', JSON.stringify(await chief.action({ type: 'demo', scenario: 'leak' })));
  await sleep(8000);
  console.log(JSON.stringify(chief.state(), null, 2));
  chief.stop();

  // The 'order' demo: the simulated call comes back with a confirmed rerun, carried out as a simulation
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-real-'));
  const chief2 = createChief({ appDataDir: dir2, profile: () => '', onState: () => {}, log: (m) => console.log('log:', m) });
  chief2.start();
  const d = await chief2.action({ type: 'demo', scenario: 'order' });
  assert.ok(d.ok, 'order demo');
  await waitFor(() => chief2.state().orders.length && chief2.state().orders[0].status !== 'running', 'the demo order', 30000);
  const o = chief2.state().orders[0];
  console.log('demo order ->', JSON.stringify(o));
  assert.ok(o.status === 'done' && o.simulated === true && /^Simulated:/.test(o.result) && o.action === 'rerun_build' && o.eventId === d.id, 'demo order ends simulated');
  chief2.stop();
  fs.rmSync(dir2, { recursive: true, force: true });
}

(async () => {
  await main();
  if (process.argv.includes('--real')) await real();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
