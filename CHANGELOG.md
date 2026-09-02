# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-02

The phone UI, rebuilt from a design-engineering audit (`spikes/emil-ui-audit.md`).
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

Everything below shipped after 0.1.0 was published. **0.1.0 is broken and
deprecated**: its bundle used a namespace import for `qrcode-terminal`, which
resolves to `{ default: … }` under Node's ESM/CJS interop, so `generate` was
undefined and the QR code — the whole onboarding path — silently failed to
render. Bun-driven tests never saw it because bun's interop differs. CI now
runs the shipped artifact under node after every build.

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

[0.3.0]: https://github.com/Sy-D/handraise/releases/tag/v0.3.0
[0.2.0]: https://github.com/Sy-D/handraise/releases/tag/v0.2.0
[0.1.0]: https://github.com/Sy-D/handraise/releases/tag/v0.1.0
