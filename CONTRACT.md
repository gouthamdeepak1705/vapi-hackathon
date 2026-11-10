# Chief of staff: build contract

Desk Board gets a "chief of staff": it watches sources (GitHub, card transactions), scores every
event for urgency, shows the scored feed on the board, and phones the user only when something
crosses their threshold. The user can also ask for a call at a set time ("call me at 2 PM about this").

This file is the binding interface between modules. Several people build in parallel, each owning
their own files. Do not change a signature here; if one is wrong, say so in your report.

## Ground rules

- Plain CommonJS, Node 24, built-in `fetch`. **No new npm dependencies.**
- Match the house style of `jobs.js` / `actions.js`: factory functions taking a deps object, short
  comments that explain why, no classes, no TypeScript.
- Every module must work with **no keys** (mock or "off" mode) so the whole pipeline can be tested
  before keys arrive. Every network call has a timeout and **never throws** to its caller.
- Never log or persist a key. Never write card data to `data/` (that folder is committed to a public
  repo) or to long-term memory. State lives in `%APPDATA%\desk-board\`.
- Each module ships a `cos/test-<name>.js` runnable with plain `node` that exercises mock mode and
  exits non-zero on failure. If keys are present in the settings file it may also run a live check,
  but only when started with `--live`.
- Only touch the files you own (listed below).

## Settings: `cos/keys.js` (already written, read it)

`const cfg = require('./keys')` then `cfg()` returns the current settings object, re-read from
`%APPDATA%\desk-board\cos.json` on every call so edits apply without a restart. Missing file or
fields give defaults. Fields:

```
vapiKey, vapiPhoneNumberId, myPhone ("+1..."), deepgramKey (optional),
jevKey, jevBase (optional override), exaKey,
plaidClientId, plaidSecret,
repos: ["owner/name", ...], threshold (0..1, default 0.7),
pollSeconds (default 30), maxCallsPerHour (default 6), publicUrl (optional tunnel address)
```

## Shapes

```js
// One thing that happened in a source.
Event = {
  id,        // stable and unique per real-world thing, e.g. "gh:run:812345", "plaid:txn_abc"
  source,    // 'github' | 'plaid' | 'demo'
  kind,      // short machine word: 'build_failed' | 'issue' | 'security_alert' | 'review_request' | 'mention' | 'charge' | ...
  title,     // one line a person would say aloud
  detail,    // up to 600 chars of plain text
  url,       // optional
  amount,    // optional number (charges), positive = money out
  ts,        // ISO time
  sample,    // true when the data is made up (mock mode or sandbox)
}

Score = { decision: 'call' | 'brief' | 'ignore', urgency /* 0..1 */, reason /* one short sentence */, by: 'jev' | 'rules', ms }

Context = { answer /* <= 400 chars */, sources: [{ title, url }] } | null

Outcome = { acknowledged: bool, callbackAt: ISO | null, callbackTopic: string | null, noteToSelf: string | null }
```

## Modules

### `cos/sources/github.js` and `cos/sources/plaid.js`
```js
module.exports = ({ cfg, log }) => ({ name, poll, health })
poll()   -> Promise<Event[]>   // everything currently relevant; repeats are fine, the caller dedupes by id
health() -> 'ok' | 'off' | 'sample' | 'error: <short>'
```
- github: uses the already signed-in `gh` CLI through `child_process.execFile` (no shell). Covers
  failed workflow runs, new issues, security alerts and unread notifications for `cfg().repos`.
  Features a repo has switched off are skipped quietly.
- plaid: sandbox only. With no Plaid keys it returns a small fixed set of realistic sample charges
  (`sample: true`, `health() === 'sample'`). Exposes `inject({ merchant, amount })` to stage one
  extra charge for a demo.

### `cos/jev.js`
```js
module.exports = ({ cfg, log }) => ({ score, health })
score(event, profile /* string, may be '' */) -> Promise<Score>   // never throws, answers within 3 s
module.exports.rules = (event) => Score                            // the no-key fallback, also used on error/timeout
```

### `cos/exa.js`
```js
module.exports = ({ cfg, log }) => ({ context, health })
context(event) -> Promise<Context>   // null with no key or on any failure; 8 s timeout
```
Builds a search question from the event (an error message, an unknown merchant name, a CVE id).
For charges only the merchant name leaves the machine, never the amount or account.

### `cos/vapi.js`
```js
module.exports = ({ cfg, log }) => ({ call, result, syncInbound, health })
call({ reason, briefing, firstMessage, to })  -> Promise<{ ok, callId, mock?, error? }>
result(callId)                                -> Promise<{ status: 'queued'|'ringing'|'in-progress'|'ended'|'failed', endedReason?, summary?, transcript?, outcome?: Outcome }>
syncInbound(briefing)                         -> Promise<{ ok, error? }>
```
- `call` places an outbound call to `to || cfg().myPhone`. The assistant gets `briefing` (plain text:
  what happened, why it matters, what else is waiting) in its system prompt and opens with
  `firstMessage`. Deepgram is the transcriber.
- **No tunnel is needed.** Results come from polling Vapi after the call, not from a webhook:
  `result` reads the call record and returns the structured `outcome` Vapi extracted from the
  conversation (did the user acknowledge, did they ask for a call back and when).
- `syncInbound` keeps the assistant attached to the phone number up to date, so when the user dials
  in they hear the current state. Cheap to call often; skips the request when nothing changed.
- With no `vapiKey`: mock mode. `call` returns `{ ok: true, callId: 'mock-…', mock: true }` and
  `result` reports `ended` about 4 s later with a canned outcome.

### `cos/index.js` (the orchestrator) and `main.js` wiring
```js
module.exports = ({ appDataDir, profile /* () => string */, addNote /* ({title, body, color, category}) */, onState /* (state) */, notify /* (title, body) */, log }) =>
  ({ start, stop, state, action })
```
State pushed to the board (and returned by `state()`):
```js
{
  events: [ Event & { score: Score, context: Context, status: 'new'|'calling'|'called'|'briefed'|'dismissed' } ],  // newest first, capped at 60
  calls:  [ { id, at /* ISO */, topic, status: 'scheduled'|'ringing'|'in-progress'|'done'|'failed'|'cancelled', eventIds: [], summary, mock } ],
  settings: { threshold, myPhoneSet: bool },
  health: { github, plaid, jev, exa, vapi },   // each 'ok' | 'off' | 'sample' | 'mock' | 'error: …'
}
```
`action(a)` accepts:
`{type:'refresh'}`, `{type:'call_now', eventId? , topic?}`, `{type:'dismiss', eventId}`,
`{type:'schedule', at? /* ISO */, inMinutes?, topic}`, `{type:'cancel_call', id}`,
`{type:'set_threshold', value}`, `{type:'demo', scenario:'build'|'charge'|'typo'|'leak'}`.

Loop: poll sources every `pollSeconds` -> for each unseen event: `score` -> if not `ignore`, fetch
`context` -> if `decision === 'call'` and `urgency >= threshold` and no call is in progress and the
hourly cap is not hit, place a call; otherwise the event waits for the next briefing. After a call,
poll `result` every 3 s until it ends, then apply the outcome (schedule the call back, mark events,
save the summary). A 5 s timer fires scheduled calls. State persists in `%APPDATA%\desk-board\cos-state.json`.

IPC (main.js): push `cos:state`; handle `cos:get` and `cos:action`.
Preload (`preload.js`): `cosGet()`, `cosAction(a)`, `onCos(cb)` on `window.board`.

### Renderer: a `chief` panel
`renderer/index.html`, `renderer/app.js`, `renderer/style.css`, `preload.js`. A system panel like
`p-memory`: the scored feed (urgency bar, decision, reason, source, sample badge), the call list
with status, a threshold control, a "call me now" button and the demo buttons. Uses `textContent`
for anything that came from outside, like the memory panel does.

## Who owns which files
| Owner | Files |
|---|---|
| calls | `cos/vapi.js`, `cos/test-vapi.js` |
| decisions | `cos/jev.js`, `cos/exa.js`, `cos/test-decide.js` |
| sources | `cos/sources/github.js`, `cos/sources/plaid.js`, `cos/test-sources.js` |
| board | `renderer/index.html`, `renderer/app.js`, `renderer/style.css`, `preload.js` |
| core | `cos/index.js`, `cos/test-core.js`, `main.js` |
