import type { BrowserContext, Page } from "playwright-core"
import type { HandoffEvent } from "./events"
import type { Logger } from "./logger"

/**
 * What the human is being asked for.
 *
 * `takeover` is the original handoff: the human drives the live browser and
 * hands it back. `approval` asks one question about one screenshot — the agent
 * keeps the browser, and the human only answers yes or no.
 */
export type HandoffMode = "takeover" | "approval"

/** The options both modes share. */
export interface HandoffOptions {
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
  /**
   * Where handraise's own logs go. Defaults to `consoleLogger`, which writes
   * one structured JSON line per event. Pass `noopLogger` to silence it, or
   * your own `Logger` to route it into your stack. No secret is ever logged.
   */
  logger?: Logger
  /**
   * Called exactly once at the end of every handoff — resolved, aborted,
   * timeout or disconnected — with the full wide event. A throw from this
   * callback is caught and logged; it never breaks the handoff.
   */
  onEvent?: (event: HandoffEvent) => void
  /**
   * Gateway base URL for the relay's Solari client. Defaults to the SDK's
   * `https://api.getsolari.com`. Set it to reach a non-default Solari gateway;
   * when set it is mirrored into the handoff event.
   */
  baseUrl?: string
}

/** The agent is stuck and wants the browser driven. The default. */
export interface TakeoverOptions extends HandoffOptions {
  mode?: "takeover"
}

/**
 * The agent is not stuck; it is about to do something it may not do alone.
 * `action` is required here because it is the thing being decided — a reason
 * without it asks the human to approve a sentence, not a step.
 */
export interface ApprovalOptions extends HandoffOptions {
  mode: "approval"
  /**
   * The concrete step awaiting a yes or a no, e.g. "Submit $12,430 vendor
   * payment to Acme GmbH". Shown to the human as the largest text on the page.
   */
  action: string
}

/**
 * Options for `raiseHand`. A discriminated union on `mode`: omitting it is a
 * takeover and compiles exactly as it did before approval mode existed, while
 * `mode: "approval"` will not compile without an `action`.
 */
export type RaiseHandOptions = TakeoverOptions | ApprovalOptions

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>

/**
 * How a handoff ended. Which values are reachable depends on the mode:
 *
 * - takeover: `resolved` (the human handed back), `aborted` (the human gave
 *   up), `timeout`, `disconnected`.
 * - approval: `approved`, `denied`, `timeout`, `disconnected`.
 *
 * The four modes-in-common cases keep their meaning, so a `switch` written
 * before approval mode still compiles and still branches the same way.
 */
export type HandoffOutcome =
  | "resolved"
  | "aborted"
  | "approved"
  | "denied"
  | "timeout"
  | "disconnected"

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
 * Pause the agent and put the browser session in front of a human.
 *
 * In takeover mode it resolves when the human clicks "hand back" (outcome:
 * "resolved"), the human gives up (outcome: "aborted"), `timeoutMs` elapses
 * (outcome: "timeout"), or
 * the browser session dies mid-handoff (outcome: "disconnected" — on the plan
 * we measured, Solari browser sessions had a hard ~10 minute lifetime and the
 * sessions API kept reporting "active" after death, so liveness comes from the
 * connection, not the control plane).
 *
 * In approval mode the human sees one screenshot and the `action`, and the
 * outcome is "approved" or "denied" instead. Nothing is injected into the
 * page, so the session is exactly as the agent left it.
 *
 * All relay infrastructure is destroyed before this promise settles, on every
 * path including errors.
 */
export type RaiseHand = (
  page: Page,
  options: RaiseHandOptions,
) => Promise<HandoffResult>
