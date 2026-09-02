/**
 * The canonical wide event for one handoff.
 *
 * handraise emits exactly one of these at the end of every handoff — on the
 * resolved, aborted, timeout and disconnected paths alike — through the
 * caller's `onEvent` callback and as a `logger.info("handoff", …)` line. It is
 * deliberately wide and high-cardinality (see docs/measurements/): one row per
 * handoff carries enough to answer "why did this one take 40 s and send
 * 900 frames" without stitching narrow log lines together.
 *
 * It never carries a secret: no `pt_token`, no API key, no frame bytes, no
 * characters the human typed.
 */
import type { HandoffMode, HandoffOutcome } from "./types"

export interface HandoffEvent {
  /** Correlates the event with the relay's own logs (the preview subdomain). */
  handoffId: string
  /** How the handoff ended. */
  outcome: HandoffOutcome
  /**
   * What the human was asked for: `takeover` (drive the browser) or
   * `approval` (answer yes or no about one screenshot). Which outcomes,
   * frame counts and input counts are possible follows from it.
   */
  mode: HandoffMode
  /** The `reason` the agent gave, verbatim — this is shown to the human too. */
  reason: string
  /** The wait budget that was in force, in ms. */
  timeoutMs: number
  /** Wall-clock time the handoff was live, in ms. */
  durationMs: number
  /** Time from `startRelay()` to the public URL being reachable, in ms. */
  relayColdStartMs: number
  /** Time from handoff start until the first frame was sent, in ms. */
  firstFrameMs?: number
  /**
   * Frames handed to the relay over the handoff. In approval mode this is the
   * one screenshot, sent once per connection because a reconnecting agent has
   * to put it back on the wire: `1 + reconnects`.
   */
  framesSent: number
  /** Sum of the base64 frame-payload lengths sent, in bytes. */
  bytesSent: number
  /**
   * Taps, characters, keys and scrolls the human applied to the page. Always 0
   * in approval mode, which injects nothing.
   */
  inputsApplied: number
  /**
   * QR scans the human asked for and the agent performed. Requests dropped by
   * the rate limit are not counted — they cost nothing and happened only in
   * the sense that a button was pressed twice. Always 0 in approval mode,
   * which offers no scan.
   */
  qrScans: number
  /** Of those, the ones that found at least one code. `qrScans - qrHits` is
   *  how often the human was told "nothing here", which is the number worth
   *  watching: it is either a page that has no code or a decode that failed. */
  qrHits: number
  /** Agent-socket reconnects during the handoff (the 60 s idle cut, drops). */
  reconnects: number
  /** Whether cookies + localStorage were captured after a handback. */
  storageStateCaptured: boolean
  /**
   * Who answered, on the `approved` and `denied` outcomes only: `relay` is the
   * handoff page (the phone), `channel` is an in-process `HandoffChannel` such
   * as a Telegram adapter. Absent on every other outcome, and on an approval
   * nobody answered.
   */
  answeredVia?: "relay" | "channel"
  /** Gateway base URL, when the caller overrode the Solari default. */
  baseUrl?: string
  /** Set on a failure path: the first error message that shaped the outcome. */
  error?: string
}
