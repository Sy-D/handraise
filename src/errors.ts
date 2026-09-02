/**
 * The errors `handraise` throws, with a code the caller can branch on.
 *
 *   import { isHandraiseError, raiseHand } from "handraise"
 *
 *   try {
 *     await raiseHand(page, { reason: "GitHub is asking for a 2FA code" })
 *   } catch (error) {
 *     if (isHandraiseError(error) && error.code === "concurrency_limit") {
 *       // wait for a session to free up, then try again
 *     }
 *   }
 *
 * The `code` is the contract; the message is written for a person reading a
 * log and may be reworded in any release. Nothing that happens *after* the
 * handoff URL exists is an error here — a human who never came, a browser
 * session that died mid-handoff, a webhook that 500s: those are outcomes and
 * log lines, because by then somebody has already been asked for help.
 * Everything below happens before that, while there is still nothing to take
 * back.
 */

/**
 * Why a call refused to start.
 *
 * - `missing_api_key` — no `options.apiKey` and no `SOLARI_API_KEY`.
 * - `invalid_mode` — `mode` was neither `"takeover"` nor `"approval"`.
 * - `empty_action` — `mode: "approval"` without a non-empty `action`.
 * - `browser_unusable` — the page is closed, or its browser has disconnected.
 *   Checked before anything is created, from local state only: a Solari
 *   session that has died server-side while the CDP socket is still up looks
 *   alive here and still ends as the `disconnected` outcome.
 * - `relay_start_failed` — the relay sandbox could not be created or deployed;
 *   `cause` holds the SDK error.
 * - `concurrency_limit` — the Solari account is at its concurrent session cap
 *   (HTTP 429). The one relay failure that is worth retrying later.
 * - `relay_not_ready` — the sandbox started but its public URL never answered.
 *
 * There is deliberately no code for a relay sandbox that survives its own
 * teardown: `raiseHand` catches that one, logs `relay_release_failed` and
 * returns the outcome, because by then the human has already answered. Every
 * code above is one a caller can actually catch.
 */
export type HandraiseErrorCode =
  | "missing_api_key"
  | "invalid_mode"
  | "empty_action"
  | "browser_unusable"
  | "relay_start_failed"
  | "concurrency_limit"
  | "relay_not_ready"

/**
 * Everything handraise throws on purpose. `cause` carries the original SDK,
 * CDP or network error whenever there was one, so the wrapping hides nothing.
 */
export class HandraiseError extends Error {
  override readonly name = "HandraiseError"
  /** Stable across releases, unlike `message`. Branch on this. */
  readonly code: HandraiseErrorCode

  constructor(
    code: HandraiseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.code = code
  }
}

/**
 * Narrow a caught value to a `HandraiseError`.
 *
 * A `catch` binding is `unknown` by design, and this is the boundary that
 * turns it into a domain value — which is why the parameter is the one
 * unparsed input in the package.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a type guard is the boundary that parses `unknown`; a narrower parameter would push the assertion into every caller's catch block.
export function isHandraiseError(error: unknown): error is HandraiseError {
  return error instanceof HandraiseError
}
