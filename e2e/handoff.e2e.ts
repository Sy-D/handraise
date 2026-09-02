/**
 * The proof that handraise does its job.
 *
 * An agent logs into a real site running on a real Solari sandbox, hits a real
 * TOTP wall, and stops. A human who is not the agent — a separate WebSocket
 * client, talking only the public wire protocol — opens the handoff, sees the
 * page, taps the code field, types the code, presses Enter, and hands back.
 * The agent then finds itself signed in.
 *
 * Nothing here asserts that a page rendered. Every assertion is about the job
 * getting done: the field focused where the human tapped, the code in the
 * field, the account page reached, the cookies captured.
 *
 *   bun --env-file=.env e2e/handoff.e2e.ts
 *
 * Costs two sandboxes (the test app and the relay) and one browser session.
 * That is the whole plan allowance, so nothing else may run at the same time —
 * check with `bun --env-file=.env scripts/cleanup-sandboxes.ts` first.
 *
 * Set HANDRAISE_E2E_FAULT=wrong-code to make the human type a wrong code. The
 * run must then fail on the "signed in" assertion; that is how the assertion
 * is known to be load-bearing rather than decorative.
 */
import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright-core"

import type { HandoffEvent } from "../src/events"
import { raiseHand } from "../src/index"
import { startTestApp } from "../test-app/deploy"
import { msUntilNextStep, totp } from "../test-app/totp"
import { openHandoffPage } from "./human-sim"

const FAULT = process.env.HANDRAISE_E2E_FAULT ?? ""
const VIEWPORT = { width: 1280, height: 800 }
const TIMEOUT_CASE_MS = 8_000

const started = Date.now()
const timings: Record<string, number> = {}

/** One wide JSON line per event, the way the relay and the test app log. */
type LogDetail = Record<string, string | number | boolean | undefined>

function log(event: string, detail: LogDetail = {}): void {
  console.log(JSON.stringify({ t: Date.now() - started, event, ...detail }))
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${what}`)
  log("assertion_passed", { what })
}

/** A wrong code that is still six digits, for the deliberate red run. */
function corrupt(code: string): string {
  return [...code].map((digit) => String((Number(digit) + 1) % 10)).join("")
}

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey)
  throw new Error("SOLARI_API_KEY missing — run with --env-file=.env")

const app = await startTestApp({ apiKey, timeoutMs: 15 * 60_000 })
log("test_app_ready", { url: app.url, sandbox: app.sandboxId })
timings.testAppMs = Date.now() - started

const solari = new Solari({ apiKey })
let browser: Awaited<ReturnType<typeof solari.launch>> | undefined
/**
 * A handoff that is still running when an assertion fails. Closing the browser
 * makes it settle as `disconnected`, which is what destroys its relay sandbox
 * — without this, a red run leaks one of the plan's two sandbox slots.
 */
let pending: Promise<unknown> | null = null

try {
  const launchedAt = Date.now()
  browser = await solari.launch({ stealth: true })
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const opened = context.pages()[0] ?? (await context.newPage())
  await opened.setViewportSize(VIEWPORT)
  // SAFETY: `@solarisdk/browser` returns patchright-core's Page. patchright is
  // a Playwright fork whose runtime surface is the one handraise uses — goto,
  // context(), newCDPSession — and measurements 02 and 03 drove exactly this object.
  // The two type declarations differ only in optional-property variance.
  const page = opened as Page
  timings.browserLaunchMs = Date.now() - launchedAt
  log("browser_ready", { ms: timings.browserLaunchMs })

  // --- The agent's part: ordinary Playwright, right up to the wall. --------
  const agentAt = Date.now()
  await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await page.fill('[data-testid="username"]', app.user)
  await page.fill('[data-testid="password"]', app.pass)
  await page.click('[data-testid="login-submit"]')
  await page.waitForSelector('[data-testid="totp-code"]', { timeout: 30_000 })
  timings.agentToWallMs = Date.now() - agentAt
  check(page.url().endsWith("/totp"), "the agent is stuck on the 2FA page")

  // --- The handoff --------------------------------------------------------
  let announce: (url: string) => void = () => undefined
  const urlReady = new Promise<string>((resolve) => {
    announce = resolve
  })

  const handoffAt = Date.now()
  const handoff = raiseHand(page, {
    reason: "Aurora Bank is asking for a 2FA code",
    qr: false,
    onUrl: (url) => announce(url),
  })
  pending = handoff

  const humanUrl = await urlReady
  timings.urlReadyMs = Date.now() - handoffAt
  log("handoff_url", { humanUrl, ms: timings.urlReadyMs })

  const human = await openHandoffPage(humanUrl)
  const first = await human.waitForFrame()
  timings.firstFrameMs = Date.now() - handoffAt
  log("first_frame", {
    ms: timings.firstFrameMs,
    jpeg: `${first.meta.jpegWidth}x${first.meta.jpegHeight}`,
    device: `${first.meta.deviceWidth}x${first.meta.deviceHeight}`,
    bytes: Buffer.from(first.data, "base64").length,
  })
  check(
    first.meta.deviceWidth === VIEWPORT.width,
    "metadata reports the CSS viewport",
  )
  check(
    first.meta.jpegWidth === 800,
    "the frame is scaled to the 800px profile",
  )
  check(
    human.reason() === "Aurora Bank is asking for a 2FA code",
    "the phone shows the reason the agent gave",
  )

  // The human taps the code field. Autofocus already put the caret there, so
  // blur it first — otherwise a broken coordinate mapping would still pass.
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  const box = await page.locator('[data-testid="totp-code"]').boundingBox()
  if (!box) throw new Error("the code field has no bounding box")
  const scale = first.meta.jpegWidth / first.meta.deviceWidth
  await human.tap(
    (box.x + box.width / 2) * scale,
    (box.y + box.height / 2) * scale,
  )
  // Every human message costs a relay hop plus a CDP round trip to us-west, so
  // poll for the effect instead of guessing how long that takes today.
  let focused = ""
  const focusDeadline = Date.now() + 20_000
  while (Date.now() < focusDeadline) {
    focused = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? "",
    )
    if (focused === "totp-code") break
    await Bun.sleep(200)
  }
  check(focused === "totp-code", "the tap focused the field the human aimed at")

  // A code lives 30 s and the app tolerates one step either side. Compute it
  // when the human types it, not when the handoff opened.
  if (msUntilNextStep() < 8_000) await Bun.sleep(msUntilNextStep() + 200)
  const real = totp(app.totpSecret)
  const code = FAULT === "wrong-code" ? corrupt(real) : real
  log("human_types", { fault: FAULT || "none" })

  const typingAt = Date.now()
  await human.type(code)
  let typed = ""
  const typingDeadline = Date.now() + 30_000
  while (Date.now() < typingDeadline) {
    typed = await page.inputValue('[data-testid="totp-code"]')
    if (typed.length >= code.length) break
    await Bun.sleep(200)
  }
  timings.typingMs = Date.now() - typingAt
  check(typed === code, `every character arrived in the field (saw "${typed}")`)

  await human.press("Enter")
  const deadline = Date.now() + 20_000
  while (!page.url().endsWith("/account") && Date.now() < deadline) {
    await Bun.sleep(250)
  }
  check(
    page.url().endsWith("/account"),
    "Enter submitted the form and the code was accepted",
  )

  const framesBeforeHandback = human.frameCount()
  check(framesBeforeHandback > 1, "the cast kept running across the navigation")

  await human.handback()
  const result = await handoff
  pending = null
  timings.handoffMs = Date.now() - handoffAt
  log("handoff_done", {
    outcome: result.outcome,
    durationMs: result.durationMs,
    cookies: result.storageState?.cookies.length,
    ms: timings.handoffMs,
  })

  check(result.outcome === "resolved", "the handoff resolved")
  check(result.url === humanUrl, "the result carries the URL the human used")
  check(
    result.durationMs > 1_000 && result.durationMs < 10 * 60_000,
    `durationMs is plausible (${result.durationMs}ms)`,
  )
  check(result.storageState !== undefined, "storageState was captured")
  check(
    (result.storageState?.cookies.length ?? 0) > 0,
    "storageState carries the session cookie the human earned",
  )
  check(human.ending() === "resolved", "the phone was told the handoff ended")
  await human.close()

  await page.waitForSelector('[data-testid="signed-in"]', { timeout: 15_000 })
  const signedIn = await page.textContent('[data-testid="signed-in"]')
  check(
    signedIn?.includes(app.user) === true,
    `the agent is signed in as ${app.user} (saw "${signedIn}")`,
  )

  const relayGone = await fetch(humanUrl, { cache: "no-store" })
  check(
    relayGone.status !== 200,
    `the relay sandbox is gone (${relayGone.status})`,
  )
  await relayGone.text()

  // --- Approval: the human answers a question, and drives nothing --------
  //
  // The other half of the product. No screencast, no input path: one
  // screenshot, the action in words, and a yes or a no.
  const APPROVAL_ACTION = "Transfer EUR 12,430.00 to Acme GmbH"

  async function askApproval(answer: "approve" | "deny"): Promise<void> {
    const askedAt = Date.now()
    let approvalUrl = ""
    let event: HandoffEvent | undefined
    const asking = raiseHand(page, {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: APPROVAL_ACTION,
      qr: false,
      timeoutMs: 60_000,
      onUrl: (url) => {
        approvalUrl = url
      },
      onEvent: (raised) => {
        event = raised
      },
    })
    pending = asking

    while (approvalUrl === "") await Bun.sleep(50)
    const human = await openHandoffPage(approvalUrl)
    await human.waitForFrame()
    check(
      human.action() === APPROVAL_ACTION,
      `the phone shows the action verbatim (${answer})`,
    )
    check(
      human.reason() === "The agent may not move money without a human",
      `the phone shows the reason (${answer})`,
    )

    // Approval injects nothing. A tap from the same socket the answer comes
    // from must not reach the page, and the relay is the one refusing it.
    const before = page.url()
    await human.tap(10, 10)
    await human.type("9", 0)
    await Bun.sleep(500)

    if (answer === "approve") await human.approve()
    else await human.deny()

    const result = await asking
    pending = null
    timings[`approval${answer}Ms`] = Date.now() - askedAt
    log("approval_done", {
      answer,
      outcome: result.outcome,
      durationMs: result.durationMs,
      frames: human.frameCount(),
      ms: timings[`approval${answer}Ms`],
    })

    const expected = answer === "approve" ? "approved" : "denied"
    check(
      result.outcome === expected,
      `an approval answered with ${answer} reports ${expected}`,
    )
    check(page.url() === before, "nothing the human sent moved the page")
    check(
      human.frameCount() === 1,
      `exactly one screenshot was sent (saw ${human.frameCount()})`,
    )
    check(result.storageState === undefined, "an approval captures no cookies")
    check(event?.mode === "approval", "the wide event carries the mode")
    check(event?.inputsApplied === 0, "no input was applied to the page")
    check(event?.framesSent === 1, "the wide event counts the one frame")
    check(human.ending() === expected, "the phone was told how it ended")
    await human.close()

    const gone = await fetch(approvalUrl, { cache: "no-store" })
    await gone.text()
    check(gone.status !== 200, `the approval relay is gone (${gone.status})`)
  }

  await askApproval("approve")
  await askApproval("deny")

  // --- The cheap second case: nobody comes -------------------------------
  const timeoutAt = Date.now()
  let secondUrl = ""
  const waiting = raiseHand(page, {
    reason: "nobody is going to answer this one",
    qr: false,
    timeoutMs: TIMEOUT_CASE_MS,
    onUrl: (url) => {
      secondUrl = url
    },
  })
  pending = waiting
  const timedOut = await waiting
  pending = null
  timings.timeoutCaseMs = Date.now() - timeoutAt
  log("timeout_case", {
    outcome: timedOut.outcome,
    durationMs: timedOut.durationMs,
    ms: timings.timeoutCaseMs,
  })

  check(timedOut.outcome === "timeout", "an unanswered handoff times out")
  check(
    timedOut.durationMs >= TIMEOUT_CASE_MS,
    `it waited the full ${TIMEOUT_CASE_MS}ms (${timedOut.durationMs}ms)`,
  )
  check(
    timedOut.storageState === undefined,
    "a timed-out handoff captures no cookies",
  )
  const secondGone = await fetch(secondUrl, { cache: "no-store" })
  await secondGone.text()
  check(
    secondGone.status !== 200,
    `its relay was destroyed too (${secondGone.status})`,
  )

  console.log(
    JSON.stringify(
      { evt: "e2e_passed", totalMs: Date.now() - started, timings },
      null,
      2,
    ),
  )
} finally {
  await browser?.close().catch(() => undefined)
  // The handoff notices the dead browser, reports `disconnected` and releases
  // its relay. Awaiting it here is what keeps a failed run from leaking one.
  await pending?.catch(() => undefined)
  await solari.close().catch(() => undefined)
  await app.kill().catch(() => undefined)
  log("cleaned_up")
}
