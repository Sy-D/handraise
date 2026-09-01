/**
 * The demo where nobody tells the agent to stop.
 *
 *   # you are the human, on your phone:
 *   bun --env-file=.env --env-file=demo/.env demo/agent.ts
 *   # a scripted finger plays the human, so the run verifies itself:
 *   DEMO_SIM=1 bun --env-file=.env --env-file=demo/.env demo/agent.ts
 *
 * Everything else here is real: a real Claude model in a real tool loop, a real
 * Solari cloud browser, a real login wall on a real server. The model gets four
 * tools — read the page, fill a field, click something, and `needHuman`. Nothing
 * in this file decides when the handoff happens. The model hits a TOTP prompt it
 * has no way to answer, and calls `needHuman` itself. That is the whole point:
 * the agent knows where its autonomy ends.
 *
 * With `DEMO_SIM=1` the only scripted part is the finger. A separate WebSocket
 * client — the same one the e2e uses, talking the public wire protocol — opens
 * the handoff page, taps the code field, types the code and hands back. The LLM,
 * the sandbox and the relay are untouched, so the full autonomous run is
 * machine-verifiable without a phone in the room.
 *
 * The six digits come from the test app's own TOTP secret, which this script
 * holds because it deployed the app a minute ago. Printing them is honest here:
 * the thing being demonstrated is the handoff mechanic, not the secret.
 *
 * `SOLARI_API_KEY` lives in the repo `.env`; the LLM key lives in `demo/.env`.
 * Set either `ANTHROPIC_API_KEY` (Anthropic direct, the default) or
 * `OPENROUTER_API_KEY` (any OpenRouter model). `DEMO_MODEL` overrides the model
 * id for whichever provider wins — for OpenRouter that is any id it serves,
 * e.g. `DEMO_MODEL=anthropic/claude-sonnet-4.5`.
 *
 * Costs two Solari sandboxes (the test app and the handoff relay), which is the
 * whole plan allowance — check `bun --env-file=.env spikes/s1/cleanup.ts` first.
 */
import { anthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Solari } from "@solarisdk/browser"
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  stepCountIs,
  tool,
} from "ai"
import type { Page } from "playwright-core"

import { openHandoffPage } from "../e2e/human-sim"
import {
  createNeedHumanTool,
  type NeedHumanDefaults,
  type NeedHumanInput,
  type NeedHumanOutput,
  needHumanToolSpec,
} from "../src/index"
import { startTestApp } from "../test-app/deploy"
import { msUntilNextStep, totp } from "../test-app/totp"

const ANTHROPIC_MODEL = "claude-opus-5"
const OPENROUTER_MODEL = "anthropic/claude-opus-4.5"
const OPENROUTER_URL = "https://openrouter.ai/api/v1"
const MAX_STEPS = Number(process.env.DEMO_MAX_STEPS ?? 12)
const HANDOFF_TIMEOUT_MS = 4 * 60_000
const SNAPSHOT_CHARS = 2_000
const VIEWPORT = { width: 1280, height: 800 }
const CODE_FIELD = '[data-testid="totp-code"]'
const SIM = process.env.DEMO_SIM === "1"

interface FillInput {
  selector: string
  value: string
}

interface ClickInput {
  selector: string
}

interface ChosenModel {
  model: LanguageModel
  label: string
}

/**
 * Anthropic direct if there is a key for it, otherwise OpenRouter. Everything
 * downstream only sees a `LanguageModel`, so the demo does not care which won.
 */
function chooseModel(): ChosenModel | null {
  const override = process.env.DEMO_MODEL?.trim()
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (anthropicKey) {
    const id = override || ANTHROPIC_MODEL
    return { model: anthropic(id), label: `anthropic:${id}` }
  }
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim()
  if (openrouterKey) {
    const id = override || OPENROUTER_MODEL
    const openrouter = createOpenAICompatible({
      name: "openrouter",
      baseURL: OPENROUTER_URL,
      apiKey: openrouterKey,
    })
    return { model: openrouter.chatModel(id), label: `openrouter:${id}` }
  }
  return null
}

/** Poll instead of guessing: every human message is a relay hop plus a CDP round trip. */
async function until(
  ready: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await ready()) return true
    await Bun.sleep(200)
  }
  return false
}

/**
 * What the model gets to see: the visible text, the controls it can address, and
 * where it is. Deliberately no field values — the model must not read back a
 * password it typed, or a code a human typed for it.
 */
async function describePage(page: Page): Promise<string> {
  const dom = await page.evaluate(() => {
    const selectorFor = (element: Element): string => {
      const testid = element.getAttribute("data-testid")
      if (testid) return `[data-testid="${testid}"]`
      const id = element.getAttribute("id")
      if (id) return `#${id}`
      const name = element.getAttribute("name")
      if (name) return `${element.tagName.toLowerCase()}[name="${name}"]`
      return element.tagName.toLowerCase()
    }
    const labelFor = (element: Element): string => {
      const aria = element.getAttribute("aria-label")
      if (aria) return aria
      const placeholder = element.getAttribute("placeholder")
      if (placeholder) return placeholder
      const id = element.getAttribute("id")
      const label = id ? document.querySelector(`label[for="${id}"]`) : null
      const text = label?.textContent ?? element.textContent ?? ""
      return text.trim().slice(0, 60)
    }
    const controls = Array.from(
      document.querySelectorAll("input, button, select, textarea, a[href]"),
    ).map((element) => {
      const kind =
        element instanceof HTMLInputElement
          ? `input type=${element.type}`
          : element.tagName.toLowerCase()
      return `${selectorFor(element)} (${kind}) ${labelFor(element)}`.trim()
    })
    return { text: document.body.innerText.trim(), controls }
  })

  const snapshot = [
    `url: ${page.url()}`,
    "",
    "visible text:",
    dom.text,
    "",
    "controls (use these selectors):",
    ...dom.controls,
  ].join("\n")
  return snapshot.length > SNAPSHOT_CHARS
    ? `${snapshot.slice(0, SNAPSHOT_CHARS)}\n…(truncated)`
    : snapshot
}

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("SOLARI_API_KEY missing — run with `bun --env-file=.env`.")
  process.exit(1)
}
const llm = chooseModel()
if (!llm) {
  console.error(
    "No LLM key. This demo runs a real model; there is no offline mode.\n" +
      "Put ANTHROPIC_API_KEY or OPENROUTER_API_KEY in demo/.env, then run:\n" +
      "  bun --env-file=.env --env-file=demo/.env demo/agent.ts",
  )
  process.exit(1)
}

console.log("deploying the Aurora Bank test app to a Solari sandbox…")
const app = await startTestApp({ apiKey, timeoutMs: 15 * 60_000 })
console.log(`test app up: ${app.url}\n`)

const solari = new Solari({ apiKey })
let browser: Awaited<ReturnType<typeof solari.launch>> | undefined
let ticker: ReturnType<typeof setInterval> | null = null

interface RunState {
  /** A scripted human still typing when something throws; awaiting it releases the relay. */
  scripted: Promise<void> | null
  /** What the handoff came to, if the model ever asked for one. */
  handoff: NeedHumanOutput | null
}

/** Written from inside the tool callbacks, read from the main flow. */
const state: RunState = { scripted: null, handoff: null }

function stopTicker(): void {
  if (ticker) clearInterval(ticker)
  ticker = null
}

/**
 * Interactive mode: the operator scans the QR and needs the digits the app wants
 * right now. A code lives 30 s, so reprint one every step until the human is done.
 */
function printCodes(): void {
  const show = (): void => {
    console.log(
      `   current code: ${totp(app.totpSecret)} ` +
        `(valid for ${Math.round(msUntilNextStep() / 1000)}s)`,
    )
  }
  show()
  ticker = setInterval(show, 30_000)
}

try {
  browser = await solari.launch({ stealth: true })
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const opened = context.pages()[0] ?? (await context.newPage())
  await opened.setViewportSize(VIEWPORT)
  // SAFETY: `@solarisdk/browser` returns patchright-core's Page. patchright is a
  // Playwright fork whose runtime surface is the one handraise uses; the two
  // declarations differ only in optional-property variance. The e2e and
  // demo/github-2fa.ts drive this same cast.
  const page = opened as Page

  /**
   * The scripted finger. It is not a mock of handraise: it speaks the public
   * `role=human` protocol over the real relay, exactly like a phone.
   */
  const playHuman = async (humanUrl: string): Promise<void> => {
    const human = await openHandoffPage(humanUrl)
    try {
      const frame = await human.waitForFrame()
      const box = await page.locator(CODE_FIELD).boundingBox()
      if (!box) throw new Error("the code field has no bounding box")
      const scale = frame.meta.jpegWidth / frame.meta.deviceWidth
      await human.tap(
        (box.x + box.width / 2) * scale,
        (box.y + box.height / 2) * scale,
      )
      const focused = await until(
        async () =>
          (await page.evaluate(
            () => document.activeElement?.getAttribute("data-testid") ?? "",
          )) === "totp-code",
        20_000,
      )
      if (!focused) throw new Error("the tap never focused the code field")

      // A code lives 30 s; compute it when the finger types it, not earlier.
      if (msUntilNextStep() < 8_000) await Bun.sleep(msUntilNextStep() + 200)
      const code = totp(app.totpSecret)
      console.log(`   scripted human taps in ${code}`)
      await human.type(code)
      const typed = await until(
        async () => (await page.inputValue(CODE_FIELD)).length >= code.length,
        30_000,
      )
      if (!typed) throw new Error("the code never landed in the field")

      await human.press("Enter")
      await until(async () => page.url().endsWith("/account"), 20_000)
      await human.handback()
    } catch (error) {
      console.error(
        `   scripted human failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      await human.abort().catch(() => undefined)
    } finally {
      await human.close()
    }
  }

  const defaults: NeedHumanDefaults = {
    qr: !SIM,
    timeoutMs: HANDOFF_TIMEOUT_MS,
    onUrl: SIM
      ? (url) => {
          state.scripted = playHuman(url)
        }
      : () => printCodes(),
  }
  const raise = createNeedHumanTool(page, defaults)

  const tools = {
    readPage: tool({
      description:
        "Read the page you are on: its URL, its visible text, and the " +
        "selectors of every field and button. Field values are not shown.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async (): Promise<string> => {
        try {
          return await describePage(page)
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),

    fill: tool({
      description: "Type a value into a form field addressed by CSS selector.",
      inputSchema: jsonSchema<FillInput>({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector from readPage.",
          },
          value: { type: "string", description: "The text to type." },
        },
        required: ["selector", "value"],
        additionalProperties: false,
      }),
      execute: async (input): Promise<string> => {
        try {
          await page.locator(input.selector).fill(input.value)
          return `filled ${input.selector}`
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),

    click: tool({
      description: "Click an element addressed by CSS selector.",
      inputSchema: jsonSchema<ClickInput>({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector from readPage.",
          },
        },
        required: ["selector"],
        additionalProperties: false,
      }),
      execute: async (input): Promise<string> => {
        try {
          await page.locator(input.selector).click()
          await page.waitForLoadState("domcontentloaded")
          return `clicked ${input.selector}; now at ${page.url()}`
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),

    needHuman: tool({
      description: needHumanToolSpec.description,
      inputSchema: jsonSchema<NeedHumanInput>(needHumanToolSpec.inputSchema),
      execute: async (input): Promise<NeedHumanOutput> => {
        console.log(`\n✋ agent raised its hand: ${input.reason}\n`)
        try {
          state.handoff = await raise(input)
          return state.handoff
        } finally {
          stopTicker()
        }
      },
    }),
  }

  await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 45_000 })
  console.log(`browser open at ${page.url()}`)
  console.log(`handing the task to ${llm.label} — nothing below is scripted.\n`)

  const result = await generateText({
    model: llm.model,
    stopWhen: stepCountIs(MAX_STEPS),
    tools,
    system:
      "You drive one open browser page with the tools you are given. Read the " +
      "page before you act, and read it again after anything changes. You " +
      "cannot receive SMS, read an authenticator app, or invent a one-time " +
      "code. If a step needs information only a human can provide, call " +
      "needHuman with a reason that human would understand, then carry on.",
    prompt:
      `Sign in to the portal at ${app.url} as ${app.user} with password ` +
      `${app.pass} and reach the account page. The browser is already open ` +
      `there. You cannot receive SMS or read authenticator apps. If a step ` +
      `requires information only a human can provide, use the needHuman tool.`,
    onStepEnd: (step) => {
      const said = step.text.trim().replace(/\s+/g, " ")
      if (said) console.log(`  “${said.slice(0, 180)}”`)
      for (const call of step.staticToolCalls) {
        if (call.toolName === "fill") {
          const shown =
            call.input.value === app.pass ? "•••••••" : call.input.value
          console.log(`  → fill ${call.input.selector} = "${shown}"`)
        } else if (call.toolName === "click") {
          console.log(`  → click ${call.input.selector}`)
        } else if (call.toolName === "needHuman") {
          console.log(`  → needHuman: ${call.input.reason}`)
        } else {
          console.log("  → readPage")
        }
      }
      for (const outcome of step.staticToolResults) {
        if (outcome.toolName === "needHuman") {
          console.log(
            `  ← handoff ${outcome.output.outcome} after ` +
              `${Math.round(outcome.output.durationMs / 1000)}s`,
          )
        } else if (outcome.toolName === "readPage") {
          console.log(`  ← page read (${outcome.output.length} chars)`)
        } else {
          console.log(`  ← ${outcome.output}`)
        }
      }
    },
  })

  await state.scripted?.catch(() => undefined)
  state.scripted = null

  const signedIn = (await page.locator('[data-testid="signed-in"]').count()) > 0
  const banner = signedIn
    ? await page.textContent('[data-testid="signed-in"]')
    : null

  console.log("\n───────────────────────────────────────────")
  console.log(`steps          ${result.steps.length} of ${MAX_STEPS}`)
  console.log(`tool calls     ${result.staticToolCalls.length}`)
  console.log(
    `handoff        ${state.handoff ? `${state.handoff.outcome} in ${Math.round(state.handoff.durationMs / 1000)}s` : "the agent never raised its hand"}`,
  )
  console.log(`final url      ${page.url()}`)
  console.log(
    `account page   ${signedIn ? `reached — ${banner}` : "NOT reached"}`,
  )
  if (result.text.trim()) console.log(`\nagent: ${result.text.trim()}`)
  console.log("───────────────────────────────────────────")

  if (!signedIn || state.handoff?.outcome !== "resolved") {
    process.exitCode = 1
  }
} catch (error) {
  console.error(
    `\nrun failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
} finally {
  stopTicker()
  await browser?.close().catch(() => undefined)
  // A live handoff notices the dead browser, reports `disconnected` and releases
  // its relay sandbox. Awaiting it here is what keeps a failed run from leaking one.
  await state.scripted?.catch(() => undefined)
  await solari.close().catch(() => undefined)
  await app.kill().catch(() => undefined)
  console.log("cleaned up.")
}
