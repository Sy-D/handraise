/**
 * Wire protocol between the agent process, the relay (in a Solari sandbox),
 * and the human's phone. The relay forwards agent→human and human→agent
 * messages verbatim; it reads their `type` and never their payload.
 *
 * It reads the type for one reason beyond replay: the handoff's mode is
 * enforced there. The relay is started with the mode as an argument and routes
 * only the human messages that mode allows — the takeover set below in
 * takeover mode, `approve` and `deny` in approval mode. Hiding a control on
 * the phone is not a restriction; the human's socket is reachable from any
 * HTTP client.
 *
 * Both sides connect to `wss://<preview>/ws?role=agent|human`. Coordinates in
 * human messages are frame pixels (the JPEG the phone displays); the agent
 * side owns the conversion to page coordinates, because only it has the
 * screencast metadata (see docs/measurements/02-cdp-screencast.md and docs/measurements/03-cdp-input-injection.md:
 * scale by deviceWidth / jpegWidth, never add scroll offsets).
 */

import type { HandoffOutcome } from "../types"

/**
 * Screencast frame metadata, passed through from CDP unmodified. In approval
 * mode there is one frame and it is a screenshot, but it carries the same
 * metadata so the phone's letterbox maths does not care which it is.
 */
export interface FrameMeta {
  /** CSS viewport width of the remote page (unscaled, from CDP metadata). */
  deviceWidth: number
  deviceHeight: number
  /** Actual pixel size of the JPEG (post maxWidth/maxHeight scaling). */
  jpegWidth: number
  jpegHeight: number
  pageScaleFactor: number
}

/**
 * The focused field's box in **CSS viewport pixels of the remote page** — the
 * same space `frameToPage()` maps a tap into, so the phone inverts that maths
 * to draw it. Never frame pixels: the frame is scaled and the metadata is not.
 */
export interface FocusRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * What the focused field takes, derived on the agent side from the remote
 * element's attributes only — never from its value. The phone uses it to pick
 * its own field's `type`, `inputmode` and `autocomplete`, which is what lets
 * iOS offer the SMS code from Messages instead of making the human retype it.
 *
 * Three values, not five: the phone's keyboard has exactly three behaviours to
 * choose between, and a kind nothing acts on is a kind that goes stale.
 */
export type FocusKind = "otp" | "password" | "text"

export type AgentToHuman =
  | { type: "frame"; data: string; meta: FrameMeta }
  /**
   * Why the human is here. `action` is sent in approval mode only and carries
   * the step being decided; the phone shows it as the largest text on screen.
   */
  | { type: "state"; reason: string; action?: string }
  /**
   * Where the human's typing currently lands. `rect: null` means nothing is
   * focused; `label` is a human-readable field name taken from the remote
   * page's own markup, never from the field's value.
   *
   * `kind` is optional so an older agent still speaks this protocol: a phone
   * that receives no `kind` falls back to "text", which is what every field
   * behaved as before it existed.
   */
  | {
      type: "focus"
      rect: FocusRect | null
      label: string | null
      kind?: FocusKind
    }
  | { type: "ended"; outcome: HandoffOutcome }

export type HumanToAgent =
  | { type: "tap"; fx: number; fy: number }
  | { type: "char"; ch: string }
  | { type: "key"; key: "Enter" | "Backspace" | "Tab" }
  /**
   * Empty the focused field. Deliberately keyboard-equivalent — select-all
   * followed by one Backspace — rather than a value assignment: the page must
   * see the same events a human produces, and the message set stays closed and
   * small instead of growing an "execute this on the page" escape hatch.
   */
  | { type: "clear" }
  | { type: "scroll"; fdy: number }
  | { type: "handback" }
  | { type: "abort" }
  /**
   * The two approval answers, and the only human messages an approval relay
   * routes. `deny` is one tap on the phone and `approve` takes a hold: in this
   * mode the irreversible side is yes.
   */
  | { type: "approve" }
  | { type: "deny" }

/**
 * Either side may ping; the receiver answers pong. Required: the preview
 * proxy kills WebSockets after exactly 60s of silence (close 1006, see
 * docs/measurements/01-preview-transport.md). Send a ping at least every 25s; treat 1006 as
 * "reconnect", not "failed".
 */
export type Heartbeat = { type: "ping" } | { type: "pong" }

export type RelayMessage = AgentToHuman | HumanToAgent | Heartbeat

export const HEARTBEAT_INTERVAL_MS = 20_000
export const RELAY_PORT = 3000
