import type { Page } from "playwright-core"

/** Why the agent is raising its hand — shown to the human on the handoff page. */
export interface RaiseHandOptions {
  /** Human-readable reason, e.g. "GitHub is asking for a 2FA code". */
  reason: string
  /**
   * Optional generic webhook: handraise POSTs { url, reason, sessionId } here
   * when the handoff page is ready. Works with Slack, Discord, ntfy, Telegram
   * bots — anything that accepts a JSON POST.
   */
  webhookUrl?: string
  /** Called with the public handoff URL as soon as it exists. */
  onUrl?: (url: string) => void
  /** How long to wait for the human before giving up. Default: 15 minutes. */
  timeoutMs?: number
  /** Print a scannable QR code for the handoff URL to the terminal. Default: true. */
  qr?: boolean
}

export type HandoffOutcome = "resolved" | "aborted" | "timeout"

export interface HandoffResult {
  outcome: HandoffOutcome
  /** Wall-clock time the human took, in milliseconds. */
  durationMs: number
  /** The handoff URL that was (or would have been) used. */
  url: string
}

/**
 * Pause the agent and hand the live browser session to a human.
 *
 * Resolves when the human clicks "hand back" (outcome: "resolved"), the human
 * aborts (outcome: "aborted"), or `timeoutMs` elapses (outcome: "timeout").
 * The session is kept alive for the whole wait; all relay infrastructure is
 * destroyed before this promise settles, on every path including errors.
 */
export type RaiseHand = (page: Page, options: RaiseHandOptions) => Promise<HandoffResult>
