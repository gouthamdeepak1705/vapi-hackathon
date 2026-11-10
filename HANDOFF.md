# Handoff

Where the project stands, written on Mon Nov 9, 2026 at about 6:30 PM PST, for whoever picks it up
next (a person or a coding agent) on a different machine. Read this first, then `README.md`.

## What it is

An "AI chief of staff" for the Side Quest Hotline Vapi hackathon (build window ends 7:15 PM PST).
It watches GitHub, card charges and web topics, scores every event for urgency, shows them in a feed
at `http://localhost:4747`, and calls the user through a Vapi voice agent only when an event crosses
their threshold. On the call the user can ask for a call-back ("call me back in two minutes") or give
an order ("rerun the build"). Plain Node, CommonJS, no npm dependencies, no build step.

## Run it on a new machine

```
git clone https://github.com/gouthamdeepak1705/vapi-hackathon
cd vapi-hackathon
node serve.js        # Node 20 or newer; opens http://localhost:4747
npm test             # everything offline, should end with "test-serve: all checks passed"
```

The first run creates a blank settings file and prints its path. On a Mac it is
`~/Library/Application Support/desk-board/cos.json`. Keys go there and nowhere else: the repo is
public, so never commit a key, a phone number or the settings file. Edits apply without a restart.

Settings that must be filled for live mode (all are described in `keys.js` and `README.md`):

| Field | Needed for |
|---|---|
| `vapiKey` | Vapi private key: the voice agent, reading call records |
| `vapiPublicKey` | Vapi public key: calls that ring in the browser page |
| `callMode` | `"browser"` for now (see "The blocker" below); `"phone"` once a number can dial out |
| `vapiPhoneNumberId` | The Vapi number's id. Used for phone calls and for the dial-in line |
| `myPhone` | The user's mobile, like `+14155550123`. Phone mode only |
| `jevKey` | TypeSafe Jev key: urgency scoring. Without it the built-in rules score (much weaker) |
| `exaKey` | Exa key: context before a call, and web-topic watching |
| `repos` | GitHub repos to watch. Needs the `gh` CLI signed in (`gh auth status`) |

With no keys at all it runs in mock mode (sample data, simulated calls), which is enough to see the
whole flow with the demo buttons.

**Never tested on macOS.** It was built and run on Windows only. Things to check first: `npm test`
passes, the settings path above is the one `serve.js` prints, `gh` is signed in, and the browser is
allowed to use the microphone on `localhost`.

## What is proven live

- **Jev scoring**: answers in about 80 to 180 ms. On `node eval.js` (40 hand-labelled events):
  33 of 40 right, 0 of 30 false alarms and 0 of 10 misses at threshold 0.7. Rules only: 26 of 40,
  6 false alarms, 3 misses.
- **Exa**: context lookups (about 1.6 s) and the web-topic watcher both return real results.
- **Vapi key, assistant, voice (`Elliot`), Deepgram `nova-3` transcriber**: all accepted by the API.
- **Dial-in**: calling the free Vapi number from a mobile reaches the briefing assistant and it
  talks. Verified with one real call. The app refreshes that assistant's briefing while it runs.
- **GitHub source**, the page, orders, mutes, quiet hours, feedback, daily briefing, typed events:
  all pass their tests; orders against real `gh` have not been run for real.

## The blocker: the system cannot ring a phone yet

`POST /call` from the free Vapi number is refused every time with
`call.start.error-vapi-number-outbound-daily-limit` ("Numbers bought on Vapi have a daily outbound
call limit"). Vapi's docs say free Vapi numbers are inbound only. Credits do not change it. The code
is fine; the number is the problem.

What was tried:

- A second request with a minimal assistant: same refusal.
- A Twilio **trial** account: it has no number of its own (the number in Twilio's onboarding test
  call is Twilio's shared demo number, which Vapi cannot import: "Number Not Found on Twilio"), and
  claiming one through the API is refused until a phone is verified in the Twilio console.
- Having Twilio ring the user and forward the call to the Vapi dial-in number: the phone rang, but a
  trial account does not allow the forward.
- Google Voice numbers cannot be imported into Vapi.

Ways forward, best first:

1. **Ask Vapi staff** for a number that can dial out, or for the limit to be lifted. Then set
   `vapiPhoneNumberId` and `callMode: "phone"`. No code change.
2. **A Twilio number the account owns** (console: "Get a phone number", which verifies the mobile
   first; a paid upgrade removes the trial notice). Import it into Vapi (dashboard: Phone Numbers,
   Import Twilio; or `POST /phone-number` with `provider: "twilio"`, `number`, `twilioAccountSid`,
   `twilioAuthToken`), then the same two settings.
3. **Ring in the browser** (`callMode: "browser"`): built, see below. Needs no phone number.

## Ring in the browser: built, never tried with real audio

When `callMode` is `"browser"`, a call that would have dialled the phone makes the page show an
incoming-call screen with a ringtone. Answer starts a Vapi web call from the page with the public
key and the same assistant; the page reports the call id back and everything after that (reading
the call record, call-backs, orders) is the normal path.

- `vapi.js`: `call()` returns a `web-<n>` id without posting; `offer`, `attach`, `decline`;
  unanswered for 45 s counts as a missed call.
- `index.js`: `state.ring`, actions `web_offer`, `web_started`, `web_declined`, `set_call_mode`.
- `web/index.html`: the overlay, the in-call bar, the "ring my phone / ring this browser" switch.
  The SDK is loaded with `import('https://cdn.jsdelivr.net/npm/@vapi-ai/web@3.1.0/+esm')`, only in
  browser mode.

Tests pass and a headless browser showed the overlay and loaded the SDK. **Not verified**: a real
answer with a microphone, whether the id the SDK returns is the one `GET /call/{id}` expects,
whether a web call's record carries the analysis the way a phone call's does, and the ringtone's
sound. This is the first thing to try: run the app, click the demo button for the leaked API keys,
click Answer, allow the microphone, say "call me back in two minutes", hang up, and watch whether a
second ring comes two minutes later.

## Known weak spots

- The rules fallback scores typed free text badly ("prod database is at 98% disk and writes are
  failing" comes out as wait, 0.35). The "try to fool it" box needs Jev live.
- Jev's spoken reasons are generic ("Looks urgent; needs action within the hour.").
- The eval set is 40 cases written by the same people who built the scorer.
- Notifications from repos outside `repos` can reach the feed.
- `test-vapi.js --live` still prints a note calling free Vapi numbers "inbound only" in passing; it
  is true, just worded as a guess.

## Where things are

`README.md` has the file-by-file table. `ORDERS.md` and `FEATURES.md` are the specs the orders and
the extra features were built to. `eval.js` and `eval-set.json` are the accuracy check.
