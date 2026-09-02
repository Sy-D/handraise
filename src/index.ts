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
 * Or ask instead of hand over, when the agent is not stuck but is about to do
 * something it may not decide alone:
 *
 *   const ok = await raiseHand(page, {
 *     mode: "approval",
 *     reason: "The agent may not move money without a human",
 *     action: "Submit $12,430 vendor payment to Acme GmbH",
 *   })
 *   if (ok.outcome !== "approved") return
 *
 * Needs `SOLARI_API_KEY` in the environment: the handoff page is served from a
 * Solari sandbox that handraise creates and destroys around the call.
 */
export type {
  ApprovalChannelHandoff,
  ChannelHandoff,
  HandoffChannel,
  TakeoverChannelHandoff,
} from "./channels"
export {
  createQrScanner,
  type LinkKind,
  OPENABLE_SCHEMES,
  type QrScanner,
  type ScannedLink,
  scanQrLinks,
} from "./core/qr-scan"
export { raiseHand } from "./core/raise-hand"
export {
  HandraiseError,
  type HandraiseErrorCode,
  isHandraiseError,
} from "./errors"
export type { HandoffEvent } from "./events"
export {
  consoleLogger,
  type LogFields,
  type Logger,
  noopLogger,
  quietLogger,
} from "./logger"
export { handoffQr } from "./qr"
export {
  createNeedHumanTool,
  type NeedHumanDefaults,
  type NeedHumanInput,
  type NeedHumanOutput,
  needHumanToolSpec,
} from "./tool"
export type {
  ApprovalOptions,
  HandoffMode,
  HandoffOptions,
  HandoffOutcome,
  HandoffResult,
  RaiseHand,
  RaiseHandOptions,
  StorageState,
  TakeoverOptions,
} from "./types"
export type { WebhookPayload } from "./webhook"
