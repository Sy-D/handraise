# Observability — implementation report

Scope: `src/**` only. Pluggable structured logger + one canonical wide event per
handoff. No new dependencies. Gates all green; live e2e passed.

---

## 1. New API surface

### `src/logger.ts`

```ts
export type LogFields = Record<string, unknown>   // the serialisation boundary
export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}
export const consoleLogger: Logger   // default; JSON lines, debug/info→stdout, warn/error→stderr
export const noopLogger: Logger      // swallows everything
```

`consoleLogger` writes one line per call: `{ level, event, ts, ...fields }`.

### `src/events.ts` — final `HandoffEvent` field list

Emitted **exactly once** at the end of every handoff (resolved / aborted /
timeout / disconnected), via `options.onEvent` **and** `logger.info("handoff", …)`.

| Field | Type | Source |
|---|---|---|
| `handoffId` | `string` | preview subdomain of the relay URL |
| `outcome` | `HandoffOutcome` | `resolved\|aborted\|timeout\|disconnected` |
| `reason` | `string` | `options.reason` verbatim |
| `timeoutMs` | `number` | effective wait budget |
| `durationMs` | `number` | settle time − handoff start (human time, before teardown) |
| `relayColdStartMs` | `number` | measured in `startRelay()` (entry → public URL healthy) |
| `firstFrameMs?` | `number` | first frame sent − handoff start (omitted if no frame went out) |
| `framesSent` | `number` | frames handed to the relay |
| `bytesSent` | `number` | Σ base64 frame-payload length (ASCII → 1 char = 1 byte) |
| `inputsApplied` | `number` | taps/chars/keys/scrolls that reached the page |
| `reconnects` | `number` | agent-socket re-opens beyond the first |
| `storageStateCaptured` | `boolean` | cookies captured after handback |
| `baseUrl?` | `string` | mirrored only when the caller set `options.baseUrl` |
| `error?` | `string` | first error that shaped a failure path (omitted otherwise) |

All optional fields are added conditionally (`exactOptionalPropertyTypes`). No
secret is ever logged: no `pt_token`, API key, frame bytes, or typed characters
(asserted in `handoff.test.ts`).

### `RaiseHandOptions` (src/types.ts) — three new optional fields

- `logger?: Logger` — default `consoleLogger`.
- `onEvent?: (event: HandoffEvent) => void` — called once at the end; wrapped in
  try/catch so a throwing callback never breaks the handoff (`on_event_threw` logged).
- `baseUrl?: string` — passed through to `startRelay` → `new SolariClient({ apiKey, baseUrl })`.

### `src/index.ts`

Now also exports: `Logger`, `LogFields`, `consoleLogger`, `noopLogger`, `HandoffEvent`.

---

## 2. `console.*` → logger replacements

Diagnostics replaced (event name in parentheses):

| File | Before | After |
|---|---|---|
| `core/raise-hand.ts` | `input was rejected` | `logger.warn("input_rejected")` |
| `core/raise-hand.ts` | `could not start the live view` | `logger.error("live_view_start_failed")` |
| `core/raise-hand.ts` | `could not capture storageState` | `logger.warn("storage_state_capture_failed")` |
| `core/raise-hand.ts` | `the onUrl callback threw` | `logger.warn("on_url_threw")` |
| `core/raise-hand.ts` | `the handoff failed` | `logger.error("handoff_failed")` |
| `core/raise-hand.ts` | `could not release the relay sandbox` | `logger.error("relay_release_failed")` |
| `relay/deploy.ts` | timeout-cap `console.warn` | `logger.warn("relay_timeout_capped")` |
| `relay/deploy.ts` | kill-failure `console.error` | `logger.error("relay_release_failed")` |
| `webhook.ts` | `webhook answered …` | `logger.warn("webhook_rejected")` |
| `webhook.ts` | `webhook failed` | `logger.warn("webhook_failed")` |
| `qr.ts` | `could not draw the QR code` | `logger.warn("qr_render_failed")` |

**Deliberately NOT converted** (`src/qr.ts` `printHandoffQr`): the three
`console.log` lines that print the reason, the `open <url>` line, and the QR
ASCII art. These are terminal UX a human reads to scan the code — not
observability. Routing them through the structured logger would (a) destroy the
QR rendering and (b) log the tokenised URL, i.e. a bearer credential with
`pt_token`. `logger.ts`'s own `console.log/console.error` are the sink itself.
`relay/guest/server.js` + generated `guest-source.ts` were out of scope and
untouched.

`webhook.ts`, `qr.ts` and `deploy.ts` gained an optional `logger` parameter
(default `consoleLogger`); `raiseHand` threads its resolved logger into all of them.

---

## 3. Measurement points

| Metric | Where measured |
|---|---|
| `relayColdStartMs` | `relay/deploy.ts`: `startedAt` at entry, `Date.now()-startedAt` on the returned `RelayHandle.coldStartMs` |
| `framesSent`, `bytesSent`, `firstFrameMs` | `core/raise-hand.ts`: the frame-pump `send` wrapper, after `connection.send` resolves (same "send resolved" semantics as `pump.frameCount()`) |
| `inputsApplied` | `core/input.ts`: `appliedCount++` after each tap/char/key/scroll actually dispatches; exposed as `InputTarget.applied()`. Dropped/lifecycle messages do not count |
| `reconnects` | `core/socket.ts`: `opens` counted on every socket `open`; exposed as `RelayConnection.stats().reconnects = max(0, opens-1)` |

Nothing was faked or guessed. Every listed field is honestly measurable and was
observed non-trivial on the live run (framesSent 12, bytesSent 124388,
inputsApplied 8, reconnects 0, firstFrameMs 662, relayColdStartMs 2661).

`bytesSent` counts base64 payload length, not the full JSON frame envelope — the
payload dominates and decoding every frame to count raw JPEG bytes would cost a
base64 decode ~13×/s for no analytic gain. Documented on the field.

---

## 4. Tests

New / changed:
- `src/logger.test.ts` (new): `consoleLogger` shape, stream routing (out vs err),
  tolerates missing fields, never throws; `noopLogger` swallows and writes nothing.
- `src/core/handoff.test.ts` (new): a full handoff driven through `runHandoff`
  against the **real** in-guest relay under node (as `relay.test.ts`/`socket.test.ts`),
  with a fake page/CDP. Asserts `onEvent` fires **exactly once**, the event has
  plausible fields (`outcome`, `durationMs>0`, `framesSent≥1`, `inputsApplied≥1`,
  `storageStateCaptured`, `firstFrameMs`, no `pt_token`), and a **throwing
  `onEvent` does not break the handoff** (still settles `aborted`).
- `src/core/input.test.ts`: added an assertion that `applied()` counts only real
  inputs (4), never dropped/lifecycle messages.
- `src/core/socket.test.ts`: added `expect(connection.stats().reconnects).toBe(1)`
  to the existing mid-handoff drop/recover test.

`runHandoff` was exported (previously module-private) so the handoff test can
drive it with a fake page; `raiseHand` remains the only public entry point.

**Red-seen (mutate → red → back):** temporarily added a second
`emitHandoffEvent(...)` call in `runHandoff`; `handoff.test.ts` failed with
`toHaveLength(1)` → `Expected length: 1 / Received length: 2`. Reverted, green
again. Confirms the "exactly once" assertion is load-bearing.

---

## 5. Gate outputs (real)

```
tsc=0
oxlint=0
biome=0
embed=0          (guest-source.ts is in sync with guest/server.js)
bun test src/ test-app/  →  92 pass, 0 fail, 257 expect() calls, 9 files
```

Anti-slop note: the binding contract requires `fields?: Record<string, unknown>`.
The `anti-slop/no-unsafe-dictionary-type` rule flags that exact type. The value
type is genuinely correct here — the logger *is* the serialisation boundary the
fields cross — so `LogFields = Record<string, unknown>` carries one scoped
`// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type` with a
justification at its declaration; every consumer uses the `LogFields` alias
(exempt as a plain alias reference). No rule was weakened in config. Flagging
this for review as the single deviation from "nothing weakened".

---

## 6. Live e2e result

`cleanup.ts` reported 0 stray sandboxes; `bun run test:e2e` passed end to end
(`evt: e2e_passed`, totalMs 27835), and cleaned up (0 sandboxes after). The
instrumentation did not break the real path. The wide event was emitted once on
the resolved path and once on the timeout path.

Example wide event (real, from the live run — resolved path):

```json
{"level":"info","event":"handoff","ts":"2026-09-01T07:21:11.376Z","handoffId":"34afd7b013c836ab4ea2-3000","outcome":"resolved","reason":"Aurora Bank is asking for a 2FA code","timeoutMs":300000,"durationMs":5712,"relayColdStartMs":2661,"framesSent":12,"bytesSent":124388,"inputsApplied":8,"reconnects":0,"storageStateCaptured":true,"firstFrameMs":662}
```

Timeout path (same run):

```json
{"level":"info","event":"handoff","ts":"2026-09-01T07:21:23.253Z","handoffId":"b27691adbce424daa5ba-3000","outcome":"timeout","reason":"nobody is going to answer this one","timeoutMs":8000,"durationMs":8003,"relayColdStartMs":2640,"framesSent":1,"bytesSent":8872,"inputsApplied":0,"reconnects":0,"storageStateCaptured":false,"firstFrameMs":659}
```

No `pt_token` / key / typed characters appear in either line.

---

## 7. package.json need

**None.** No new dependency. The implementation uses only `Date.now()`, existing
types, and the SDK's already-present `SolariClientOptions.baseUrl`. Verified:
`sandboxes.create` has no `region` field, so `baseUrl` (not `region`) is the
honest knob.

---

## 8. Open points

- `durationMs` in the wide event (settle − handoff start) is measured slightly
  earlier than `HandoffResult.durationMs` (which spans teardown too). Both are
  plausible and no test couples them; the event's is the truer "human time".
- `error` is only set on the live-view-start failure path today. Timeout and
  disconnected outcomes carry no `error` (they are not exceptions). If a broader
  error trail is wanted, the `input_rejected` / browser-gone paths could also
  populate it — left out to avoid over-reporting non-errors.
- `HandoffResult` was intentionally left unchanged (no `event` field added) to
  keep the public result shape stable; the event is delivered via `onEvent`/logger.
