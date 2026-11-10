// Tests for cos/vapi.js. Plain node; exits non-zero on failure.
//   node cos/test-vapi.js                 mock mode, helpers, stubbed fetch
//   node cos/test-vapi.js --live          also read from Vapi with the real settings file
//   node cos/test-vapi.js --live --call   also place one real 5-minute-capped call to myPhone
const os = require('os');
const path = require('path');
const assert = require('assert');

const LIVE = process.argv.includes('--live');
if (!LIVE) process.env.COS_CONFIG = path.join(os.tmpdir(), 'cos-test-nonexistent-' + process.pid + '.json');
else if (!process.env.COS_CONFIG) { /* default settings file */ }

const realCfg = require('./keys');
const createVapi = require('./vapi');
const { outcomeFrom, scanTranscript, normalizePhone } = createVapi;

let passed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; }
}

(async () => {
  // A clock we control, so mock timing and "today or tomorrow" need no real waiting.
  let clock = new Date(2026, 10, 9, 10, 0, 0).getTime();
  const now = () => clock;
  const quiet = () => {};
  // Mock-mode tests must stay in mock mode under --live, when the real settings file has a key.
  const noKey = () => ({ ...realCfg(), vapiKey: '', vapiPhoneNumberId: '' });

  await t('mock call goes ringing -> in-progress -> ended with an outcome', async () => {
    const v = createVapi({ cfg: noKey, log: quiet, now });
    assert.strictEqual(v.health(), 'mock');
    const c = await v.call({ reason: 'the build failed', briefing: 'main is red' });
    assert.ok(c.ok && c.mock && /^mock-\d+$/.test(c.callId));
    assert.strictEqual((await v.result(c.callId)).status, 'ringing');
    clock += 2000;
    assert.strictEqual((await v.result(c.callId)).status, 'in-progress');
    clock += 3000;
    const r = await v.result(c.callId);
    assert.strictEqual(r.status, 'ended');
    assert.ok(r.summary.includes('the build failed'));
    assert.strictEqual(r.outcome.acknowledged, true);
    assert.strictEqual(r.outcome.callbackAt, null);
    assert.deepStrictEqual(await v.syncInbound('x'), { ok: false, error: 'no key' });
  });

  await t('[mock:callback] marker yields a future callbackAt and topic', async () => {
    const v = createVapi({ cfg: noKey, log: quiet, now });
    const c = await v.call({ reason: 'test [mock:callback]', briefing: '' });
    clock += 5000;
    const r = await v.result(c.callId);
    assert.ok(Date.parse(r.outcome.callbackAt) > clock, 'callback should be after now');
    assert.ok(r.outcome.callbackTopic);
  });

  await t('outcomeFrom: callbackInMinutes 2 is two minutes after the end', () => {
    const end = Date.UTC(2026, 10, 9, 12, 0, 0);
    const o = outcomeFrom({ acknowledged: true, callbackRequested: true, callbackInMinutes: 2, callbackTopic: 'summary' }, '', end);
    assert.strictEqual(Date.parse(o.callbackAt), end + 120000);
    assert.strictEqual(o.callbackTopic, 'summary');
    assert.strictEqual(o.acknowledged, true);
  });

  await t('outcomeFrom: "14:00" is today when ahead, tomorrow when passed', () => {
    const morning = new Date(2026, 10, 9, 10, 0, 0).getTime();
    let o = outcomeFrom({ callbackRequested: true, callbackAtLocalTime: '14:00' }, '', morning);
    let d = new Date(o.callbackAt);
    assert.deepStrictEqual([d.getDate(), d.getHours(), d.getMinutes()], [9, 14, 0]);
    const evening = new Date(2026, 10, 9, 16, 0, 0).getTime();
    o = outcomeFrom({ callbackRequested: true, callbackAtLocalTime: '14:00' }, '', evening);
    d = new Date(o.callbackAt);
    assert.deepStrictEqual([d.getDate(), d.getHours(), d.getMinutes()], [10, 14, 0]);
  });

  await t('outcomeFrom: recovers callbacks from the transcript when structured data is missing', () => {
    const end = Date.UTC(2026, 10, 9, 12, 0, 0);
    let o = outcomeFrom(null, 'AI: Build failed.\nUser: ok can you call me back in two minutes with a summary', end);
    assert.strictEqual(Date.parse(o.callbackAt), end + 120000);
    assert.strictEqual(o.acknowledged, true);
    assert.strictEqual(Date.parse(outcomeFrom({}, 'User: call me in 3 hours', end).callbackAt), end + 3 * 3600000);
    assert.strictEqual(Date.parse(outcomeFrom({}, 'User: call me back in an hour', end).callbackAt), end + 3600000);
    const morning = new Date(2026, 10, 9, 10, 0, 0).getTime();
    o = outcomeFrom({}, 'AI: Sure.\nUser: Please call me at 2 pm about the build.', morning);
    const d = new Date(o.callbackAt);
    assert.deepStrictEqual([d.getDate(), d.getHours(), d.getMinutes()], [9, 14, 0]);
    assert.strictEqual(o.callbackTopic, 'the build');
    const m = scanTranscript('User: call me back at 9:30 am', new Date(2026, 10, 9, 10, 0, 0).getTime());
    const d2 = new Date(m.callbackAt);
    assert.deepStrictEqual([d2.getDate(), d2.getHours(), d2.getMinutes()], [10, 9, 30]);
    // the assistant's own lines must not count
    assert.strictEqual(outcomeFrom({}, 'AI: I can call me back in two minutes', end).callbackAt, null);
    assert.strictEqual(outcomeFrom({}, '', end).acknowledged, false);
  });

  await t('normalizePhone', () => {
    assert.strictEqual(normalizePhone('4155550123'), '+14155550123');
    assert.strictEqual(normalizePhone('(415) 555-0123'), '+14155550123');
    assert.strictEqual(normalizePhone('+44 20 7946 0958'), '+442079460958');
    assert.strictEqual(normalizePhone('12345'), null);
    assert.strictEqual(normalizePhone('+123'), null);
  });

  await t('SCHEMA has the three flat order fields', () => {
    const p = createVapi.SCHEMA.properties;
    assert.strictEqual(p.orderAction.type, 'string');
    assert.strictEqual(p.orderText.type, 'string');
    assert.strictEqual(p.orderConfirmed.type, 'boolean');
    assert.ok(/none/.test(p.orderAction.description) && /rerun_build/.test(p.orderAction.description));
    for (const k of ['orderAction', 'orderText', 'orderConfirmed']) {
      assert.strictEqual(typeof p[k].type, 'string', k + ' is a single plain type');
      assert.ok(!p[k].items && !p[k].properties && !p[k].anyOf && !p[k].oneOf, k + ' is not nested');
      assert.ok(!createVapi.SCHEMA.required.includes(k));
    }
  });

  await t('prompts: outbound lists the orders and stays under the cap; dial-in refuses orders', () => {
    const p = createVapi.outboundPrompt('the build failed', 'word '.repeat(5000), clock);
    assert.ok(p.length <= 6000);
    assert.ok(/order/i.test(p) && /rerun the failed build/.test(p) && /as soon as we hang up/.test(p));
    assert.ok(/repeat the order back/i.test(p) && /merging, deleting, paying/.test(p));
    const i = createVapi.inboundPrompt('x', clock);
    assert.ok(/cannot schedule callbacks or take orders/.test(i));
  });

  await t('outcomeFrom: structured order fields become orders', () => {
    const end = Date.UTC(2026, 10, 9, 12, 0, 0);
    let o = outcomeFrom({ acknowledged: true, orderAction: 'comment', orderText: '  looks like the cache  ', orderConfirmed: true }, '', end);
    assert.deepStrictEqual(o.orders, [{ action: 'comment', text: 'looks like the cache', confirmed: true }]);
    o = outcomeFrom({ acknowledged: true, orderAction: 'label_urgent', orderConfirmed: 'yes' }, '', end);
    assert.deepStrictEqual(o.orders, [{ action: 'label_urgent', text: '', confirmed: false }]);
    o = outcomeFrom({ orderAction: 'create_issue', orderText: 'x'.repeat(900), orderConfirmed: true }, '', end);
    assert.strictEqual(o.orders[0].text.length, 500);
    assert.deepStrictEqual(outcomeFrom({ acknowledged: true, orderAction: 'none', orderText: 'hi', orderConfirmed: true }, '', end).orders, []);
    assert.deepStrictEqual(outcomeFrom({ acknowledged: true, orderAction: 'merge_pr', orderConfirmed: true }, '', end).orders, []);
    assert.deepStrictEqual(outcomeFrom({ acknowledged: true, orderAction: '' }, '', end).orders, []);
    assert.deepStrictEqual(outcomeFrom(null, '', end).orders, []);
  });

  await t('outcomeFrom: transcript safety net finds "rerun" in user lines only', () => {
    const end = Date.UTC(2026, 10, 9, 12, 0, 0);
    const want = [{ action: 'rerun_build', text: '', confirmed: false }];
    for (const say of ['please rerun the build', 'Re-run it', 'can you re run that', 'just run it again', 'run the build again', 'restart the build please']) {
      assert.deepStrictEqual(outcomeFrom({}, 'AI: Build failed.\nUser: ' + say, end).orders, want, say);
    }
    assert.deepStrictEqual(outcomeFrom({ acknowledged: true, orderAction: 'none' }, 'User: rerun it', end).orders, want);
    assert.deepStrictEqual(outcomeFrom({}, 'AI: Want me to rerun the build?\nUser: no thanks', end).orders, []);
    // a structured order wins; the transcript adds nothing
    const o = outcomeFrom({ orderAction: 'close_issue', orderConfirmed: true }, 'User: rerun the build', end);
    assert.deepStrictEqual(o.orders, [{ action: 'close_issue', text: '', confirmed: true }]);
  });

  await t('mock: [mock:order] and [mock:callback] together, and every outcome has orders', async () => {
    const v = createVapi({ cfg: noKey, log: quiet, now });
    const plain = await v.call({ reason: 'plain', briefing: '' });
    const both = await v.call({ reason: 'the build failed. [mock:order]', briefing: '[mock:callback]' });
    const inBriefing = await v.call({ reason: 'x', briefing: 'main is red [mock:order]' });
    clock += 5000;
    const a = await v.result(plain.callId), b = await v.result(both.callId), c = await v.result(inBriefing.callId);
    assert.deepStrictEqual(a.outcome.orders, []);
    assert.deepStrictEqual(b.outcome.orders, [{ action: 'rerun_build', text: '', confirmed: true }]);
    assert.ok(Date.parse(b.outcome.callbackAt) > clock);
    assert.ok(/rerun the build/.test(b.summary) && /call back/.test(b.summary));
    assert.deepStrictEqual(c.outcome.orders, [{ action: 'rerun_build', text: '', confirmed: true }]);
    assert.ok(!/rerun/.test(a.summary));
    assert.ok(!/\.\./.test(b.summary), 'no double period: ' + b.summary);
    assert.ok(!/\.\./.test((await (async () => { const x = await v.call({ reason: 'it broke.', briefing: '' }); clock += 5000; return v.result(x.callId); })()).summary));
  });

  // ---- stubbed fetch ----
  const settings = { vapiKey: 'fake-key', vapiPhoneNumberId: 'pn-1', myPhone: '415-555-0123' };
  const cfg = () => ({ ...settings });
  function stub(handler) {
    const calls = [];
    const f = async (url, opts) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, method: opts.method, headers: opts.headers, body });
      const r = handler({ url, method: opts.method, body, n: calls.length }) || { status: 200, json: {} };
      return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.json) };
    };
    f.calls = calls;
    return f;
  }

  await t('call sends the right URL, headers and body', async () => {
    const f = stub(() => ({ status: 201, json: { id: 'call-1', status: 'queued' } }));
    const v = createVapi({ cfg, log: quiet, fetch: f, now });
    const r = await v.call({ reason: 'build failed', briefing: 'BRIEFING-TEXT main is red', firstMessage: 'Hi there' });
    assert.deepStrictEqual(r, { ok: true, callId: 'call-1' });
    const c = f.calls[0];
    assert.strictEqual(c.url, 'https://api.vapi.ai/call');
    assert.strictEqual(c.method, 'POST');
    assert.strictEqual(c.headers.Authorization, 'Bearer fake-key');
    assert.strictEqual(c.headers['Content-Type'], 'application/json');
    assert.strictEqual(c.body.phoneNumberId, 'pn-1');
    assert.strictEqual(c.body.customer.number, '+14155550123');
    const a = c.body.assistant;
    assert.strictEqual(a.firstMessage, 'Hi there');
    assert.deepStrictEqual(a.transcriber, { provider: 'deepgram', model: 'nova-3', language: 'en' });
    assert.strictEqual(a.model.messages[0].role, 'system');
    assert.ok(a.model.messages[0].content.includes('BRIEFING-TEXT'));
    assert.ok(a.model.messages[0].content.includes('build failed'));
    assert.ok(a.model.messages[0].content.length <= 6000);
    assert.strictEqual(a.maxDurationSeconds, 300);
    assert.ok(a.analysisPlan.structuredDataPlan.schema.properties.callbackInMinutes);
    assert.ok(a.analysisPlan.structuredDataPlan.schema.properties.orderAction);
    assert.ok(/order/i.test(a.model.messages[0].content));
    assert.ok(!JSON.stringify(f.calls).includes('"vapiKey"'));
  });

  await t('a long briefing is trimmed under the prompt cap', async () => {
    const f = stub(() => ({ status: 201, json: { id: 'c' } }));
    const v = createVapi({ cfg, log: quiet, fetch: f, now });
    await v.call({ reason: 'x', briefing: 'word '.repeat(5000) });
    assert.ok(f.calls[0].body.assistant.model.messages[0].content.length <= 6000);
  });

  await t('validation names the missing setting without calling Vapi', async () => {
    const f = stub(() => ({ status: 201, json: { id: 'c' } }));
    let v = createVapi({ cfg: () => ({ ...settings, vapiPhoneNumberId: '' }), log: quiet, fetch: f, now });
    let r = await v.call({ reason: 'x', briefing: 'y' });
    assert.ok(!r.ok && /vapiPhoneNumberId/.test(r.error));
    assert.strictEqual(v.health(), 'error: no phone number id');
    v = createVapi({ cfg: () => ({ ...settings, myPhone: '' }), log: quiet, fetch: f, now });
    r = await v.call({ reason: 'x', briefing: 'y' });
    assert.ok(!r.ok && /myPhone/.test(r.error));
    assert.strictEqual(v.health(), 'error: no phone number set');
    r = await v.call({ reason: 'x', briefing: 'y', to: '123' });
    assert.ok(!r.ok && /not valid/.test(r.error));
    assert.strictEqual(f.calls.length, 0);
  });

  await t('a 400 from Vapi comes back with its message and shows in health', async () => {
    const msg = 'Couldn\'t get phone number. Free Vapi numbers cannot place outbound calls to this destination. ' + 'x'.repeat(300);
    const f = stub(() => ({ status: 400, json: { message: msg, error: 'Bad Request', statusCode: 400 } }));
    const v = createVapi({ cfg, log: quiet, fetch: f, now });
    const r = await v.call({ reason: 'x', briefing: 'y' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.startsWith("Couldn't get phone number"));
    assert.ok(r.error.length <= 200);
    assert.ok(v.health().startsWith('error: Couldn'));
  });

  await t('a network failure never throws', async () => {
    const v = createVapi({ cfg, log: quiet, fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, now });
    const r = await v.call({ reason: 'x', briefing: 'y' });
    assert.ok(!r.ok && /ENOTFOUND/.test(r.error));
    assert.strictEqual((await v.result('abc')).status, 'queued');
  });

  await t('result holds back ended until analysis arrives (or 20 s pass)', async () => {
    let analysis;
    const endedAt = new Date(clock).toISOString();
    const f = stub(() => ({ status: 200, json: { id: 'c1', status: 'ended', endedReason: 'customer-ended-call', endedAt, artifact: { transcript: 'AI: Hi\nUser: call me back in two minutes about the build' }, analysis } }));
    const v = createVapi({ cfg, log: quiet, fetch: f, now });
    assert.strictEqual((await v.result('c1')).status, 'in-progress');
    clock += 10000;
    assert.strictEqual((await v.result('c1')).status, 'in-progress');
    analysis = { summary: 'Told about the build.', structuredData: { acknowledged: true, callbackRequested: true, callbackInMinutes: 2, callbackTopic: 'the build' } };
    const r = await v.result('c1');
    assert.strictEqual(r.status, 'ended');
    assert.strictEqual(r.summary, 'Told about the build.');
    assert.strictEqual(Date.parse(r.outcome.callbackAt), Date.parse(endedAt) + 120000);
    assert.deepStrictEqual(r.outcome.orders, []);
    // never arrives: after 20 s we give up waiting and use the transcript
    analysis = undefined;
    const f2 = stub(() => ({ status: 200, json: { id: 'c2', status: 'ended', endedReason: 'customer-ended-call', endedAt, artifact: { transcript: 'User: call me back in 5 minutes' } } }));
    const v2 = createVapi({ cfg, log: quiet, fetch: f2, now });
    assert.strictEqual((await v2.result('c2')).status, 'in-progress');
    clock += 21000;
    const r2 = await v2.result('c2');
    assert.strictEqual(r2.status, 'ended');
    assert.ok(r2.outcome.callbackAt);
  });

  await t('result maps statuses and reports unanswered calls as failed', async () => {
    const reply = (j) => createVapi({ cfg, log: quiet, fetch: stub(() => ({ status: 200, json: j })), now });
    assert.strictEqual((await reply({ status: 'scheduled' }).result('a')).status, 'queued');
    assert.strictEqual((await reply({ status: 'queued' }).result('a')).status, 'queued');
    assert.strictEqual((await reply({ status: 'ringing' }).result('a')).status, 'ringing');
    assert.strictEqual((await reply({ status: 'forwarding' }).result('a')).status, 'in-progress');
    const f = await reply({ status: 'ended', endedReason: 'customer-did-not-answer' }).result('a');
    assert.deepStrictEqual(f, { status: 'failed', endedReason: 'customer-did-not-answer' });
    assert.strictEqual((await reply({ status: 'ended', endedReason: 'voicemail', artifact: { transcript: 'User: leave a message' } }).result('a')).status, 'failed');
  });

  await t('syncInbound creates once, patches on change, skips identical', async () => {
    const f = stub(({ url, method }) => {
      if (method === 'GET' && url.includes('/assistant')) return { status: 200, json: [{ id: 'other', name: 'Something else' }] };
      if (method === 'POST' && url.endsWith('/assistant')) return { status: 201, json: { id: 'as-1' } };
      return { status: 200, json: {} };
    });
    const v = createVapi({ cfg, log: quiet, fetch: f, now });
    assert.deepStrictEqual(await v.syncInbound('one'), { ok: true });
    const kinds = () => f.calls.map((c) => c.method + ' ' + c.url.replace('https://api.vapi.ai', ''));
    assert.deepStrictEqual(kinds(), ['GET /assistant?limit=100', 'POST /assistant', 'PATCH /phone-number/pn-1']);
    const created = f.calls[1].body;
    assert.strictEqual(created.name, 'Desk Board chief (dial-in)');
    assert.ok(created.firstMessage.startsWith("Hi, it's your desk"));
    assert.ok(created.model.messages[0].content.includes('one'));
    assert.deepStrictEqual(f.calls[2].body, { assistantId: 'as-1' });
    assert.deepStrictEqual(await v.syncInbound('one'), { ok: true });
    assert.strictEqual(f.calls.length, 3, 'identical briefing sends nothing');
    assert.deepStrictEqual(await v.syncInbound('two'), { ok: true });
    assert.deepStrictEqual(kinds().slice(3), ['PATCH /assistant/as-1']);
    assert.ok(f.calls[3].body.model.messages[0].content.includes('two'));
  });

  await t('syncInbound reuses an existing assistant found by name', async () => {
    const f = stub(({ url, method }) => (method === 'GET' ? { status: 200, json: [{ id: 'found-1', name: 'Desk Board chief (dial-in)' }] } : { status: 200, json: {} }));
    const v = createVapi({ cfg, log: quiet, fetch: f, now });
    assert.deepStrictEqual(await v.syncInbound('hello'), { ok: true });
    assert.ok(!f.calls.some((c) => c.method === 'POST'));
    assert.strictEqual(f.calls[2].body.assistantId, 'found-1');
  });

  await t('syncInbound failure returns the error and retries next time', async () => {
    let fail = true;
    const f = stub(({ method }) => (fail ? { status: 401, json: { message: 'Invalid Key' } } : method === 'GET' ? { status: 200, json: [] } : { status: 201, json: { id: 'z' } }));
    const v = createVapi({ cfg, log: quiet, fetch: f, now });
    const r = await v.syncInbound('b');
    assert.ok(!r.ok && /Invalid Key/.test(r.error));
    fail = false;
    assert.deepStrictEqual(await v.syncInbound('b'), { ok: true });
  });

  // ---- browser calls: the call rings in the page and the page starts a web call ----
  const web = { ...settings, callMode: 'browser', vapiPublicKey: 'pub-key' };
  const webCfg = () => ({ ...web });
  const VID = '11111111-2222-4333-8444-555555555555';
  const payload = { reason: 'build failed', briefing: 'BRIEFING-TEXT main is red', firstMessage: 'Hi there' };

  await t('browser mode: no request, a web- id, and offer gives the same assistant the phone path sends', async () => {
    const f = stub(() => ({ status: 201, json: { id: 'call-1' } }));
    const v = createVapi({ cfg: webCfg, log: quiet, fetch: f, now });
    const r = await v.call(payload);
    assert.ok(r.ok && r.web === true && /^web-\d+$/.test(r.callId), JSON.stringify(r));
    assert.strictEqual(f.calls.length, 0, 'nothing is sent to Vapi when the call is placed');
    const o = v.offer(r.callId);
    assert.ok(o && o.assistant);
    const phoneF = stub(() => ({ status: 201, json: { id: 'call-1' } }));
    await createVapi({ cfg, log: quiet, fetch: phoneF, now }).call(payload);
    assert.deepStrictEqual(o.assistant, phoneF.calls[0].body.assistant);
    assert.ok(!JSON.stringify(o).includes('fake-key') && !JSON.stringify(o).includes('pub-key'), 'no key inside the assistant');
    const r2 = await v.call(payload);
    assert.notStrictEqual(r2.callId, r.callId, 'each call gets its own id');
    assert.strictEqual(v.offer('web-999'), null);
    assert.strictEqual(v.offer(undefined), null);
    assert.strictEqual(f.calls.length, 0);
  });

  await t('browser mode: ringing, then failed after 45 seconds unanswered', async () => {
    const f = stub(() => ({ status: 200, json: {} }));
    const v = createVapi({ cfg: webCfg, log: quiet, fetch: f, now });
    const { callId } = await v.call(payload);
    assert.deepStrictEqual(await v.result(callId), { status: 'ringing' });
    clock += 44000;
    assert.deepStrictEqual(await v.result(callId), { status: 'ringing' });
    assert.ok(v.offer(callId), 'still answerable at 44 s');
    clock += 2000;
    assert.deepStrictEqual(await v.result(callId), { status: 'failed', endedReason: 'not answered in the browser' });
    assert.strictEqual(v.offer(callId), null, 'too late to answer');
    assert.strictEqual(f.calls.length, 0, 'ringing and missing a call never touch Vapi');
  });

  await t('browser mode: declined', async () => {
    const f = stub(() => ({ status: 200, json: {} }));
    const v = createVapi({ cfg: webCfg, log: quiet, fetch: f, now });
    const { callId } = await v.call(payload);
    assert.strictEqual(v.decline(callId), true);
    assert.deepStrictEqual(await v.result(callId), { status: 'failed', endedReason: 'declined in the browser' });
    assert.strictEqual(v.offer(callId), null);
    assert.strictEqual(v.attach(callId, VID), false, 'a declined call cannot be answered');
    assert.strictEqual(v.decline('web-999'), false);
    assert.strictEqual(f.calls.length, 0);
  });

  await t('browser mode: after attach the result is the ordinary call record', async () => {
    const endedAt = new Date(clock).toISOString();
    let rec = { id: VID, status: 'queued' };
    const f = stub(() => ({ status: 200, json: rec }));
    const v = createVapi({ cfg: webCfg, log: quiet, fetch: f, now });
    const { callId } = await v.call(payload);
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(v.attach(callId, VID), true);
    assert.strictEqual(v.offer(callId), null, 'answered once');
    assert.strictEqual(v.decline(callId), false, 'cannot decline an answered call');
    assert.strictEqual(v.attach(callId, VID), false, 'cannot attach twice');
    assert.strictEqual((await v.result(callId)).status, 'queued');
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].method, 'GET');
    assert.strictEqual(f.calls[0].url, 'https://api.vapi.ai/call/' + VID);
    assert.strictEqual(f.calls[0].headers.Authorization, 'Bearer fake-key', 'read with the private key');
    clock += 60000;   // far past the 45 s ring window: an answered call does not time out
    rec = { id: VID, status: 'in-progress' };
    assert.strictEqual((await v.result(callId)).status, 'in-progress');
    rec = { id: VID, status: 'ended', endedReason: 'customer-ended-call', endedAt, artifact: { transcript: 'AI: Hi\nUser: call me back in two minutes' },
      analysis: { summary: 'Told about the build.', structuredData: { acknowledged: true, callbackRequested: true, callbackInMinutes: 2, callbackTopic: 'the build' } } };
    const r = await v.result(callId);
    assert.strictEqual(r.status, 'ended');
    assert.strictEqual(r.summary, 'Told about the build.');
    assert.strictEqual(Date.parse(r.outcome.callbackAt), Date.parse(endedAt) + 120000);
    assert.strictEqual(r.outcome.callbackTopic, 'the build');
    assert.ok(f.calls.every((c) => c.method === 'GET' && c.url === 'https://api.vapi.ai/call/' + VID), 'only ever reads the real call');
    // a web call that never connected is a failure, like a phone call nobody answered
    const f2 = stub(() => ({ status: 200, json: { id: VID, status: 'ended', endedReason: 'call.start.error-get-transport' } }));
    const v2 = createVapi({ cfg: webCfg, log: quiet, fetch: f2, now });
    const c2 = await v2.call(payload);
    v2.attach(c2.callId, VID);
    assert.deepStrictEqual(await v2.result(c2.callId), { status: 'failed', endedReason: 'call.start.error-get-transport' });
  });

  await t('browser mode: bad call ids are rejected and leave the call ringing', async () => {
    const f = stub(() => ({ status: 200, json: {} }));
    const v = createVapi({ cfg: webCfg, log: quiet, fetch: f, now });
    const { callId } = await v.call(payload);
    for (const bad of ['', 'abc', 'call-1', VID + 'x', ' ' + VID, VID.replace(/-/g, ''), '../call', 'zzzzzzzz-2222-4333-8444-555555555555', 42, null, undefined, {}]) {
      assert.strictEqual(v.attach(callId, bad), false, 'rejected: ' + JSON.stringify(bad));
    }
    assert.strictEqual(v.attach('web-999', VID), false, 'unknown call');
    assert.strictEqual(v.attach('mock-1', VID), false);
    assert.deepStrictEqual(await v.result(callId), { status: 'ringing' });
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual((await v.result('web-999')).status, 'failed', 'an unknown browser call (app restarted) fails');
    assert.strictEqual(v.attach(callId, VID.toUpperCase()), true, 'uppercase hex is still a UUID');
  });

  await t('browser mode: health, and a missing public key is named', async () => {
    const f = stub(() => ({ status: 200, json: {} }));
    assert.strictEqual(createVapi({ cfg: webCfg, log: quiet, fetch: f, now }).health(), 'ok (browser calls)');
    const noPub = () => ({ ...web, vapiPublicKey: '' });
    const v = createVapi({ cfg: noPub, log: quiet, fetch: f, now });
    assert.ok(/^error: .*vapiPublicKey/.test(v.health()), v.health());
    const r = await v.call(payload);
    assert.ok(!r.ok && /vapiPublicKey/.test(r.error), JSON.stringify(r));
    assert.strictEqual(v.offer('web-1'), null);
    // browser mode needs neither a phone number nor a Vapi number
    const bare = () => ({ ...web, vapiPhoneNumberId: '', myPhone: '' });
    const vb = createVapi({ cfg: bare, log: quiet, fetch: f, now });
    assert.strictEqual(vb.health(), 'ok (browser calls)');
    assert.ok((await vb.call(payload)).ok);
    // without the private key there is nothing to read the call with: still the mock
    assert.strictEqual(createVapi({ cfg: () => ({ ...web, vapiKey: '' }), log: quiet, fetch: f, now }).health(), 'mock');
    assert.strictEqual(f.calls.length, 0);
  });

  await t('phone and mock modes are unchanged by the new settings', async () => {
    const f = stub(() => ({ status: 201, json: { id: 'call-9', status: 'queued' } }));
    for (const extra of [{}, { callMode: 'phone', vapiPublicKey: 'pub-key' }, { callMode: 'nonsense', vapiPublicKey: 'pub-key' }]) {
      f.calls.length = 0;
      const v = createVapi({ cfg: () => ({ ...settings, ...extra }), log: quiet, fetch: f, now });
      assert.strictEqual(v.health(), 'ok');
      assert.deepStrictEqual(await v.call(payload), { ok: true, callId: 'call-9' });
      assert.strictEqual(f.calls.length, 1);
      assert.strictEqual(f.calls[0].url, 'https://api.vapi.ai/call');
      assert.strictEqual(f.calls[0].body.phoneNumberId, 'pn-1');
      assert.strictEqual(v.offer('call-9'), null);
    }
    const m = createVapi({ cfg: () => ({ ...noKey(), callMode: 'browser', vapiPublicKey: 'pub-key' }), log: quiet, fetch: f, now });
    const mc = await m.call(payload);
    assert.ok(mc.ok && mc.mock && /^mock-/.test(mc.callId) && !mc.web);
    assert.strictEqual(m.health(), 'mock');
  });

  // ---- live ----
  if (LIVE) {
    const live = createVapi({ cfg: realCfg, log: (m) => console.log('  log:', m) });
    console.log('health:', live.health());
    const c = realCfg();
    if (!c.vapiKey) { console.error('FAIL --live needs vapiKey in ' + realCfg.file); process.exit(1); }
    const get = async (p) => {
      const res = await fetch('https://api.vapi.ai' + p, { headers: { Authorization: 'Bearer ' + c.vapiKey }, signal: AbortSignal.timeout(15000) });
      const body = await res.json().catch(() => null);
      return { status: res.status, body };
    };
    const a = await get('/assistant?limit=1');
    console.log('GET /assistant?limit=1 ->', a.status, Array.isArray(a.body) ? a.body.length + ' item(s)' : JSON.stringify(a.body));
    const p = await get('/phone-number');
    console.log('GET /phone-number ->', p.status);
    if (Array.isArray(p.body)) for (const n of p.body) console.log(`  ${n.id}  ${n.number || n.sipUri || '(no number)'}  provider=${n.provider}${n.id === c.vapiPhoneNumberId ? '  <- configured' : ''}`);
    console.log('Note: free Vapi numbers are inbound only; outbound needs an imported number (Twilio etc.).');
    if (a.status !== 200 || p.status !== 200) { console.error('FAIL live read'); process.exitCode = 1; }

    if (process.argv.includes('--call')) {
      if (!c.myPhone) { console.error('FAIL --call needs myPhone in settings'); process.exit(1); }
      console.log('placing a real call to', c.myPhone);
      const r = await live.call({ reason: 'this is a test call from Desk Board', briefing: 'This is a test. Nothing is wrong. If the user asks, tell them the build is green and there are no charges waiting. Card charges here are sample data.', firstMessage: "Hi, it's your desk. This is just a test call." });
      console.log('call ->', JSON.stringify(r));
      if (!r.ok) { process.exitCode = 1; }
      else {
        for (;;) {
          await sleep(3000);
          const s = await live.result(r.callId);
          console.log(new Date().toLocaleTimeString(), s.status, s.endedReason || '');
          if (s.status === 'ended' || s.status === 'failed') { console.log(JSON.stringify(s, null, 2)); break; }
        }
      }
    }
  }

  console.log(`\n${passed} checks passed${process.exitCode ? ', with failures' : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
