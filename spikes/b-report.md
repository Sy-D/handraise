VERDICT: CORE=green GATES=green E2E=green (handoff end to end 6.3 s, whole run 27.8 s, red-then-green proven)

# Agent B — `raiseHand()`, the core

Everything between "the agent is stuck" and "the agent is signed in because a
human helped". Built 2026-09-01 on top of Agent A's relay and Agent C's target
app, against SDK `@solarisdk/browser@0.1.2` / `@solarisdk/sdk@0.1.2`, Chromium
151, bun 1.4.0.

---

## 1. What was built

| Path | Lines | What it is |
|---|---|---|
| `src/core/raise-hand.ts` | 237 | The orchestration. Relay → CDP → cast → notify → wait → settle → tear everything down. |
| `src/core/screencast.ts` | 219 | The forward channel. Ack-paced frame pump, plus the JPEG size the phone needs to map a tap. |
| `src/core/input.ts` | 247 | The return channel. Frame pixels → page pixels, and human messages → CDP input events. |
| `src/core/socket.ts` | 161 | The agent's relay WebSocket: heartbeat, reconnect, typed dispatch. |
| `src/qr.ts` | 41 | QR code for the terminal. |
| `src/webhook.ts` | 47 | One POST, failures logged not thrown. |
| `src/index.ts` | 25 | Public surface: `raiseHand` + the types from `types.ts`. |
| `src/core/input.test.ts` | 231 | 14 tests: the coordinate maths and every CDP event shape. |
| `src/core/screencast.test.ts` | 222 | 8 tests: JPEG parsing, ack ordering, stop. |
| `src/core/socket.test.ts` | 320 | 7 tests against the real relay and a bare `ws` server. |
| `src/qr.test.ts` | 37 | 2 tests. They exist because of the bug in §5. |
| `e2e/handoff.e2e.ts` | 286 | The live proof. 21 assertions, two outcomes. |
| `e2e/human-sim.ts` | 180 | The scripted human: a WebSocket client that only speaks the public protocol. |

> **One file outside the assigned list.** `src/core/socket.ts` was not named in
> the brief. Heartbeat, backoff reconnect and message dispatch are ~160 lines of
> stateful behaviour that needs its own tests against a server I can drop the
> connection on; folding it into `raise-hand.ts` would have made the
> orchestration untestable without a browser. Nothing else was touched:
> `types.ts`, `protocol.ts`, `deploy.ts`, `test-app/**` and `package.json` are
> unmodified.

### The shape of `raiseHand`

```ts
const result = await raiseHand(page, {
  reason: "Aurora Bank is asking for a 2FA code",
  webhookUrl: process.env.SLACK_WEBHOOK,   // optional
  onUrl: (url) => console.log(url),        // optional
  timeoutMs: 5 * 60_000,                   // default
  qr: true,                                // default
})
// result: { outcome, durationMs, url, storageState? }
```

Failure policy, which is the part that matters when this runs inside somebody
else's automation:

- It throws **only** if `startRelay()` fails, i.e. before any URL exists and
  before a human could have been asked for anything.
- After the URL exists it never throws. A dead browser session, a rejected CDP
  call, a webhook that 500s, an `onUrl` callback that throws — each becomes an
  `outcome` and a log line.
- Every path kills the relay sandbox, stops the cast, detaches CDP, clears the
  timeout and removes its listeners. The promise settles exactly once, which
  falls out of using a `Promise` resolve as the settle function rather than a
  flag.

### The three mechanisms

**Ack pacing.** `Page.screencastFrameAck` is sent *after* the frame has been
written to the relay socket, never before. That is not tidiness: S2 measured 3
frames in 8.3 s without acks versus 199 with, and the API has no bitrate knob,
so the ack is the only throttle there is. The socket's `send()` resolves from
`ws.send`'s write callback, so "written" means written. If the write fails the
frame is dropped and the ack still goes out — a missing ack stops the stream
permanently, a dropped frame costs 80 ms.

**Coordinates.** The frame is scaled, the metadata is not. `FrameMeta` carries
both sizes and the mapping divides by the ratio, per axis, then by
`pageScaleFactor`. No scroll offsets (CDP input is viewport-relative), no
device pixel ratio (CDP input is CSS pixels). `jpegWidth`/`jpegHeight` come from
parsing the JPEG's SOF marker — CDP does not report them — cached per viewport
so the pump does not base64-decode thirteen frames a second.

**Serialised input.** A human typing six digits sends them faster than a round
trip to `us-west` takes. `createInputTarget` chains every `apply()` onto the
previous one, so "71" cannot arrive as "17".

---

## 2. Gate output (real)

```
$ ./node_modules/.bin/tsc --noEmit
exit=0

$ ./node_modules/.bin/biome check .
Checked 32 files in 37ms. No fixes applied.
Found 2 infos.                                  exit=0
  (the 2 infos are pre-existing: biome.json's $schema says 2.0.0 against
   CLI 2.5.11, and `linter.rules.recommended` is deprecated. Not mine.)

$ ./node_modules/.bin/oxlint
exit=0                                          (no output, no warnings)

$ bun test src/ test-app/
 72 pass / 0 fail / 208 expect() calls          [2.96s]
  (41 were there before; 31 are new)

$ bun scripts/embed-guest.ts --check
guest-source.ts is in sync with guest/server.js
$ bun test-app/embed-app.ts --check
guest-source.ts is up to date
```

No rule was suppressed and no gate was weakened. Four anti-slop rules pushed
back during the build and each was answered by changing the code, not the
config: `no-known-value-widening` (anonymous object return types → named
`FrameScale` and `PixelSize`), `no-unsafe-dictionary-type` (`Record<string,
unknown>` in the test recorders → named parameter contracts),
`no-conditional-empty-object-spread` (the `...(x ? {a} : {})` idiom in the key
dispatch → an explicit branch) and `require-safety-comment-for-type-assertion`.

### Every gate was watched failing

Per "a gate you have never seen fail is untested", each new test was mutated
until it went red, then restored:

| Mutation | Result |
|---|---|
| `Enter` loses its `text: "\r"` | `(fail) Enter carries text so that Blink fires keypress and submits the form` — 13 pass, 1 fail |
| Ack moved *before* the write | `(fail) the ack is sent after the frame is written, which is the flow control` — 7 pass, 1 fail |
| Reconnect timer removed | `(fail) a socket dropped mid-handoff comes back` **and** `(fail) the state is re-sent on every connect` — 5 pass, 2 fail |
| `import { generate }` restored in qr.ts | both QR tests fail — 0 pass, 2 fail |

Plus the e2e, which is §4.

---

## 3. The deviation from the brief, and why

**The brief said: "Enter/Backspace/Tab → rawKeyDown/keyUp ohne text". Enter is
the exception and it is load-bearing.**

Blink triggers implicit form submission from the **`keypress`** handler, and
`rawKeyDown` produces no `keypress`. An Enter sent as `rawKeyDown` fires a
`keydown` the page can see, looks correct in any listener log, and never
submits the form. S3 verified the working form (`spikes/s3-report.md` line 137):
`keyDown` with `text: "\r"`, which produces the keypress and inserts no
character.

`input.ts` therefore sends Enter as `keyDown` + `text: "\r"`, and Backspace and
Tab as `rawKeyDown` with no text, exactly as S3 documented. The e2e proves it:
the human's Enter is what submits the TOTP form. There is a unit test whose only
job is to stop somebody "fixing" this back.

---

## 4. The e2e: red, then green

`bun --env-file=.env e2e/handoff.e2e.ts`. One Solari browser session and two
sandboxes — the test app and the relay — which is the entire plan allowance, so
nothing else may run at the same time. `spikes/s1/cleanup.ts` listed nothing
before each run and nothing after.

The choreography: the agent logs into Aurora Bank with ordinary Playwright,
hits the TOTP wall, and calls `raiseHand`. A **separate WebSocket client** —
`e2e/human-sim.ts`, which knows nothing about handraise's internals and speaks
only the public wire protocol — loads the handoff page over HTTP, connects as
`role=human`, waits for a frame, taps the code field, types six characters one
message at a time, presses Enter, waits for `/account`, and hands back.

### The red run

`HANDRAISE_E2E_FAULT=wrong-code` makes the human type a wrong six-digit code and
changes nothing else.

```
{"t":6121,"event":"assertion_passed","what":"the agent is stuck on the 2FA page"}
{"t":8790,"event":"handoff_url","ms":2669}
{"t":9787,"event":"first_frame","ms":3666,"jpeg":"800x500","device":"1280x800","bytes":7946}
{"t":9787,"event":"assertion_passed","what":"metadata reports the CSS viewport"}
{"t":9787,"event":"assertion_passed","what":"the frame is scaled to the 800px profile"}
{"t":9787,"event":"assertion_passed","what":"the phone shows the reason the agent gave"}
{"t":11148,"event":"assertion_passed","what":"the tap focused the field the human aimed at"}
{"t":11149,"event":"human_types","fault":"wrong-code"}
{"t":13665,"event":"assertion_passed","what":"every character arrived in the field (saw \"835174\")"}
{"t":34783,"event":"cleaned_up"}
error: ASSERTION FAILED: Enter submitted the form and the code was accepted
EXIT=1
```

The handoff worked perfectly and the run still failed, which is the point: the
tap landed, all six wrong characters arrived, Enter submitted the form, the app
answered 401, the page stayed on `/totp`, and the assertion caught it. The
"signed in" chain is load-bearing, not decorative.

The red run also exercised a path the green one does not: the assertion threw
while a handoff was still open, the `finally` closed the browser, `raiseHand`
reported `disconnected` and released its relay. `cleanup.ts` listed nothing
afterwards — **a failing run leaks no sandbox.**

### The green run

Same file, no fault injection. 21 assertions, exit 0.

```
{"t":2990,"event":"test_app_ready"}
{"t":4677,"event":"browser_ready","ms":1687}
{"t":5795,"event":"assertion_passed","what":"the agent is stuck on the 2FA page"}
{"t":8545,"event":"handoff_url","ms":2750}
{"t":9465,"event":"first_frame","ms":3670,"jpeg":"800x500","device":"1280x800","bytes":7946}
{"t":10844,"event":"assertion_passed","what":"the tap focused the field the human aimed at"}
{"t":13447,"event":"assertion_passed","what":"every character arrived in the field (saw \"791561\")"}
{"t":13949,"event":"assertion_passed","what":"Enter submitted the form and the code was accepted"}
{"t":13949,"event":"assertion_passed","what":"the cast kept running across the navigation"}
{"t":14877,"event":"handoff_done","outcome":"resolved","durationMs":6333,"cookies":4,"ms":9082}
{"t":14877,"event":"assertion_passed","what":"the handoff resolved"}
{"t":14877,"event":"assertion_passed","what":"storageState was captured"}
{"t":14877,"event":"assertion_passed","what":"storageState carries the session cookie the human earned"}
{"t":14877,"event":"assertion_passed","what":"the phone was told the handoff ended"}
{"t":15370,"event":"assertion_passed","what":"the agent is signed in as ada (saw \"Signed in as ada\")"}
{"t":15551,"event":"assertion_passed","what":"the relay sandbox is gone (404)"}
{"t":27583,"event":"timeout_case","outcome":"timeout","durationMs":8554,"ms":12032}
{"t":27583,"event":"assertion_passed","what":"an unanswered handoff times out"}
{"t":27583,"event":"assertion_passed","what":"it waited the full 8000ms (8554ms)"}
{"t":27583,"event":"assertion_passed","what":"a timed-out handoff captures no cookies"}
{"t":27770,"event":"assertion_passed","what":"its relay was destroyed too (404)"}
{"evt":"e2e_passed","totalMs":27770}
```

### Measured

| Measurement | Value | Reading |
|---|---|---|
| **Handoff, end to end** | **6333 ms** (`result.durationMs`) | From the URL existing to the human handing back — tap, six keystrokes, Enter, a form POST and a redirect. |
| `raiseHand()` → public URL | **2750 ms** | The relay cold start. Matches A's 3113 ms. |
| URL → first frame on the phone | 920 ms | Page fetch, WebSocket upgrade, `Page.enable`, `startScreencast`, first repaint. |
| Stuck → the human can see it | **3670 ms** | The number that matters for the product. |
| Tap → the field is focused | ~1300 ms | One relay hop plus three CDP round trips to `us-west`. |
| Six characters typed | **2603 ms** | ~430 ms per character: two serialised CDP calls each, from Germany. |
| Enter → `/account` | ~500 ms | The form POST and redirect happen in the cloud. |
| Handback → `raiseHand` returns | 928 ms | `storageState()`, `ended`, stop cast, detach, `relay.kill()`. |
| Frame size | **7946 bytes** | 800x500 q60 of the Aurora Bank TOTP page. Cheaper than S2's GitHub frame (11.6 KB). |
| `timeoutMs: 8000` → returned after | 8554 ms | 554 ms of teardown on top of the wait. |
| Relay after `kill()` | **404**, both times | Nothing leaks, on either outcome. |
| Whole run | 27.8 s | Two sandboxes, one browser session, cold. |

`storageState` came back with **4 cookies**, including the `hr_session` the
human earned. That is the part that makes a handoff worth more than a live
view: the caller can persist it and relaunch when the session dies.

---

## 5. The bug the fourth stage caught

`src/qr.ts` originally did `import { generate } from "qrcode-terminal"`. It
typechecked, it linted, `raiseHand` called it, and it printed no QR code — only

```
handraise: could not draw the QR code
error: bad rs block @ typeNumber:1/errorCorrectLevel:undefined
```

`qrcode-terminal`'s `generate` reads its error-correction level off `this`
(`new QRCode(-1, this.error)`), so a destructured reference loses the binding.
The original code caught the throw and logged it, which means the headline
onboarding feature — scan this with your phone — would have shipped broken and
quiet.

Found by running it once, by hand, outside the e2e (the e2e passes `qr: false`).
Fixed with a namespace import, and `src/qr.test.ts` now asserts the code renders
with the right block characters and a square symbol. Restoring the named import
turns both tests red.

---

## 6. Contract problems, documented not fixed

`types.ts` and `protocol.ts` were treated as read-only. Four gaps; none blocked
the work, all cost something.

**1. There is nowhere to pass the API key.** `RaiseHandOptions` has no `apiKey`,
and `raiseHand` receives a `Page`, which cannot see the Solari client that
created it. So `raise-hand.ts` reads `process.env.SOLARI_API_KEY` and throws a
named error if it is missing. That is a hidden dependency in a library's main
entry point, and the one thing a caller who already holds a `SolariClient`
cannot override. Recommend adding `apiKey?: string` to `RaiseHandOptions`,
falling back to the environment.

**2. `ended` has three outcomes; the library has four.** `AgentToHuman`'s
`ended` allows `resolved | aborted | timeout`, and `HandoffOutcome` adds
`disconnected`. A dead session is currently reported to the phone as `aborted`
("You can close this tab"), because the UI's fallback for an unknown outcome is
`resolved` — which would tell the human the agent is driving again when it is
not. The fix is a `disconnected` member in `protocol.ts` and one line in
`ENDINGS` in `guest/server.js`. Two files, neither mine.

**3. Nobody can tell that the human closed the tab.** Confirmed as A described
it: the relay answers `ping` itself and forwards nothing, so a pong proves the
relay is alive and nothing about the peer. The honest answer today is the
timeout, and the default is 5 minutes. Fine for v1; it needs saying in the
README rather than fixing in the code.

**4. `FrameMeta` has no `offsetTop`.** S3 recommends subtracting it. It was 0 in
every measurement (headless has no browser chrome) and it was 0 again in the
e2e — the tap landed on a field roughly 300 px down the page and focused it.
Left alone. If handraise ever casts a headed browser, this is the first thing
that breaks.

Also carried over from A, both fine as-is: `key: "Tab"` is implemented although
no client sends it, and the relay sandbox is created with
`timeoutMs = handoff timeout + 5 min` so its idle window can never expire under
a live handoff.

---

## 7. Cost

Per handoff: **one sandbox** for the length of the handoff (the relay; the
browser session is the caller's and existed already), one `previewUrl` call, and
23–80 KB/s of JPEG while a human reads and types — 7.9 KB per frame on a form
page, and a form page only repaints when something moves. A five-minute handoff
at the busy end is roughly 10–25 MB. Cold start is ~2.8 s of sandbox time before
anyone can look at it.

This build cost **3 live runs**: one red that failed early on a bad fixed sleep
in the test, one red that failed exactly where it should, one green. Each run is
2 sandboxes plus 1 browser session for well under a minute — about 90 s of
sandbox time and 80 s of browser time in total. No session was left running;
`cleanup.ts` listed nothing after every run.

The 2-sandbox concurrency cap is the real constraint, not money: **the e2e uses
both slots**, so it cannot run beside anything else, and two concurrent handoffs
in production would already exhaust the plan. S4's recommendation to share one
relay across handoffs is the fix if that ever matters.

---

## 8. Open points

1. **`package.json`'s `test:e2e` does not run this e2e.** `bun test e2e/` only
   collects `*.test.ts` / `*.spec.ts`, and the file is `handoff.e2e.ts` — a
   script, not a bun-test file, because it drives real infrastructure and must
   own its own teardown. Suggest
   `"test:e2e": "bun --env-file=.env e2e/handoff.e2e.ts"`. Supervisor's file.
2. **`abort` is implemented and not proven live.** The unit tests cover the
   message reaching `raiseHand`, and the mobile UI sends it (A §5), but no live
   run has clicked it. It is one line away from the `handback` path that is
   proven. `disconnected` *was* exercised live, by the red run.
3. **~430 ms per keystroke** is the current cost of a character from Germany to
   `us-west`: two CDP calls, awaited in sequence. Issuing `keyDown` and `keyUp`
   without awaiting between them would halve it — Playwright writes to the CDP
   socket in call order, so ordering survives — but it trades away the error
   that tells us the session died. Not taken; worth a measurement later.
4. **No reconnect test against a real 60 s idle kill.** The reconnect logic is
   tested against a bare server that terminates the socket and against the real
   relay's takeover-close. A genuine 1006 from the preview proxy takes 60 s of
   silence to provoke and the heartbeat exists to prevent it. S1 measured the
   behaviour; this is a deliberate gap.
5. **The screencast profile is fixed** at q60/800 px. S2 measured a mobile
   profile (q40/480 px) at 3.5x cheaper under motion. There is no option for it
   because `RaiseHandOptions` has no room for one and nothing has yet been slow
   enough to need it.
