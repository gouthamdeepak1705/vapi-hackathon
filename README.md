# Chief of staff

It watches everything so you don't have to, and it phones you only when something crosses your line.

Every event from GitHub and your card gets an urgency score. Most of them wait quietly in a feed.
When one scores above your threshold, your phone rings and a voice agent tells you what happened and
why it matters. On the call you can say "call me back in two minutes with a summary" or "call me at
2 PM about the build", and it does.

You can also give it an order on the call: "rerun the build", "label it urgent and assign it to me",
"open an issue to rotate the key", "stop calling me about things like this". It reads the order back,
and carries it out as soon as you hang up. The result shows on the page and is the first thing it
tells you on the next call.

Other things it does:

- **Try to fool it.** Type any event in your own words on the page and see whether it would ring.
- **Watch the web.** Name up to five topics; Exa is searched every few minutes and only results that
  are new since you started watching are scored.
- **Was that worth a call?** Mark a call as worth it or not. Two "not worth it" on the same kind of
  event lowers the urgency of that kind from then on, and your answers are given to the scorer.
- **Daily briefing call** at a time you set, with everything that waited.
- **Mute and quiet hours.** "Stop calling me about things like this" keeps a kind of event in the feed
  without ringing; inside quiet hours only the most urgent events ring.

## Run it

Needs Node 20 or newer and nothing else. There is no install step.

```
node serve.js
```

It opens `http://localhost:4747`. With no keys it runs in mock mode: sample card charges, built-in
scoring rules and simulated calls, so the whole flow can be tried straight away with the demo buttons.

## Keys

On first run it creates a blank settings file and prints its path
(`~/Library/Application Support/desk-board/cos.json` on a Mac, `%APPDATA%\desk-board\cos.json` on
Windows). Edits apply without a restart. The file lives outside this repo on purpose.

| Field | What it is |
|---|---|
| `vapiKey`, `vapiPhoneNumberId` | Vapi private key and the id of a number that can place outbound calls |
| `myPhone` | The number to ring, like `+14155550123` |
| `callMode`, `vapiPublicKey` | `phone` rings your phone. `browser` rings the page instead and you talk through the laptop; it needs the Vapi public key and no phone number |
| `jevKey` | TypeSafe Jev key (set `jevBase` to `https://openrouter.ai/api/v1` for an OpenRouter key) |
| `exaKey` | Exa key |
| `plaidClientId`, `plaidSecret` | Optional. Plaid sandbox keys; without them the card feed is sample data |
| `repos` | GitHub repos to watch, like `["owner/name"]`. Uses the signed-in `gh` CLI |
| `threshold` | Urgency from 0 to 1 above which it calls. Default 0.7 |
| `maxCallsPerHour` | Default 6 |
| `profile` | A few lines about you, given to the scorer and the voice agent |
| `ordersMode` | What happens to an order given on a call: `auto` runs it once you confirmed it, `ask` waits for a click on the page, `off` ignores it |
| `quietHours` | Like `23:00-07:00`. Inside them only urgency 0.9 and up rings |
| `watches`, `watchMinutes` | Topics to watch on the web, like `["OpenAI API pricing changes"]`, and how often each is searched (default 5 minutes). Needs `exaKey` |
| `dailyBriefing` | Like `09:00`. A briefing call every day at that local time |

## How it works

| Part | File | Job |
|---|---|---|
| Sources | `sources/github.js`, `sources/plaid.js`, `sources/watch.js` | Failed builds, new issues, security alerts, notifications; card charges (Plaid sandbox, test data); new web results on your topics |
| Scoring | `jev.js` | One Jev request per event: a call / wait / ignore choice, a severity score and yes/no questions that build the spoken reason. Falls back to rules within 2.5 s |
| Context | `exa.js` | Looks up an unknown merchant, an advisory or a build error before the call. For a charge only the merchant name is sent |
| Phone | `vapi.js` | Places the call with the briefing in the agent's prompt, Deepgram as transcriber, then reads the call record for "call me back at..." |
| Orders | `orders.js` | Carries out what you said on the call with the GitHub CLI: rerun, comment, close, label, assign, open an issue. Only on the repos in `repos`, only on the event the call was about; it cannot delete, merge or push. Sample and demo events are simulated |
| Loop | `index.js` | Poll, dedupe, score, decide, call, schedule, run orders. One call at a time and an hourly cap |
| Page | `serve.js`, `web/index.html` | The feed, call status, threshold slider and demo buttons. Listens on this machine only |

No tunnel or webhook is needed: context goes in when the call is created and results are read back by
polling, so it works on any Wi-Fi.

## How often is it wrong?

```
node eval.js            # 40 hand-labelled events, 8 of them written to be misleading
node eval.js --rules    # the built-in fallback rules only
node eval.js --sweep    # false alarms and misses at each threshold
```

It prints the two numbers that matter for something that rings your phone: false alarms (it rang and
should not have) and misses (it should have rung and did not).

## Tests

```
npm test
```

Everything runs offline against mock mode. `node test-vapi.js --live` checks a real Vapi key and lists
which numbers can place calls; `node test-vapi.js --live --call` places one real test call.
