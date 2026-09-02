# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.4.0

Approval mode. A capability gap ("I can't do this": 2FA, a captcha) and an
authority boundary ("I may not do this": submit the payment) were the same call
with a different `reason`, and the outcome could not tell them apart. They are
now two modes of `raiseHand`, and an approval needs no takeover at all: one
screenshot, the action in words, yes or no. Additive — existing code compiles
and behaves exactly as before.

### Added

- **`mode: "approval"`.** `raiseHand(page, { mode: "approval", reason, action })`
  shows the human one screenshot and the concrete step, and resolves with
  `approved` or `denied`. `action` is required in that mode and the types
  enforce it; `raiseHand(page, { reason })` is unchanged and still a takeover.
  `HandoffOutcome` grows by `approved` and `denied`, and `HandoffEvent` carries
  `mode`, which is what makes `framesSent: 1` and `inputsApplied: 0` readable.
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
[0.3.0]: https://github.com/Sy-D/handraise/releases/tag/v0.3.0
[0.2.0]: https://github.com/Sy-D/handraise/releases/tag/v0.2.0
[0.1.0]: https://github.com/Sy-D/handraise/releases/tag/v0.1.0
