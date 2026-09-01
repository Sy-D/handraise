import type { BrowserContext, Page } from "playwright-core"

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
  /**
   * How long to wait for the human before giving up. Default: 5 minutes.
   * Keep this short: Solari browser sessions have a hard lifetime of about
   * 10 minutes from creation (measured; no keep-alive extends it), so a long
   * wait is more likely to end in `disconnected` than in `resolved`.
   */
  timeoutMs?: number
  /** Print a scannable QR code for the handoff URL to the terminal. Default: true. */
  qr?: boolean
  /**
   * Solari API key used to create the relay sandbox. Defaults to
   * `process.env.SOLARI_API_KEY`.
   */
  apiKey?: string
}

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>

export type HandoffOutcome = "resolved" | "aborted" | "timeout" | "disconnected"

export interface HandoffResult {
  outcome: HandoffOutcome
  /** Wall-clock time the human took, in milliseconds. */
  durationMs: number
  /** The handoff URL that was (or would have been) used. */
  url: string
  /**
   * Cookies + localStorage captured right after a successful handback, so the
   * caller can persist them (e.g. to a Solari profile) and relaunch if the
   * session dies later. Absent when the session was already gone.
   */
  storageState?: StorageState
}

/**
 * Pause the agent and hand the live browser session to a human.
 *
 * Resolves when the human clicks "hand back" (outcome: "resolved"), the human
 * aborts (outcome: "aborted"), `timeoutMs` elapses (outcome: "timeout"), or
 * the browser session dies mid-handoff (outcome: "disconnected" — on the plan
 * we measured, Solari browser sessions had a hard ~10 minute lifetime and the
 * sessions API kept reporting "active" after death, so liveness comes from the
 * connection, not the control plane). All relay infrastructure is destroyed
 * before this promise settles, on every path including errors.
 */
export type RaiseHand = (
  page: Page,
  options: RaiseHandOptions,
) => Promise<HandoffResult>
