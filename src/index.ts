/**
 * handraise — human-in-the-loop handoff for Solari cloud browsers.
 *
 *   import { raiseHand } from "handraise"
 *
 *   const result = await raiseHand(page, {
 *     reason: "GitHub is asking for a 2FA code",
 *     webhookUrl: process.env.SLACK_WEBHOOK,
 *   })
 *   if (result.outcome !== "resolved") throw new Error("nobody helped")
 *
 * Needs `SOLARI_API_KEY` in the environment: the handoff page is served from a
 * Solari sandbox that handraise creates and destroys around the call.
 */
export { raiseHand } from "./core/raise-hand"
export type {
  HandoffOutcome,
  HandoffResult,
  RaiseHand,
  RaiseHandOptions,
  StorageState,
} from "./types"
export type { WebhookPayload } from "./webhook"

export const VERSION = "0.0.1"
