import type { Page } from "playwright-core"
import { raiseHand } from "./core/raise-hand"
import type {
  HandoffMode,
  HandoffOptions,
  HandoffOutcome,
  RaiseHandOptions,
} from "./types"

/**
 * Tool metadata for LLM agents, framework-agnostic: plain JSON Schema, no
 * dependency on `ai`, `zod`, or MCP types. Spread it into your framework's
 * tool definition (see README for a Vercel AI SDK example).
 */
export const needHumanToolSpec = {
  name: "needHuman",
  description:
    'Put the browser in front of a human and wait. Use mode "takeover" ' +
    "(the default) when you cannot do it yourself — a 2FA prompt, a captcha, " +
    "a page you do not understand: the human drives the session on their " +
    "phone, fixes it and hands back, so re-read the page afterwards, it will " +
    'have changed. Use mode "approval" when you could do it but are not ' +
    "allowed to decide alone — paying, sending, deleting: the human sees one " +
    "screenshot and the `action` you name, and answers yes or no while the " +
    "browser stays yours.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Why you are asking, phrased for the human who will answer, " +
          'e.g. "GitHub is asking for a 2FA code" or "I may not move money ' +
          'without a human".',
      },
      mode: {
        type: "string",
        enum: ["takeover", "approval"],
        description:
          '"takeover" (default) when you are stuck and need the human to do ' +
          'it; "approval" when you know how to do it but need a yes first.',
      },
      action: {
        type: "string",
        description:
          'Required with mode "approval": the exact step being decided, ' +
          'e.g. "Submit $12,430 vendor payment to Acme GmbH". This is the ' +
          "sentence the human says yes or no to, so write it as the step and " +
          "not as a question.",
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
} as const

export interface NeedHumanInput {
  reason: string
  /** Defaults to "takeover". */
  mode?: HandoffMode
  /** The step being decided. Required when `mode` is "approval". */
  action?: string
}

export interface NeedHumanOutput {
  outcome: HandoffOutcome
  /** One sentence the model can act on without knowing the outcome enum. */
  summary: string
  durationMs: number
}

export type NeedHumanDefaults = Omit<HandoffOptions, "reason">

/**
 * What each ending means to a model that has never seen the outcome enum.
 * Approval mode can only produce the middle two; takeover only the first two.
 */
const SUMMARIES = {
  resolved:
    "A human fixed the problem and handed the browser back. Re-read the page and continue.",
  aborted:
    "The human looked at the problem and aborted the handoff. Do not retry the same step; report why you were stuck.",
  approved:
    "The human approved the action. Carry it out now, exactly as you described it.",
  denied:
    "The human refused the action. Do not carry it out and do not ask again for the same step; report that it was denied.",
  timeout:
    "No human responded in time. Report that you are blocked on human help.",
  disconnected:
    "The browser session died while waiting for the human. The page object is no longer usable; the session must be relaunched.",
} satisfies Record<HandoffOutcome, string>

/**
 * Turn what the model asked for into `raiseHand` options.
 *
 * A model that asks for an approval without naming the action gets an error
 * rather than a takeover: the whole point of the mode is that a human decides
 * on a concrete step, and a missing one would put a blank question on a phone.
 */
function optionsFor(
  defaults: NeedHumanDefaults,
  input: NeedHumanInput,
): RaiseHandOptions {
  if (input.mode !== "approval") return { ...defaults, reason: input.reason }
  if (!input.action) {
    throw new Error(
      'needHuman: mode "approval" needs an `action` — the concrete step the human says yes or no to. Call it again with one, or use the default takeover mode if you are stuck rather than blocked.',
    )
  }
  return {
    ...defaults,
    mode: "approval",
    reason: input.reason,
    action: input.action,
  }
}

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
    const result = await raiseHand(page, optionsFor(defaults, input))
    return {
      outcome: result.outcome,
      summary: SUMMARIES[result.outcome],
      durationMs: result.durationMs,
    }
  }
}
