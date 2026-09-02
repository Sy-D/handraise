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
import type { HandoffOutcome } from "./types"

export interface HandoffEvent {
  /** Correlates the event with the relay's own logs (the preview subdomain). */
  handoffId: string
  /** How the handoff ended. */
  outcome: HandoffOutcome
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
  /** Frames handed to the relay over the handoff. */
  framesSent: number
  /** Sum of the base64 frame-payload lengths sent, in bytes. */
  bytesSent: number
  /** Taps, characters, keys and scrolls the human applied to the page. */
  inputsApplied: number
  /** Agent-socket reconnects during the handoff (the 60 s idle cut, drops). */
  reconnects: number
  /** Whether cookies + localStorage were captured after a handback. */
  storageStateCaptured: boolean
  /** Gateway base URL, when the caller overrode the Solari default. */
  baseUrl?: string
  /** Set on a failure path: the first error message that shaped the outcome. */
  error?: string
}
