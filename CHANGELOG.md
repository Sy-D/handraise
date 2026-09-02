# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.6.0

QR passthrough, and typed errors on everything `raiseHand` throws.

A device-change check draws a QR code and asks for a phone — and handraise's
human is holding that phone, looking at the code on its screen. A phone cannot
scan itself, so until now this needed a second device. The agent reads the code
off the page instead and hands the human the link.

The QR half is additive: no existing call, type or outcome changes. The errors
half is not entirely — a page that is already dead now throws instead of
returning `disconnected`. Both are under **Changed**.

### Added

- **A `Scan QR` key on the phone, in takeover mode.** It asks the agent to read
  the QR codes on the page; the answer arrives as a sheet showing what each one
  said, with **Open in new tab** and **Copy**. The button is disabled while a
  scan is in flight and releases itself if no answer comes.
- **Two protocol messages**: human→agent `{ type: "scanqr" }`, and agent→human
  `{ type: "links", links: ScannedLink[], source: "qr" }` — always sent, with
  an empty list when nothing decoded, because silence reads as a broken button.
  The relay routes `scanqr` in takeover mode only.
- **`scanQrLinks(png)` and `OPENABLE_SCHEMES` are exported.** The decoder is
  usable without a human: hand it a PNG screenshot, get back up to two
  `{ text, kind }`. `kind` is `"url"` only for `http:`, `https:`, `tel:`,
  `mailto:` and `otpauth:` with no control characters and no credentials in the
  authority; everything else is `"text"` with a Copy button and no anchor. The
  phone applies that whole rule again itself rather than trusting a label that
  crossed a socket a stranger holding the link can write to, and an openable
  link is displayed, anchored and copied as the address it resolves to — so a
  homograph host or a right-to-left override cannot show one address and open
  another. The PNG decoder bounds its own inflate by the size the header
  promised, so a crafted image cannot allocate a gigabyte.
- **`HandoffEvent.qrScans` and `HandoffEvent.qrHits`.** Two new **required**
  number fields on the wide event — additive for callers, who receive the
  event rather than construct it, but a TypeScript consumer that builds a
  `HandoffEvent` literal in a test will need them. Both are 0 in approval mode,
  which offers no scan. `qrScans - qrHits` is the number worth watching.
- **`jsqr` as a runtime dependency** (pure JavaScript, no dependencies of its
  own), and a PNG decoder written against `node:zlib` in `src/core/png.ts`.
  `BarcodeDetector` does not exist in Solari's Chromium, so the decode happens
  in the agent process — never in the remote page, whose JavaScript belongs to
  whoever the agent got stuck on.
- **[ADR 0008](docs/adr/0008-qr-passthrough.md)** and
  **[measurement 05](docs/measurements/05-qr.md)**, reproducible with
  `bun --env-file=.env scripts/measure-qr-decode.ts`.
- **Typed errors: `HandraiseError`, `HandraiseErrorCode`, `isHandraiseError`.**
  Everything `raiseHand` throws now carries a `code` you can branch on —
  `missing_api_key`, `invalid_mode`, `empty_action`, `browser_unusable`,
  `relay_start_failed`, `concurrency_limit`, `relay_not_ready` — plus the
  SDK, CDP or network error as `cause`, with any credential in it redacted. `concurrency_limit` is the
  one worth retrying: it means your Solari account is at its concurrent
  session cap, not that anything is broken. When to expect each code, and what
  to do about it, is in the README's [Errors](README.md#errors) table. The
  messages were never a contract; they can still be reworded in any release.
  Outcomes are unchanged and still values: a human who never came, a session
  that died mid-handoff and a webhook that 500s are not exceptions.
- **A broken logger can no longer end a handoff.** `logger` is your object,
  and handraise calls it from `catch` blocks and promise callbacks. Three ways
  it breaks are contained where the logger enters handraise: a method that
  throws (a pino instance over a closed transport), a method that is a getter
  and throws on the property read, and a method that is `async` and rejects —
  TypeScript accepts one where `Logger` declares `void`, and the rejection then
  belongs to a promise nobody holds, which ends the process. One of the call
  sites is the webhook notification, which `raiseHand` fires and only awaits
  minutes later, long after the handoff URL exists. A broken logger costs a log
  line.
- **The relay health poll enforces its deadline.** Each attempt carries
  `AbortSignal.timeout`, so a preview URL that accepts the connection and never
  answers ends as `relay_not_ready` at the deadline instead of blocking
  `raiseHand` for minutes with a live sandbox burning its idle window. The
  "Last answer" in that message is now the URL's own — a 401 from the preview
  proxy, a refused connection — instead of the abort of a final request that
  had no time left to make.
- **The preview token is redacted out of error messages and out of `cause`.**
  It is a live bearer credential for the relay, and a proxy that echoes the
  request URI in its 401 body would otherwise put it in an exception message.
  Where the exact value is known — the health poll, the teardown failure and
  the wrapped start failure all hold the URL that carries it — that value is
  removed by comparison in each of the forms an escaping proxy produces: bare,
  percent-encoded, and with its dots written `%2E`, `%2e` or `&#46;`. Three
  patterns are the net for foreign text where the value is not known:
  `pt_token=…` in any case or separator, a `pt_`-prefixed value, and the JWT
  shape the preview token actually has (three base64url segments, separator
  literal or escaped — see `docs/measurements/01-preview-transport.md` §3). The
  SDK error attached as `cause` goes through the same redaction, because every
  error serialiser prints the whole chain. A proxy that invents an encoding
  none of those cover — folding the value across lines, say — is still a leak;
  this is a net, not a proof.

### Changed

- **Node 20 or newer is now declared** (`engines.node >= 20`, build target
  `node20`). It always was the floor: `@solarisdk/browser` and the patchright
  runtime it wraps require Node 20, so a Node 18 install never worked; the
  package just did not say so.
- **`src/relay/guest/server.js` names its wire vocabulary.** `MSG` and `MODE`
  replace the bare strings the untyped relay compared against, and the mobile
  page it serves is handed the same object at serve time instead of keeping its
  own copy. `relay.test.ts` asserts `MSG` against the TypeScript protocol's own
  unions, so neither side can grow a message alone. No behaviour change.
- **A page that is already dead is now refused instead of handed off.**
  `raiseHand` used to create a relay, fail on the first CDP call and *return*
  `{ outcome: "disconnected" }`. It now throws a `HandraiseError`
  (`browser_unusable`) before anything is created — no sandbox, no QR code, no
  person's attention spent on a page nobody can drive. **If you only branched
  on `result.outcome`, add a `catch`.** It reads local state only
  (`page.isClosed()`, `browser.isConnected()`), so a Solari session that has
  died server-side while the CDP socket is still open is unaffected and still
  arrives as the `disconnected` outcome.
- **Solari SDK errors no longer escape `raiseHand` unchanged.** They are
  wrapped in a `HandraiseError`, with the SDK's error kept as `error.cause`.
  Branch on `error.code === "concurrency_limit"`; if you must have the class,
  it is `error.cause`, and `error.cause.status === 429` is the check that
  survives a second copy of `@solarisdk/core` in your tree. `cause` is the SDK's
  error with credentials redacted: a copy carrying the same prototype and the
  same property descriptors — so `name`, `status`, `code`, the non-enumerable
  `message` and `stack`, and the `cause` chain hanging off it all survive, and
  `JSON.stringify(cause)` still produces what it did — with `message`, `stack`,
  the parsed `body` and every nested `cause` rewritten. An error that cannot be
  copied without running its own code (a throwing getter, a body that
  references itself) becomes a plain redacted `Error` rather than an exception.
  Apart from the page check above, nothing throws that did not throw before,
  and no outcome became an exception.

### Known limits

- A scan takes a fresh full-resolution `page.screenshot()`, 293 ms p50 measured
  from Germany. It is rate-limited to one per 2 s in the core.
- A symbol drawn below about 120 CSS pixels does not decode. The live cast
  frame — 800 px, JPEG quality 60 — fails well before that, which is why the
  scan does not reuse it.
- A code the page drew at a resampled size can be sharp and still not be found
  on the first pass, so a scan looks again at 2x and then at four overlapping
  corners. A page with no code at all pays all three, about 320 ms of CPU.
- Two codes on one screen need a tiled second pass to be found at all; three or
  more are not attempted.
- **reCAPTCHA itself is untested.** Its demo never served the scan-to-verify
  variant, which Google shows at its own discretion. The mechanism is proven
  end to end in the live e2e against a page that behaves the same way.

## [0.5.1] - 2026-09-02

Republish of 0.5.0 with no code change. 0.5.0 was published to npm and
unpublished again within two minutes, and npm does not let a removed version
number be reused, so the same release ships as 0.5.1. Everything below under
0.5.0 applies.

## [0.5.0] - 2026-09-02

Channels. 0.4.0 made an approval small enough to fit in a chat message — one
screenshot, one sentence, two answers — and then left it in a browser tab.
A channel is where that message goes, and in approval mode the answer can come
back from there instead of from the phone.

Everything here is additive. No existing call, type or outcome changes.

### Added

- **`channels?: HandoffChannel[]`** on `raiseHand`. Each channel's `notify` is
  called once, as soon as there is something to send: the link in takeover
  mode, the link and the screenshot in approval mode. It is never awaited, and
  a throw or a rejection is one `channel_failed` warning — a chat API that is
  down costs you a notification, not a browser session.
- **`ChannelHandoff`, the view an adapter gets.** A discriminated union on
  `mode`, like `RaiseHandOptions`: a takeover carries `handoffId`, `url`,
  `reason` and `mode`; an approval adds the `action`, the `screenshot` as the
  decoded JPEG the phone is looking at (the same bytes, not a second shot of a
  page that has moved on), and `answer()`.
- **`answer("approve" | "deny")` settles the handoff in-process**, through the
  same path a relay `approve` takes. The first answer wins whoever gives it —
  phone or channel — and the loser is told: `answer()` returns `false` when the
  handoff was already settled, because an approval sent to two places at once
  is *meant* to be answerable twice and losing that race is ordinary, not an
  error. The relay still gets its `ended` message, so a phone that is open
  shows the ending; nothing else about a settled handoff changes.
- **`HandoffEvent.answeredVia`**, `"relay"` or `"channel"`, present on the
  `approved` and `denied` outcomes only. Optional and additive.
- **`docs/adr/0007`** on why a channel is an in-process hook rather than a
  second human WebSocket client — the relay accepts one human peer and replaces
  it, so an adapter that connected would throw the phone off the handoff.
- **`handraise-telegram`**, the first adapter, written against this release in
  its own package: the screenshot with Approve/Deny buttons in a Telegram chat,
  answered by long polling, no public callback endpoint to host. It is not on
  npm at the time of writing; this release is what it needs in order to be.

- **`ChannelHandoff.settled`**, a promise that resolves with the outcome the
  moment the handoff ends — an answer from the phone, an answer from a channel,
  the timeout, a dead session, a handback. It never rejects, it stays resolved,
  and it is the same promise for every channel of one handoff. It carries the
  outcome the *caller* gets: a handback that turns into `disconnected` because
  the session died during the cookie capture reaches channels as
  `disconnected`, not `resolved`.

  This is the signal that lets an adapter stop. Without it one that waits for a
  reply can only stop on its own clock: measured on `handraise-telegram`, a
  handoff answered on the phone 500 ms in left the adapter polling and the Node
  process alive for another 20 s with a 20 s budget — five minutes fifty at its
  default, holding the bot's single update slot the whole time.

## [0.4.0] - 2026-09-02

Approval mode. A capability gap ("I can't do this": 2FA, a captcha) and an
authority boundary ("I may not do this": submit the payment) were the same call
with a different `reason`, and the outcome could not tell them apart. They are
now two modes of `raiseHand`, and an approval needs no takeover at all: one
screenshot, the action in words, yes or no.

What is unchanged: a `raiseHand(page, { reason })` call, a `switch` on
`outcome` without an exhaustiveness guard, and anything that only reads a
`HandoffEvent`. What is not: three exported types changed shape, and a
TypeScript consumer may have to edit one line — the section below says which.

### Breaking for TypeScript consumers

Nothing changes at runtime for a takeover caller. These are compile-time
breaks, and they apply even to an application that never asks for an approval.

- **`HandoffOutcome` has two new members**, `approved` and `denied`. A
  `Record<HandoffOutcome, X>` needs the two extra keys, and a `switch` with a
  `never` exhaustiveness guard needs the two extra arms. The four existing
  values keep their meaning.
- **`HandoffEvent.mode` is new and required.** Reading an event is unchanged;
  code that *constructs* one — a test fixture, a hand-built `onEvent` payload —
  has to set it.
- **`RaiseHandOptions` is now a union** of `TakeoverOptions | ApprovalOptions`,
  so `interface Yours extends RaiseHandOptions` no longer compiles. Extend
  `HandoffOptions` (everything both modes share) or `TakeoverOptions` instead;
  both are exported.

### Added

- **The webhook body carries `mode` and, in approval mode, `action`**, so a
  chat integration can show the step being decided without a second round
  trip. `{ url, reason, sessionId }` are unchanged.
- **`mode: "approval"`.** `raiseHand(page, { mode: "approval", reason, action })`
  shows the human one screenshot and the concrete step, and resolves with
  `approved` or `denied`. `action` is required in that mode and the types
  enforce it; `raiseHand(page, { reason })` is unchanged and still a takeover.
  `HandoffOutcome` grows by `approved` and `denied`, and `HandoffEvent` carries
  `mode`, which is what makes `inputsApplied: 0` and `framesSent: 1 +
  reconnects` readable.
- **Approval injects nothing.** No screencast, no CDP input, no focus probe, no
  `storageState` capture, and no CDP session at all: the page the human decides
  on is the page the agent stays on. One JPEG instead of 23–80 KB/s.
- **The relay enforces the mode.** It is started as a takeover relay or an
  approval relay and routes only that mode's human messages — `approve` and
  `deny` in approval, the takeover set in takeover. Hiding a button is not a
  restriction; the human's socket is reachable from any HTTP client.
- **Deny is one tap, approve takes the 700ms hold** — the inversion of takeover
  mode, where handing back is the tap and giving up is the hold. Here the
  answer that cannot be taken back is yes, so the cost sits on that side.
  Reasoning in [`docs/adr/0006`](docs/adr/0006-approval-mode.md).
- **The LLM tool chooses the mode.** `needHumanToolSpec` takes optional `mode`
  and `action`, its description explains "I can't" versus "I may not", and the
  summary sentence covers the two new outcomes. An approval without an action
  is refused rather than quietly downgraded to a takeover.
- [`demo/approval.ts`](demo/approval.ts): a payment the agent has filled in and
  will not submit without a yes.

### Changed

- The phone page serves both modes from one file, switched by a `data-mode` on
  the body. In approval mode the input row, key bar and hand-back controls are
  not on the page; pinch, drag and double-tap still zoom and pan the
  screenshot, because an amount you cannot read is an approval you cannot give.
- The relay no longer forwards non-text frames or unknown message types from
  the human side. Both were previously relayed and then ignored by the agent,
  so the closed message set is now closed at the relay rather than downstream.

### Fixed

- **The phone's Clear key did nothing.** `clear` was in the protocol, the relay
  routed it and `input.ts` implemented it, but the agent's own message switch
  never listed it, so it was dropped one hop short of the page. The human
  pressed a key that gave feedback and changed nothing. A test now sends one of
  every message the protocol defines through the real relay and the real
  socket, so the three vocabularies cannot drift apart again.
- **An answer given while the phone's socket was closing was thrown away.** If
  the socket had started closing when the human tapped, the message went into
  the outbox, the page showed the ending, and the socket's close handler then
  stopped reconnecting because the page was "finished" — with the answer still
  queued. The human saw "Handed back" or "Approved" and the agent waited out
  its full timeout. The page now keeps reconnecting until the outbox is empty.
  Present since 0.3.0 for hand back and give up.
- **An unknown `mode` is refused before anything is created**, rather than
  falling open as a takeover. TypeScript closes it; this package also ships as
  JavaScript. An approval with a blank or whitespace-only `action` is refused
  the same way, in `raiseHand` and in the `needHuman` tool: a human cannot
  approve a sentence that is not there.

### Security

- **The first answer wins, permanently.** The handoff link is a bearer URL and
  can be in two hands at once. A terminal message from the human ended the
  handoff but did not lock the relay, so a second holder could overwrite a
  queued `deny` with an `approve` before the agent reconnected to collect it —
  and the agent would act on the second one. The relay now takes the first
  answer, refuses every human message after it, and refuses to let a
  reconnecting agent refill the replay buffers it has just scrubbed. Present
  since 0.2.0 for hand back and give up.
- **The relay forgets the page when its agent disconnects.** Replay buffers
  were purged only when the agent's `ended` arrived, and that message is not
  guaranteed: the agent gives up on it after two seconds, and a sandbox that
  fails to be destroyed stays public until it idles out. Anyone holding the
  link could be served the last frame of a logged-in page in that window. The
  relay now drops the last frame, state and focus the moment the authenticated
  agent socket closes. On the next reconnect the agent re-sends its state at
  once; the frame comes back with the next repaint in takeover mode or the
  re-sent screenshot in approval mode, so a late human may briefly see a blank
  stage but never the previous logged-in frame.

## [0.3.0] - 2026-09-02

The phone UI, rebuilt from a design-engineering audit
([`docs/design/phone-ui-audit.md`](docs/design/phone-ui-audit.md)).
The headline finding: the human could not read the page they were operating —
a 1280×800 frame letterboxed to 29% on a 390px phone, ~1mm glyphs, with zoom
blocked. Remote 16px text now renders at 10.4 CSS px instead of 4.6.

### Added

- **Auto-zoom to the focused field.** The agent already reports which field
  has focus; the phone now zooms so that field is readable and centred, capped
  at 3×. Pinch to zoom and pan, double-tap to toggle. The first tap is never
  delayed — a second tap within 250ms toggles zoom instead of sending again.
- **Hold to give up.** The give-up button is now "I can't do this" and needs a
  700ms press-and-hold; a bare tap explains why. The primary "Hand back" stays
  a single tap. Both are irreversible; only one of them deserved a guard.
- **Input queued across reconnects.** Keystrokes typed while the socket is
  reconnecting are held (up to 50) and flushed in order, once; the hint says so.
  A give-up during an outage used to vanish and cost the agent its full timeout.
  Taps and scrolls are deliberately not replayed — the page may have moved.
- **One-time-code autofill.** The focus event carries an optional `kind`
  (`otp` | `password` | `text`), derived from the remote field's attributes
  only — never its value — so the phone's field gets `autocomplete=one-time-code`
  and iOS can offer the SMS code instead of making the human retype it.
- Tap feedback on the live view; a ripple where the finger landed.

### Changed

- Key bar regrouped by consequence: `⌫ ⇥ ⏎` together, **Clear** fenced 124px
  away (was 6px from backspace). Every key ≥44px; disabled contrast 1.96→3.17:1.
  The input has its own full-width row (296px at 320px wide, was 69px).
- The give-up button lost the UI's only colour; red survives only as the hold's
  progress fill. Both exit buttons are now exactly the same height.
- Safe-area inset applied once (was twice, ~78px on notched iPhones);
  `100dvh` + `interactive-widget=resizes-content` so the bar survives the
  Android keyboard. Header and footer lifted off the stage (was 1.04:1).
- Overlays speak to the human, say thank you, and fade in instead of snapping.
  The idle dot no longer pulses; only "reconnecting" does.

## [0.2.0] - 2026-09-01

0.1.0 is deprecated due to a Node ESM/CJS interoperability bug in QR rendering;
0.2.0 fixes it and adds a distribution smoke test. The published bundle used a
namespace import for `qrcode-terminal`, which resolves to `{ default: … }` under
Node's ESM/CJS interop, so `generate` was undefined and the QR code — the whole
onboarding path — silently failed to render. Bun-driven tests never saw it
because bun's interop differs. CI now runs the shipped artifact under node after
every build.

### Added

- **`npx handraise`** — a one-command demo. With only a `SOLARI_API_KEY`, it
  deploys its own TOTP-walled portal into a sandbox, opens a cloud browser
  against it, raises a hand and prints the QR.
- **`handoffQr(url)` export** — render the handoff QR yourself.
- **Focus feedback on the phone** — a ring around the focused field and a
  "Typing into: Password" label, so the human can see where typing lands.
  Only the field's label is read, never its value.
- **A key bar on the phone** — backspace, clear, tab, enter as explicit
  buttons. Deletion previously rode on a `keydown` that virtual keyboards
  often do not send (Android reports `keyCode 229`), so text already in a
  remote field could not be removed from a phone at all.

### Fixed

- **The QR code renders in the published bundle** (see above).
- The QR is no longer printed when it would not fit the terminal — a wrapped
  QR looks like a QR and does not scan.

### Changed

- Quiet by default: the library writes nothing to stdout unless you pass
  `logger: consoleLogger` or an `onEvent` handler.

## [0.1.0] - 2026-09-01

Initial release. Human-in-the-loop handoff for Solari cloud browsers.

### Added

- **`raiseHand(page, options)`** — pause the agent and hand the live browser
  session to a human. Streams CDP screencast frames to the human's phone over a
  WebSocket, injects the human's taps, keys and scrolls back as trusted CDP input
  events, and resolves when the human hands the session back.
- **Relay in a Solari sandbox.** On each handoff, handraise boots a Solari sandbox
  (~3 s cold start), deploys a zero-dependency Node relay into it, and exposes it
  through Solari's port preview. The public preview URL is the handoff link; the
  adopter hosts nothing. The sandbox is destroyed on every exit path, including
  errors, before `raiseHand` returns.
- **Notifications, three ways:** a QR code printed to the terminal (default,
  toggle with `qr`), an `onUrl(url)` callback, and a generic `webhookUrl` that
  receives `{ url, reason, sessionId }` as a JSON POST (works with Slack, Discord,
  ntfy, Telegram bots, or anything that accepts a POST).
- **`needHuman` tool export** for LLM agent frameworks — `createNeedHumanTool`,
  `needHumanToolSpec` (plain JSON Schema) and `NeedHumanInput` — so a model can
  decide when to call for a human. The tool returns `{ outcome, summary,
  durationMs }` with a summary sentence the model can act on.
- **`storageState` capture.** Cookies and localStorage are captured right after a
  successful handback and returned on the result, so the human's work can be
  persisted to a Solari profile and survive later session loss.
- **Explicit failure modes on `HandoffResult.outcome`:** `resolved`, `timeout`
  (no human before `timeoutMs`), `aborted` (human hit Abort), and `disconnected`
  (the browser session died mid-handoff — modeled as an expected state, not an
  exception). The default wait is 5 minutes; there is deliberately no keep-alive
  pinger.
- **Pluggable structured logging** via `logger` and **wide-event telemetry** via
  `onEvent` — one wide `HandoffEvent` per handoff, carrying the outcome, timings
  and identifiers, for canonical-log-line style observability. Quiet by
  default: only warnings and errors reach stderr; pass `consoleLogger` for the
  full JSON lines including the per-handoff wide event.
- **`baseUrl` option** to point handraise at a specific Solari endpoint or region
  for the relay sandbox.

### Security

- The agent role requires a separate per-handoff secret (`randomUUID`) appended
  only to the agent's own WebSocket URL, so a holder of the shareable human link
  cannot claim the agent role or read keystrokes. A foreign `Origin` is refused.
- The human side is restricted to a closed message set (mouse, keyboard, scroll,
  hand-back, abort); inputs are length- and rate-bounded. There is no path from
  the link to arbitrary browser control.
- The handoff URL carries a Solari preview token scoped to one sandbox and port
  with a 1-hour lifetime; it dies with the sandbox at the end of the handoff.
- No frame or keystroke data is persisted. The relay holds only the latest frame
  in memory to paint a late-joining phone and drops it when the handoff ends. The
  Solari API key never leaves the agent process.

### Known limitations

- If the human silently closes the tab, the agent cannot tell until `timeoutMs`;
  peer presence is a planned v2 protocol change.
- The test plan allows 2 concurrent sandboxes, and each active handoff uses one,
  so two simultaneous handoffs is the plan-tier ceiling.
- TypeScript/Node only.

[Unreleased]: https://github.com/Sy-D/handraise/compare/v0.3.0...HEAD
[0.5.1]: https://github.com/Sy-D/handraise/releases/tag/v0.5.1
[0.5.0]: https://github.com/Sy-D/handraise/releases/tag/v0.5.0
[0.4.0]: https://github.com/Sy-D/handraise/releases/tag/v0.4.0
[0.3.0]: https://github.com/Sy-D/handraise/releases/tag/v0.3.0
[0.2.0]: https://github.com/Sy-D/handraise/releases/tag/v0.2.0
[0.1.0]: https://github.com/Sy-D/handraise/releases/tag/v0.1.0
