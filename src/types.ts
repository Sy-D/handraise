import type { BrowserContext, Page } from "playwright-core"
import type { HandoffChannel } from "./channels"
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
   * Where else to announce this handoff — a chat channel, a pager, anything
   * that implements `HandoffChannel`. Each one is notified once, is never
   * awaited, and cannot break the handoff. In approval mode a channel also
   * gets the screenshot and can answer in-process, so the human never has to
   * open the link (see `handraise-telegram`).
   */
  channels?: HandoffChannel[]
  /**
   * How long to wait for the human before giving up. Default: 5 minutes.
   * Keep this short: Solari browser sessions have a hard lifetime of about
   * 10 minutes from creation (measured; no keep-alive extends it), so a long
   * wait is more likely to end in `disconnected` than in `resolved`.
   */
  timeoutMs?: number
  /**
   * How long to keep waiting after the human's phone disappears, in ms.
   * Default: 60 seconds.
   *
   * The relay reports whether a human is connected (it answers the heartbeats
   * itself, so nobody else can tell). Once one has been there and their socket
   * is gone for this long, the handoff ends as `timeout` rather than waiting
   * out `timeoutMs` for somebody who has closed the tab. A phone that comes
   * back inside the grace resets it, which is what makes the 60 s default
   * safe: the preview proxy cuts an idle socket every 60 s and the phone
   * reconnects in about a second.
   *
   * A handoff nobody ever opened is not affected — that is the ordinary wait,
   * and it runs for the full `timeoutMs`.
   *
   * The accepted range is 5 000 to 2 147 483 647 ms. The floor is a floor and
   * not a recommendation: a grace of one second — which is what the phone's
   * reconnect takes — was measured ending a healthy handoff on the first proxy
   * cut. Anything below the default is for tests, and for humans you expect to
   * answer in seconds.
   *
   * Raise it when the human is expected to leave the page: a screen that locks
   * or a tab that is backgrounded long enough can lose the socket without the
   * reconnect firing, and reading an SMS or fetching a hardware key on the
   * same phone is exactly that. Sixty seconds covers the proxy's own cut, not
   * a person putting their phone in their pocket.
   */
  humanGoneGraceMs?: number
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
