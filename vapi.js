// The phone: places the outbound call through Vapi, reports how it went, and keeps the dial-in
// assistant up to date. No webhook and no tunnel: the venue Wi-Fi has no public address, so
// context goes in when the call is created and the result is read back by polling the call record.
const API = 'https://api.vapi.ai';
const TIMEOUT_MS = 15000;
const MAX_CALL_SECONDS = 300;
const ANALYSIS_WAIT_MS = 20000;   // analysis lands a few seconds after status flips to 'ended'
const PROMPT_MAX = 6000;
const INBOUND_NAME = 'Desk Board chief (dial-in)';
const MOCK_RING_MS = 1000;
const MOCK_END_MS = 4000;

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };

// The orders a call can carry (see ORDERS.md). Kept here so this file does not depend on orders.js.
const ORDER_ACTIONS = ['rerun_build', 'comment', 'close_issue', 'label_urgent', 'assign_me', 'create_issue', 'mute_similar', 'dispute_charge'];
const ORDER_TEXT_MAX = 500;

// What we ask Vapi to pull out of the conversation. Minutes or a clock time rather than a full
// timestamp: models get dates and time zones wrong, so we do the arithmetic ourselves.
const SCHEMA = {
  type: 'object',
  properties: {
    acknowledged: { type: 'boolean', description: 'true if the user heard and understood the main item' },
    callbackRequested: { type: 'boolean', description: 'true if the user asked to be called back or reminded later' },
    // Single types only: a ['number', 'null'] union risks a 400 from Vapi's schema check. Absent means none.
    callbackInMinutes: { type: 'number', description: 'for "in N minutes/hours": the delay in minutes; leave out if no delay was given' },
    callbackAtLocalTime: { type: 'string', description: 'for "at 2 PM": the time as HH:MM in 24 hour form; leave out if no clock time was given' },
    callbackTopic: { type: 'string', description: 'what the callback should be about; leave out if none' },
    noteToSelf: { type: 'string', description: 'anything the user asked to have written down; leave out if nothing' },
    // Orders stay flat on purpose: one string, one string, one boolean. No unions, no nested arrays.
    orderAction: { type: 'string', description: `the one order the user gave: ${ORDER_ACTIONS.join(', ')}; use 'none' when no order was given` },
    orderText: { type: 'string', description: 'for a comment, the comment text; for a new issue, its title; in the user\'s words; leave out if none' },
    orderConfirmed: { type: 'boolean', description: 'true only if the assistant read the order back and the user agreed' },
  },
  required: ['acknowledged', 'callbackRequested'],
};

const pad = (n) => String(n).padStart(2, '0');
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// "+1..." in E.164 form, or null. Ten digits are assumed to be US/Canada.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

// "2026-11-09 14:05 (UTC+05:30, Monday)" so the assistant can resolve "in an hour" or "at 2 PM".
function localStamp(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}, ${day})`;
}

const RULES = [
  'Speak the way a person talks on the phone: one or two short sentences at a time, no lists, no markdown, and never read out web addresses, ids or long numbers.',
  'Lead with what happened and why it matters to them.',
  'Answer questions only from the briefing below. If something is not in it, say so plainly instead of guessing.',
  'Card charges in the briefing that are marked as sample data are test data, not real money.',
].join(' ');

function outboundPrompt(reason, briefing, now) {
  const head =
    `You are the user's chief of staff, calling them by phone. You called because: ${reason || 'something needs their attention'}. ${RULES} ` +
    `If they ask to be called back or reminded (for example "call me in two minutes" or "call me at 2 PM about the build"), confirm the time and topic back to them in one sentence. ` +
    `They may also give you one order. You can rerun the failed build; comment on, close, label as urgent, or assign to them the issue this call is about; open a new issue as a to-do; stop calling about things like this; or flag a charge for dispute. Orders are carried out right after the call ends, not during it, so say "I'll do that as soon as we hang up". Always repeat the order back in one sentence and wait for a yes. Anything else, like merging, deleting, paying, sending money or changing code, you politely refuse. ` +
    `If they say something to remember, confirm that you have it. When they are done, say a short goodbye ending with the word "goodbye", and the call will end.\n\n` +
    `Current local date and time: ${localStamp(now)}.\n\nBriefing:\n`;
  return head + trimTo(briefing, PROMPT_MAX - head.length);
}

function inboundPrompt(briefing, now) {
  const head =
    `You are the user's chief of staff. They have phoned in to their desk to hear what is waiting. ${RULES} ` +
    `You cannot schedule callbacks or take orders on this line; if they ask, say they can ask on your next call or use the board. ` +
    `When they are done, say a short goodbye ending with the word "goodbye", and the call will end.\n\n` +
    `Briefing as of ${localStamp(now)}:\n`;
  return head + trimTo(briefing || 'Nothing is waiting right now.', PROMPT_MAX - head.length);
}

function trimTo(text, max) {
  const t = String(text || '').trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// Next occurrence of a local clock time after fromMs: today if still ahead, else tomorrow.
function clockToMs(hh, mm, fromMs) {
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
  const d = new Date(fromMs);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const userLines = (transcript) => String(transcript || '').split(/\r?\n/)
  .map((l) => l.match(/^\s*(?:user|customer|human)\s*:\s*(.*)$/i)).filter(Boolean).map((m) => m[1]);

// Safety net for when Vapi's structured data is missing: read the user's own words.
function scanTranscript(transcript, endedAtMs) {
  const out = { callbackAt: null, callbackTopic: null };
  for (const line of userLines(transcript)) {
    let m, at = null, rest = '';
    if ((m = line.match(/\b(?:call|ring|phone)\s+me(?:\s+back)?(?:\s+again)?\s+in\s+half\s+an?\s+hour\b/i))) {
      at = endedAtMs + 30 * 60000; rest = line.slice(m.index + m[0].length);
    } else if ((m = line.match(/\b(?:call|ring|phone)\s+me(?:\s+back)?(?:\s+again)?\s+in\s+(?:about\s+|around\s+)?(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|an?)\s*(minutes?|mins?|hours?|hrs?)\b/i))) {
      const n = /^\d/.test(m[1]) ? Number(m[1]) : WORDS[m[1].toLowerCase()];
      at = endedAtMs + n * (/^h/i.test(m[2]) ? 60 : 1) * 60000; rest = line.slice(m.index + m[0].length);
    } else if ((m = line.match(/\b(?:call|ring|phone)\s+me(?:\s+back)?(?:\s+again)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\b\.?)?/i))) {
      let h = Number(m[1]); const mi = Number(m[2] || 0); const ap = (m[3] || '').toLowerCase();
      if (ap === 'p' && h < 12) h += 12;
      else if (ap === 'a' && h === 12) h = 0;
      else if (!ap && h >= 1 && h < 8) h += 12;   // "at 2" almost always means the afternoon
      at = clockToMs(h, mi, endedAtMs); rest = line.slice(m.index + m[0].length);
    }
    if (at != null) {
      const t = rest.match(/\babout\s+([^.?!\n]+)/i);
      return { callbackAt: new Date(at).toISOString(), callbackTopic: t ? t[1].trim().slice(0, 80) : null };
    }
  }
  return out;
}

const RERUN_WORDS = /\b(?:re-?run|re run|run it again|run the build again|restart the build)\b/i;

// Orders from the structured fields; unknown, empty or 'none' values give no order.
function ordersFrom(d) {
  const action = typeof d.orderAction === 'string' ? d.orderAction.trim().toLowerCase() : '';
  if (!ORDER_ACTIONS.includes(action)) return [];
  const text = typeof d.orderText === 'string' ? d.orderText.trim().slice(0, ORDER_TEXT_MAX) : '';
  return [{ action, text, confirmed: d.orderConfirmed === true }];
}

// Vapi's structured data (plus transcript fallback) -> the contract's Outcome. Pure, so it is testable.
function outcomeFrom(sd, transcript, endedAtMs) {
  const end = Number.isFinite(endedAtMs) ? endedAtMs : Date.now();
  const d = sd && typeof sd === 'object' ? sd : {};
  const empty = !Object.values(d).some((v) => v !== null && v !== undefined && v !== '');
  const heard = userLines(transcript).length > 0;
  let callbackAt = null;
  const mins = Number(d.callbackInMinutes);
  if (d.callbackInMinutes != null && Number.isFinite(mins) && mins > 0 && mins <= 1440) callbackAt = end + mins * 60000;
  else if (typeof d.callbackAtLocalTime === 'string') {
    const m = d.callbackAtLocalTime.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) callbackAt = clockToMs(Number(m[1]), Number(m[2]), end);
  }
  let topic = str(d.callbackTopic, 80);
  // Missing data, or a callback was requested but no usable time came back: read the transcript.
  if (callbackAt == null && (empty || d.callbackRequested === true)) {
    const s = scanTranscript(transcript, end);
    if (s.callbackAt) { callbackAt = Date.parse(s.callbackAt); topic = topic || s.callbackTopic; }
  }
  const orders = ordersFrom(d);
  // No structured order: a user line asking for a rerun still counts, but unconfirmed.
  if (!orders.length && userLines(transcript).some((l) => RERUN_WORDS.test(l))) orders.push({ action: 'rerun_build', text: '', confirmed: false });
  return {
    acknowledged: empty ? heard : d.acknowledged === true,
    callbackAt: callbackAt == null ? null : new Date(callbackAt).toISOString(),
    callbackTopic: topic,
    noteToSelf: str(d.noteToSelf, 300),
    orders,
  };
}

// Vapi's message may be a string or a list of validation messages.
function vapiMessage(data, text, status) {
  let m = data && (data.message || data.error);
  if (Array.isArray(m)) m = m.join('; ');
  if (m && typeof m === 'object') m = JSON.stringify(m);
  return String(m || text || `HTTP ${status}`).replace(/\s+/g, ' ').trim().slice(0, 200);
}

const NEVER_CONNECTED = /voicemail|did-not-answer|busy|no-answer|call\.start\.error|failed-to-connect|rejected|misdialed|invalid-number|unreachable/i;
const MAYBE_FAILED = /failed|error|provider/i;

module.exports = function createVapi({ cfg, log, fetch: fetchImpl, now: nowFn }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const now = nowFn || Date.now;
  const say = (m) => { try { if (typeof log === 'function') log(m); } catch {} };
  let lastError = '';
  let mockSeq = 0;
  const mocks = new Map();     // mock call id -> { start, reason, callback, order }
  const endedSeen = new Map(); // call id -> ms we first saw 'ended' (to wait for the analysis)
  const lastKnown = new Map(); // call id -> last status we reported
  const inbound = { assistantId: '', attachedTo: '', briefing: null, chain: Promise.resolve() };

  async function api(method, path, body) {
    const c = cfg();
    try {
      const res = await doFetch(API + path, {
        method,
        headers: { Authorization: 'Bearer ' + c.vapiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text().catch(() => '');
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok) {
        const error = vapiMessage(data, text, res.status);
        lastError = error; say(`vapi ${method} ${path.split('?')[0]} failed: ${error}`);
        return { ok: false, status: res.status, error };
      }
      lastError = '';
      return { ok: true, status: res.status, data };
    } catch (e) {
      const error = (e && e.name === 'TimeoutError' ? 'Vapi did not answer in time' : String((e && e.message) || e)).slice(0, 200);
      lastError = error; say(`vapi ${method} ${path.split('?')[0]} failed: ${error}`);
      return { ok: false, status: 0, error };
    }
  }

  const modelOf = (content) => ({ provider: 'openai', model: 'gpt-4o', messages: [{ role: 'system', content }] });
  const TRANSCRIBER = { provider: 'deepgram', model: 'nova-3', language: 'en' };
  const VOICE = { provider: 'vapi', voiceId: 'Elliot' };   // named so a call never depends on the account's default voice

  async function call({ reason, briefing, firstMessage, to } = {}) {
    try {
      const c = cfg();
      if (!c.vapiKey) {
        const id = 'mock-' + (++mockSeq);
        mocks.set(id, { start: now(), reason: String(reason || 'something came up'), callback: /\[mock:callback\]/.test(`${reason} ${briefing}`), order: /\[mock:order\]/.test(`${reason} ${briefing}`) });
        return { ok: true, callId: id, mock: true };
      }
      if (!c.vapiPhoneNumberId) return { ok: false, error: 'vapiPhoneNumberId is not set in the settings file (the Vapi number that places the call)' };
      const number = normalizePhone(to || c.myPhone);
      if (!number) return { ok: false, error: (to || c.myPhone) ? 'the phone number to call is not valid; use + and the country code, like +14155550123' : 'myPhone is not set in the settings file (the number to call)' };
      const opening = str(firstMessage, 300) || `Hi, it's your desk. ${str(reason, 200) || 'Something needs your attention'}. Do you have a minute?`;
      const r = await api('POST', '/call', {
        phoneNumberId: c.vapiPhoneNumberId,
        customer: { number },
        assistant: {
          firstMessage: opening,
          model: modelOf(outboundPrompt(reason, briefing, now())),
          transcriber: TRANSCRIBER,
          voice: VOICE,
          maxDurationSeconds: MAX_CALL_SECONDS,
          endCallPhrases: ['goodbye'],
          analysisPlan: {
            summaryPlan: { enabled: true },
            structuredDataPlan: { enabled: true, schema: SCHEMA, timeoutSeconds: 10 },
          },
        },
      });
      if (!r.ok) return { ok: false, error: r.error };
      const id = r.data && r.data.id;
      return id ? { ok: true, callId: id } : { ok: false, error: 'Vapi accepted the call but returned no id' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  }

  function mockResult(id) {
    const m = mocks.get(id);
    if (!m) return { status: 'failed', endedReason: 'mock call unknown (the app was restarted)' };
    const age = now() - m.start;
    if (age < MOCK_RING_MS) return { status: 'ringing' };
    if (age < MOCK_END_MS) return { status: 'in-progress' };
    const endedAt = m.start + MOCK_END_MS;
    const outcome = { acknowledged: true, callbackAt: null, callbackTopic: null, noteToSelf: null, orders: [] };
    if (m.callback) { outcome.callbackAt = new Date(endedAt + 60000).toISOString(); outcome.callbackTopic = 'the mock follow-up'; }
    if (m.order) outcome.orders.push({ action: 'rerun_build', text: '', confirmed: true });
    return {
      status: 'ended', endedReason: 'customer-ended-call', outcome,
      summary: `Mock call about: ${m.reason.replace(/[.\s]+$/, '')}. The user heard it and acknowledged.` + (m.callback ? ' They asked for a call back in a minute.' : '') + (m.order ? ' They asked to rerun the build and confirmed it.' : ''),
      transcript: `AI: Hi, it's your desk. ${m.reason}\nUser: Okay, thanks.`,
    };
  }

  async function result(callId) {
    const id = String(callId || '');
    try {
      if (id.startsWith('mock-')) return mockResult(id);
      const r = await api('GET', '/call/' + encodeURIComponent(id));
      if (!r.ok) {
        if (r.status === 404) return { status: 'failed', endedReason: r.error };
        return { status: lastKnown.get(id) || 'queued' };   // network trouble: keep the last answer
      }
      const c = r.data || {};
      const transcript = (c.artifact && c.artifact.transcript) || '';
      const reason = c.endedReason || '';
      let status;
      if (c.status === 'ended') {
        const noOneThere = NEVER_CONNECTED.test(reason) || (MAYBE_FAILED.test(reason) && !userLines(transcript).length);
        if (noOneThere) status = 'failed';
        else {
          const first = endedSeen.get(id) ?? (endedSeen.set(id, now()), now());
          const a = c.analysis || {};
          const have = a.summary || (a.structuredData && Object.keys(a.structuredData).length);
          if (!have && now() - first < ANALYSIS_WAIT_MS) status = 'in-progress';   // analysis is still being written
          else status = 'ended';
        }
      } else if (c.status === 'scheduled' || c.status === 'queued') status = 'queued';
      else if (c.status === 'ringing') status = 'ringing';
      else status = 'in-progress';   // in-progress, forwarding, or anything new
      lastKnown.set(id, status);
      if (status === 'failed') return { status, endedReason: reason };
      if (status !== 'ended') return { status };
      const endedAt = Date.parse(c.endedAt) || endedSeen.get(id) || now();
      const a = c.analysis || {};
      return {
        status, endedReason: reason, summary: a.summary || '', transcript,
        outcome: outcomeFrom(a.structuredData, transcript, endedAt),
      };
    } catch (e) { return { status: lastKnown.get(id) || 'queued' }; }
  }

  // One request at a time, so two quick syncs cannot both create the assistant.
  function syncInbound(briefing) {
    const run = inbound.chain.then(() => doSync(briefing), () => doSync(briefing));
    inbound.chain = run.catch(() => {});
    return run;
  }

  async function doSync(briefing) {
    try {
      const c = cfg();
      if (!c.vapiKey) return { ok: false, error: 'no key' };
      if (!c.vapiPhoneNumberId) return { ok: false, error: 'vapiPhoneNumberId is not set' };
      const text = String(briefing || '');
      if (text === inbound.briefing && inbound.attachedTo === c.vapiPhoneNumberId) return { ok: true };
      const opening = text.trim() ? "Hi, it's your desk. Here's what's waiting." : "Hi, it's your desk. Nothing needs you right now.";
      const fields = { firstMessage: opening, model: modelOf(inboundPrompt(text, now())), voice: VOICE };

      if (!inbound.assistantId) {
        const list = await api('GET', '/assistant?limit=100');
        if (!list.ok) return { ok: false, error: list.error };
        const found = (Array.isArray(list.data) ? list.data : []).find((a) => a && a.name === INBOUND_NAME);
        if (found) inbound.assistantId = found.id;
      }
      let r;
      if (inbound.assistantId) {
        r = await api('PATCH', '/assistant/' + inbound.assistantId, fields);
        if (!r.ok && r.status === 404) inbound.assistantId = '';   // deleted behind our back: recreate below
      }
      if (!inbound.assistantId) {
        r = await api('POST', '/assistant', { name: INBOUND_NAME, ...fields, transcriber: TRANSCRIBER, maxDurationSeconds: MAX_CALL_SECONDS, endCallPhrases: ['goodbye'] });
        if (r.ok && r.data && r.data.id) inbound.assistantId = r.data.id;
      }
      if (!r.ok) return { ok: false, error: r.error };
      if (!inbound.assistantId) return { ok: false, error: 'Vapi returned no assistant id' };

      if (inbound.attachedTo !== c.vapiPhoneNumberId) {
        const p = await api('PATCH', '/phone-number/' + encodeURIComponent(c.vapiPhoneNumberId), { assistantId: inbound.assistantId });
        if (!p.ok) return { ok: false, error: p.error };
        inbound.attachedTo = c.vapiPhoneNumberId;
      }
      inbound.briefing = text;
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  }

  function health() {
    const c = cfg();
    if (!c.vapiKey) return 'mock';
    if (!c.vapiPhoneNumberId) return 'error: no phone number id';
    if (!c.myPhone) return 'error: no phone number set';
    return lastError ? 'error: ' + lastError : 'ok';
  }

  return { call, result, syncInbound, health };
};

Object.assign(module.exports, { outcomeFrom, scanTranscript, normalizePhone, clockToMs, outboundPrompt, inboundPrompt, SCHEMA, INBOUND_NAME });
