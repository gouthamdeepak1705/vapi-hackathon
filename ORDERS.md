# Orders: addendum to CONTRACT.md

On a call the user can give an order ("rerun the build and call me back in two minutes", "label it
urgent and assign it to me", "stop calling me about things like this"). The voice agent repeats it
back to confirm. Nothing runs during the call, because there is no webhook: the order is read from
the call record after hang-up, carried out, and its result is reported on the board and on the next
call.

Layout note: this project is flat. `CONTRACT.md` says `cos/…` for paths; here those files sit at the
repo root (`index.js`, `vapi.js`, `sources/github.js`, `web/index.html`, …).

## Shapes

```js
// What the call produced (vapi.js -> index.js). Outcome gains one field:
Outcome.orders = [ { action, text /* string, may be '' */, confirmed /* bool: the user said yes when it was read back */ } ]   // usually 0 or 1 items

action is one of:
  'rerun_build'    // rerun the failed workflow run the call was about
  'comment'        // post `text` as a comment on the issue the call was about
  'close_issue'    // close that issue
  'label_urgent'   // put the label "urgent" on that issue
  'assign_me'      // assign that issue to the user
  'create_issue'   // open a new issue titled `text` (a to-do) in the event's repo, or the first watched repo
  'mute_similar'   // stop phoning about events with the same source and kind (they still show in the feed)
  'dispute_charge' // flag the charge; always simulated, the card feed is sandbox data

// What the board shows (index.js state). State gains:
orders: [ { id, at /* ISO */, action, eventId /* or null */, title /* the target event's title, or '' */, text,
            status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped',
            result /* one spoken-style sentence, '' until known */, simulated /* bool */, callId /* or null */ } ]   // newest first, capped at 30
mutes:  [ { id, source, kind, label /* e.g. "github issues" */, at } ]
settings: { threshold, myPhoneSet, ordersMode, quietHours }
```

## `orders.js` (new)
```js
module.exports = ({ cfg, log, exec }) => ({ run, check, describe })
run(order /* { action, text } */, event /* the target Event or null */) -> Promise<{ ok, result /* one sentence */, simulated, ref /* opaque, for check */ }>   // never throws
check(order /* a state order with ref */)  -> Promise<{ result } | null>   // a fresher result if there is one (did the rerun pass?), else null; never throws
describe(action) -> short human phrase, e.g. 'rerun the build'
module.exports.ACTIONS = [ ...the action names above... ]
```
- Uses the signed-in `gh` CLI through `execFile` (no shell), 15 s timeout. `exec` is injectable for tests.
- Acts only on repos listed in `cfg().repos`, and only on the event it is given. Never deletes, merges, pushes or edits code.
- Events with `source: 'demo'` or `sample: true` are never acted on for real: the result says what would have been done and `simulated` is true.
- `mute_similar` is not handled here (the orchestrator owns mutes).

## `index.js` behaviour
- When a call ends with `outcome.orders`: the target is the first event the call was about (`eventIds[0]`), or null.
  `cfg().ordersMode`: `'off'` -> recorded as 'skipped'; `'ask'` -> 'waiting' until the user presses run on the board;
  `'auto'` (default) -> run now if `confirmed`, otherwise 'waiting'.
- New actions: `{type:'order', action, eventId?, text?}` (give an order from the board; runs at once unless ordersMode is 'off'),
  `{type:'run_order', id}`, `{type:'skip_order', id}`, `{type:'unmute', id}`, `{type:'set_orders_mode', value: 'auto'|'ask'|'off'}`
  (saved with `cfg.save`), and `{type:'demo', scenario:'order'}`: a failed build on main as a demo event which, when no Vapi key
  is set, makes the simulated call come back with a confirmed `rerun_build` order (the `[mock:order]` marker is added to that
  call's briefing by the orchestrator, never shown in the feed).
- Every action answers `{ ok, error? }` as before. Orders run in the background: the action returns once the order is recorded,
  and the state is pushed again when its status changes.
- `mute_similar` adds `{ source, kind }` of the target to `mutes`. A muted event is still scored and shown, but its decision is
  capped at 'brief' and its reason gets " Muted by you." appended.
- Every call's briefing includes a short "Orders you gave" section for orders from the last 2 hours with their results;
  before a call is placed, orders with a `ref` get one `check` (all together, at most 4 s) so the call can say "the rerun passed".
- Quiet hours: `cfg().quietHours` like `"23:00-07:00"` (local time, '' = off). Inside them only urgency >= 0.9 places a call;
  scheduled calls and `call_now` are unaffected.

## `vapi.js` changes
- The outbound prompt tells the agent which orders it can take (in plain words), that they are carried out right after the call
  ends, that it must repeat the order back in one sentence and get a yes, and that anything else (merging, deleting, paying,
  sending money, changing code) is refused politely.
- The structured data gains flat fields (no nested arrays, to keep Vapi's schema check happy): `orderAction` (string, one of the
  actions or 'none'), `orderText` (string), `orderConfirmed` (boolean). `outcomeFrom` turns them into `Outcome.orders`.
- Transcript safety net: "rerun"/"re-run"/"run it again" in a user line gives a `rerun_build` order with `confirmed: false`.
- Mock mode: the marker `[mock:order]` in the reason or briefing makes the canned outcome carry
  `{ action: 'rerun_build', text: '', confirmed: true }`.
