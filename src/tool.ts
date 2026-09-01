import type { Page } from "playwright-core"
import { raiseHand } from "./core/raise-hand"
import type { HandoffOutcome, RaiseHandOptions } from "./types"

/**
 * Tool metadata for LLM agents, framework-agnostic: plain JSON Schema, no
 * dependency on `ai`, `zod`, or MCP types. Spread it into your framework's
 * tool definition (see README for a Vercel AI SDK example).
 */
export const needHumanToolSpec = {
  name: "needHuman",
  description:
    "Hand the live browser session to a human and wait. Call this when you " +
    "are stuck: a 2FA prompt, a captcha you cannot solve, or a page you do " +
    "not understand. A human sees the browser on their phone, fixes the " +
    "problem, and hands back. Afterwards, re-read the page — it will have " +
    "changed.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "What you are stuck on, phrased for the human who will help, " +
          'e.g. "GitHub is asking for a 2FA code".',
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
} as const

export interface NeedHumanInput {
  reason: string
}

export interface NeedHumanOutput {
  outcome: HandoffOutcome
  /** One sentence the model can act on without knowing the outcome enum. */
  summary: string
  durationMs: number
}

export type NeedHumanDefaults = Omit<RaiseHandOptions, "reason">

/**
 * Bind `raiseHand` to a page so an LLM agent can call it as a tool.
 *
 *   const needHuman = createNeedHumanTool(page, { webhookUrl })
 *   // Vercel AI SDK:
 *   // tool({ description: needHumanToolSpec.description,
 *   //        inputSchema: jsonSchema(needHumanToolSpec.inputSchema),
 *   //        execute: needHuman })
 */
export function createNeedHumanTool(
  page: Page,
  defaults: NeedHumanDefaults = {},
): (input: NeedHumanInput) => Promise<NeedHumanOutput> {
  return async (input: NeedHumanInput): Promise<NeedHumanOutput> => {
    const result = await raiseHand(page, { ...defaults, reason: input.reason })
    const summary = {
      resolved:
        "A human fixed the problem and handed the browser back. Re-read the page and continue.",
      aborted:
        "The human looked at the problem and aborted the handoff. Do not retry the same step; report why you were stuck.",
      timeout:
        "No human responded in time. Report that you are blocked on human help.",
      disconnected:
        "The browser session died while waiting for the human. The page object is no longer usable; the session must be relaunched.",
    }[result.outcome]
    return { outcome: result.outcome, summary, durationMs: result.durationMs }
  }
}
