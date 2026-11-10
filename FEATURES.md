# More features: addendum to CONTRACT.md and ORDERS.md

Four additions. The project is flat (`index.js`, `sources/…`, `web/index.html` at the repo root).

## 1. "Try to fool it": type any event in your own words
- Action `{ type: 'custom', text }` (text 3 to 300 characters after trimming). It becomes an Event
  `{ id: 'custom:<unique>', source: 'custom', kind: 'custom', title: <text cut to 140>, detail: <text>, ts: now, sample: true }`
  and goes through the same path as any new event: scored, context looked up, and phoned about if it crosses the threshold.
- Because it is `sample: true`, any order given about it is simulated.

## 2. Watch the web (`sources/watch.js`, already specified and being built)
- `require('./sources/watch')({ cfg, log })` gives `{ name: 'watch', poll, health }` like the other sources. Topics are `cfg().watches`
  (array of strings, at most 5). Its events have `source: 'watch'`, `kind: 'news'`, a `topic` field, and `baseline: true` on the
  ones that were already out when the topic was first searched.
- An event with `baseline: true` never places a call: its decision is capped at 'brief' and its reason gets
  " Already out when you started watching." appended.
- Actions `{ type: 'add_watch', topic }` (trimmed, 3 to 120 characters, at most 5 topics, no duplicates ignoring case) and
  `{ type: 'remove_watch', topic }`, both saved with `cfg.save({ watches })`. After `add_watch` a poll is started at once (not awaited).
- State: `settings.watches` (array of strings) and `health.watch`.

## 3. "Was that worth a call?"
- Action `{ type: 'feedback', eventId, value: 'good' | 'bad' | null }` sets `feedback` on that event in the state (null clears it).
- The six most recent feedback items are appended to the profile text given to the scorer, one line each:
  `The user said a call about "<title cut to 100>" was not worth it.` / `… was worth it.`
- For each source and kind, when (bad count minus good count) is 2 or more, newly scored events of that source and kind get
  0.15 taken off their urgency (not below 0) and " You said calls like this weren't worth it." appended to the reason.
  Nothing else about the score changes.

## 4. Daily briefing call
- `cfg().dailyBriefing`: `'HH:MM'` in local time, `''` = off (default). Action `{ type: 'set_daily', value }` validates and saves it.
- While it is set there is always exactly one scheduled call with `daily: true` and topic "Your daily briefing", at the next
  occurrence of that time (today if still ahead, otherwise tomorrow). When it has been placed, failed or cancelled, the next one
  is scheduled. Changing or clearing the time replaces or removes the pending one. It uses the existing scheduled-call path.
- State: `settings.dailyBriefing`.

## Summary of state additions
```js
events[i].feedback   // 'good' | 'bad' | undefined
events[i].topic, events[i].baseline   // watch events only
calls[i].daily       // true on the daily briefing call
settings: { threshold, myPhoneSet, ordersMode, quietHours, watches, dailyBriefing }
health:   { github, plaid, watch, jev, exa, vapi }
```
Every action answers `{ ok, error? }` with a short plain sentence in `error`.
