/**
 * The rescue bench: how many workflows survive a human-only wall?
 *
 *   bun --env-file=.env e2e/rescue-bench.ts        # N=20
 *   RESCUE_N=3 bun --env-file=.env e2e/rescue-bench.ts
 *
 * The question this answers is not "how fast is a handoff" (e2e/bench.ts does
 * that) but "how many jobs get done at all". One workflow is run 2N times
 * against one real Aurora Bank instance: sign in, reach the account page.
 * Every run hits the same wall — a real RFC 6238 TOTP prompt.
 *
 * The two arms:
 *
 *   baseline    An automation with no human and no knowledge of the shared
 *               secret. It tries what an automation can try: submit the form,
 *               scrape the page for a code, reload and retry. Then it stops.
 *               It never touches `app.totpSecret`. The expected result is 0/N,
 *               and that is the honest point: a six-digit code derived from a
 *               secret the agent was never given is not guessable, so this arm
 *               is not a weak baseline, it is the only possible one.
 *
 *   handraise   Identical up to the wall. Then `raiseHand()` and a scripted
 *               human on the public wire protocol: wait for a frame, tap the
 *               field, type the code, press Enter, hand back.
 *
 * What may be claimed from the output, and nothing wider: "of N workflows
 * blocked on a human-only wall, handraise rescued X". This is deliberately not
 * a completion rate over a mixed workload — that number would depend entirely
 * on how many blockers you assume, which is a modelling choice, not a
 * measurement.
 *
 * Design notes that are load-bearing:
 *
 * - The arms are interleaved (baseline i, handraise i, baseline i+1, …) so both
 *   see the same browser ages, the same network minute and the same test-app
 *   state. Running all of one arm first would confound the arm with the clock.
 * - A deterministic script, not an LLM. The claim is about the mechanism; a
 *   model's mood is not part of it.
 * - ONE test-app sandbox is held for the whole bench. Each handoff takes the
 *   second sandbox slot the plan allows, so nothing else may run alongside.
 *   Check with `bun --env-file=.env scripts/cleanup-sandboxes.ts` before and after.
 * - ONE browser session is reused and relaunched after 3 minutes, because
 *   Solari browser sessions die hard around 10 minutes and the sessions API
 *   still calls the corpse "active" (docs/measurements/04-browser-session-lifetime.md).
 * - Every run gets a fresh page and a cookie-free context, so no run inherits
 *   the session a previous rescue earned.
 * - A failed rescue is recorded as a failed rescue. It is never dropped, and
 *   the median is taken over the runs that completed, with the failures shown
 *   next to it.
 *
 * Set RESCUE_FAULT=invert-completed to invert the completion test. The table
 * must then read 20/20 for the baseline and 0/20 for handraise — that is how
 * the counting is known to be load-bearing rather than decorative.
 */
import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright-core"

import type { HandoffEvent } from "../src/events"
import { raiseHand } from "../src/index"
import { startTestApp } from "../test-app/deploy"
import { totp } from "../test-app/totp"
import { openHandoffPage } from "./human-sim"

const N = Number(process.env.RESCUE_N ?? "20")
const FAULT = process.env.RESCUE_FAULT ?? ""
const VIEWPORT = { width: 1280, height: 800 }
/** Sandbox idle budget for the test app. Comfortably longer than 2N runs. */
const APP_TIMEOUT_MS = 45 * 60_000
/** Per-handoff wait budget. A run that hits it is a failure, not a datum. */
const HANDOFF_TIMEOUT_MS = 90_000
/** How long the scripted human waits for its first frame. */
const FRAME_TIMEOUT_MS = 30_000
/** How long any "did the page catch up yet" poll may run. */
const SETTLE_TIMEOUT_MS = 20_000
/** Poll interval for those waits. */
const POLL_MS = 200
/** Relaunch the browser at this age — comfortably under the ~10 min hard death. */
// One benched session died at ~240s (rescue run 12), earlier than S4's 319s
// minimum — 3 minutes keeps the reuse window under the youngest observed death.
const BROWSER_MAX_AGE_MS = 3 * 60_000
/** Breather between runs so a just-killed relay sandbox is off the books. */
const COOLDOWN_MS = 1_000
/** Consecutive rescue failures that mean the infrastructure is down, not the claim. */
const ABORT_AFTER_CONSECUTIVE_FAILURES = 5
const RESULTS_PATH = new URL("../benchmarks/rescue-rate.json", import.meta.url)

const apiKey = process.env.SOLARI_API_KEY ?? ""
if (apiKey === "") {
  throw new Error("SOLARI_API_KEY missing — run with --env-file=.env")
}

type Arm = "baseline" | "handraise"

interface RescueRun {
  index: number
  arm: Arm
  startedAt: string
  /** The whole point: did this workflow reach the account page? */
  completed: boolean
  /** False means the run never even got to the wall — an infrastructure miss. */
  reachedWall: boolean
  /** Page load → the 2FA prompt being on screen, in ms. */
  reachedWallMs: number | null
  /** Wall clock spent on the arm-specific attempt after the wall, in ms. */
  attemptMs: number | null
  /** Automation strategies the baseline arm tried, in order. */
  strategies: string[]
  handoffOutcome: string | null
  /** `durationMs` from the handoff's own wide event: raiseHand → settled. */
  handoffDurationMs: number | null
  /** First frame at the human → handback sent. The time a person is occupied. */
  humanActiveMs: number | null
  error: string | null
  /** Age of the reused browser session when the run started, in ms. */
  browserAgeMs: number
}

// --- the browser lease -----------------------------------------------------

type SolariBrowser = Awaited<ReturnType<Solari["launch"]>>
type SolariContext = Awaited<ReturnType<SolariBrowser["newContext"]>>

interface BrowserLease {
  solari: Solari
  browser: SolariBrowser
  context: SolariContext
  launchedAt: number
}

async function leaseBrowser(): Promise<BrowserLease> {
  const solari = new Solari({ apiKey })
  const launchedAt = Date.now()
  const browser = await solari.launch({ stealth: true })
  const context = browser.contexts()[0] ?? (await browser.newContext())
  // Keep the context's own first page open as an anchor, so closing a run's
  // page never leaves the browser with nothing to hold on to.
  if (context.pages().length === 0) await context.newPage()
  return { solari, browser, context, launchedAt }
}

async function releaseBrowser(lease: BrowserLease): Promise<void> {
  await lease.browser.close().catch(() => undefined)
  // Without this the SDK's transport keeps the process alive after the bench.
  await lease.solari.close().catch(() => undefined)
}

function leaseIsStale(lease: BrowserLease): boolean {
  return (
    Date.now() - lease.launchedAt > BROWSER_MAX_AGE_MS ||
    !lease.browser.isConnected()
  )
}

/** A page with no cookies, so no run inherits an earlier run's session. */
async function freshPage(lease: BrowserLease): Promise<Page> {
  await lease.context.clearCookies()
  const opened = await lease.context.newPage()
  await opened.setViewportSize(VIEWPORT)
  // SAFETY: `@solarisdk/browser` returns patchright-core's Page. patchright is
  // a Playwright fork whose runtime surface is the one handraise uses, and the
  // e2e drives exactly this object; the two declarations differ only in
  // optional-property variance.
  return opened as Page
}

// --- the workflow ----------------------------------------------------------

/** Poll until `check` is true or the budget runs out. Returns whether it was. */
async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check().catch(() => false)) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(POLL_MS)
  }
}

/**
 * The workflow's definition of done: the account page, rendered, for our user.
 *
 * Not "the URL changed" — the URL changes on a 303 before the page exists.
 */
async function reachedAccount(
  page: Page,
  user: string,
  timeoutMs: number,
): Promise<boolean> {
  const arrived = await waitUntil(
    async () => page.url().endsWith("/account"),
    timeoutMs,
  )
  if (!arrived) return false
  const banner = await page
    .textContent('[data-testid="signed-in"]', { timeout: timeoutMs })
    .catch(() => null)
  return banner?.includes(user) === true
}

/** Drive the agent's part: log in with the credentials it has, hit the wall. */
async function walkToWall(page: Page, url: string, user: string, pass: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await page.fill('[data-testid="username"]', user)
  await page.fill('[data-testid="password"]', pass)
  await page.click('[data-testid="login-submit"]')
  await page.waitForSelector('[data-testid="totp-code"]', { timeout: 30_000 })
}

// --- the baseline arm ------------------------------------------------------

/**
 * What an automation without a human can actually do at a TOTP prompt.
 *
 * All three of these are real strategies an agent would try, and none of them
 * can work: the code is an HMAC of a secret this process is not allowed to
 * read here, so there is nothing on the page and nothing to retry into. The
 * arm exists to be tried honestly and to fail honestly.
 */
async function baselineAttempt(page: Page): Promise<string[]> {
  const tried: string[] = []
  const submit = () =>
    page.click('[data-testid="totp-submit"]').catch(() => undefined)

  // 1. Submit what is there. With no code that is an empty required field.
  tried.push("submit-empty")
  await submit()
  await Bun.sleep(1_000)

  // 2. Look for a code on the page. Some flows do print one; this one does not.
  const text = await page
    .evaluate(() => document.body.innerText)
    .catch(() => "")
  const scraped = /\b\d{6}\b/.exec(text)?.[0] ?? null
  if (scraped === null) {
    tried.push("scrape-page:none-found")
  } else {
    tried.push(`scrape-page:submitted-${scraped}`)
    await page.fill('[data-testid="totp-code"]', scraped).catch(() => undefined)
    await submit()
    await Bun.sleep(1_000)
  }

  // 3. The standard "maybe that was a hiccup" retry.
  tried.push("reload-and-retry")
  await page
    .reload({ waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => undefined)
  await submit()
  await Bun.sleep(1_000)

  return tried
}

// --- the handraise arm -----------------------------------------------------

interface HandoffOutcomeRecord {
  outcome: string | null
  event: HandoffEvent | null
  humanActiveMs: number | null
  error: string | null
}

/** Tap the code field, type the current code, press Enter, hand back. */
async function scriptedHuman(
  page: Page,
  humanUrl: string,
  secret: string,
): Promise<number> {
  const human = await openHandoffPage(humanUrl)
  try {
    const first = await human.waitForFrame(FRAME_TIMEOUT_MS)
    const firstFrameAt = Date.now()

    // Where a person would put their thumb, in frame pixels.
    const box = await page.locator('[data-testid="totp-code"]').boundingBox()
    if (!box) throw new Error("the code field has no bounding box")
    const scale = first.meta.jpegWidth / first.meta.deviceWidth
    await human.tap(
      (box.x + box.width / 2) * scale,
      (box.y + box.height / 2) * scale,
    )
    await waitUntil(
      async () =>
        (await page.evaluate(
          () => document.activeElement?.getAttribute("data-testid") ?? "",
        )) === "totp-code",
      SETTLE_TIMEOUT_MS,
    )

    // Computed at typing time, not at handoff time. The app tolerates one
    // 30-second step of drift either side, which covers the flight time.
    const code = totp(secret)
    await human.type(code)
    const landed = await waitUntil(
      async () => (await page.inputValue('[data-testid="totp-code"]')) === code,
      SETTLE_TIMEOUT_MS,
    )
    if (!landed) throw new Error("the code never fully arrived in the field")

    await human.press("Enter")
    await waitUntil(
      async () => page.url().endsWith("/account"),
      SETTLE_TIMEOUT_MS,
    )

    await human.handback()
    return Date.now() - firstFrameAt
  } finally {
    await human.close().catch(() => undefined)
  }
}

/** Raise the hand, run the scripted human, and always let the handoff settle. */
async function handraiseAttempt(
  page: Page,
  secret: string,
): Promise<HandoffOutcomeRecord> {
  const record: HandoffOutcomeRecord = {
    outcome: null,
    event: null,
    humanActiveMs: null,
    error: null,
  }

  let announce: (url: string) => void = () => undefined
  let refuse: (error: Error) => void = () => undefined
  const urlReady = new Promise<string>((resolve, reject) => {
    announce = resolve
    refuse = reject
  })

  const handoff = raiseHand(page, {
    reason: "Aurora Bank is asking for a 2FA code",
    qr: false,
    timeoutMs: HANDOFF_TIMEOUT_MS,
    onUrl: (url) => announce(url),
    onEvent: (event) => {
      record.event = event
    },
  })
  // `raiseHand` throws only when the relay never came up. That rejection has to
  // reach `urlReady` too, or this run would hang on a promise nobody resolves.
  handoff.catch((error: Error) => refuse(error))

  try {
    const humanUrl = await urlReady
    record.humanActiveMs = await scriptedHuman(page, humanUrl, secret)
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error)
  }

  // Whatever happened above, the handoff has to settle: that is what destroys
  // the relay sandbox and frees the single slot the next run needs.
  const result = await handoff.catch((error: Error) => {
    record.error = record.error ?? error.message
    return null
  })
  record.outcome = result?.outcome ?? "throw"
  return record
}

// --- one run ---------------------------------------------------------------

interface Target {
  url: string
  user: string
  pass: string
  totpSecret: string
}

async function runWorkflow(
  index: number,
  arm: Arm,
  lease: BrowserLease,
  app: Target,
): Promise<RescueRun> {
  const run: RescueRun = {
    index,
    arm,
    startedAt: new Date().toISOString(),
    completed: false,
    reachedWall: false,
    reachedWallMs: null,
    attemptMs: null,
    strategies: [],
    handoffOutcome: null,
    handoffDurationMs: null,
    humanActiveMs: null,
    error: null,
    browserAgeMs: Date.now() - lease.launchedAt,
  }

  const page = await freshPage(lease)
  try {
    const walkAt = Date.now()
    await walkToWall(page, app.url, app.user, app.pass)
    run.reachedWall = true
    run.reachedWallMs = Date.now() - walkAt

    const attemptAt = Date.now()
    if (arm === "baseline") {
      run.strategies = await baselineAttempt(page)
    } else {
      const handoff = await handraiseAttempt(page, app.totpSecret)
      run.handoffOutcome = handoff.outcome
      run.handoffDurationMs = handoff.event?.durationMs ?? null
      run.humanActiveMs = handoff.humanActiveMs
      run.error = handoff.error
    }
    run.attemptMs = Date.now() - attemptAt

    // The baseline has nothing left in flight, so it needs no patience here;
    // the handraise arm may still be finishing a 303 into /account.
    const arrived = await reachedAccount(
      page,
      app.user,
      arm === "baseline" ? 1_000 : SETTLE_TIMEOUT_MS,
    )
    const resolved = arm === "baseline" || run.handoffOutcome === "resolved"
    run.completed =
      FAULT === "invert-completed"
        ? !(arrived && resolved)
        : arrived && resolved
  } catch (error) {
    run.error =
      run.error ?? (error instanceof Error ? error.message : String(error))
  } finally {
    await page.close().catch(() => undefined)
  }

  return run
}

// --- statistics ------------------------------------------------------------

/** Nearest-rank percentile: sort, then take index ceil(p * n) - 1. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil(p * sorted.length) - 1
  const index = Math.min(sorted.length - 1, Math.max(0, rank))
  return sorted[index] ?? Number.NaN
}

function median(values: number[]): number {
  return percentile(
    [...values].sort((a, b) => a - b),
    0.5,
  )
}

interface ArmSummary {
  arm: Arm
  label: string
  runs: number
  completed: number
  /** Runs that never reached the wall: infrastructure, not the claim. */
  neverReachedWall: number
  /** Median of the handoff's own durationMs over completed runs, in ms. */
  medianHandoffMs: number | null
  /** Median of first-frame → handback over completed runs, in ms. */
  medianHumanActiveMs: number | null
}

function summarise(arm: Arm, label: string, runs: RescueRun[]): ArmSummary {
  const mine = runs.filter((run) => run.arm === arm)
  const done = mine.filter((run) => run.completed)
  const handoffs = done
    .map((run) => run.handoffDurationMs)
    .filter((value): value is number => value !== null)
  const active = done
    .map((run) => run.humanActiveMs)
    .filter((value): value is number => value !== null)
  return {
    arm,
    label,
    runs: mine.length,
    completed: done.length,
    neverReachedWall: mine.filter((run) => !run.reachedWall).length,
    medianHandoffMs: handoffs.length === 0 ? null : median(handoffs),
    medianHumanActiveMs: active.length === 0 ? null : median(active),
  }
}

function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`
}

function printTable(summaries: ArmSummary[]): void {
  const header = ["", "completed", "median human time"]
  const rows = summaries.map((summary) => [
    summary.label,
    `${summary.completed}/${summary.runs}`,
    seconds(summary.medianHandoffMs),
  ])
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => (row[column] ?? "").length)),
  )
  const line = (cells: string[]): string =>
    `| ${cells
      .map((text, column) =>
        column === 0
          ? text.padEnd(widths[column] ?? 0)
          : text.padStart(widths[column] ?? 0),
      )
      .join(" | ")} |`

  console.log("")
  console.log(line(header))
  console.log(`|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`)
  for (const row of rows) console.log(line(row))
}

// --- the bench -------------------------------------------------------------

const benchStartedAt = Date.now()
const runs: RescueRun[] = []
let relaunches = 0
let consecutiveRescueFailures = 0
let abortReason: string | null = null

const app = await startTestApp({ apiKey, timeoutMs: APP_TIMEOUT_MS })
console.log(
  JSON.stringify({
    event: "test_app_ready",
    url: app.url,
    sandbox: app.sandboxId,
  }),
)

let lease = await leaseBrowser()

try {
  for (let index = 1; index <= N && abortReason === null; index += 1) {
    for (const arm of ["baseline", "handraise"] as const) {
      if (leaseIsStale(lease)) {
        await releaseBrowser(lease)
        lease = await leaseBrowser()
        relaunches += 1
        console.log(
          JSON.stringify({ event: "browser_relaunched", before: index, arm }),
        )
      }

      const run = await runWorkflow(index, arm, lease, app)
      runs.push(run)
      console.log(
        JSON.stringify({
          event: "rescue_run",
          index,
          arm,
          completed: run.completed,
          reachedWall: run.reachedWall,
          handoffOutcome: run.handoffOutcome,
          handoffDurationMs: run.handoffDurationMs,
          humanActiveMs: run.humanActiveMs,
          strategies: run.strategies.length === 0 ? undefined : run.strategies,
          error: run.error,
        }),
      )

      // A dead session poisons every later run, so replace it now rather than
      // after 2N-1 more failures.
      if (
        run.handoffOutcome === "disconnected" ||
        !lease.browser.isConnected()
      ) {
        await releaseBrowser(lease)
        lease = await leaseBrowser()
        relaunches += 1
        console.log(
          JSON.stringify({ event: "browser_relaunched", after: index }),
        )
      }

      if (arm === "handraise") {
        consecutiveRescueFailures = run.completed
          ? 0
          : consecutiveRescueFailures + 1
        if (consecutiveRescueFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
          abortReason = `${ABORT_AFTER_CONSECUTIVE_FAILURES} rescue runs failed in a row — the infrastructure is down, not the claim`
          console.log(
            JSON.stringify({ event: "rescue_aborted", reason: abortReason }),
          )
          break
        }
      }

      await Bun.sleep(COOLDOWN_MS)
    }
  }
} finally {
  await releaseBrowser(lease)
  await app.kill().catch(() => undefined)
}

const summaries = [
  summarise("baseline", "baseline (no human available)", runs),
  summarise("handraise", "with handraise", runs),
]
const failures = runs.filter((run) => !run.completed && run.arm === "handraise")

await Bun.write(
  RESULTS_PATH,
  `${JSON.stringify(
    {
      meta: {
        date: new Date().toISOString(),
        requestedN: N,
        workflow: "sign in to Aurora Bank and reach the account page",
        wall: "RFC 6238 TOTP (SHA-1, 30 s step, ±1 step tolerance)",
        claim:
          "of workflows blocked on a human-only wall, handraise rescued X of N",
        notAClaim:
          "this is not a completion rate over a mixed workload; no blocker mix is assumed",
        arms: {
          baseline:
            "deterministic automation, no human, no access to the TOTP secret",
          handraise:
            "raiseHand() plus a scripted human on the public wire protocol",
        },
        interleaved: true,
        fault: FAULT === "" ? null : FAULT,
        abortReason,
        browserRelaunches: relaunches,
        totalMs: Date.now() - benchStartedAt,
        bunVersion: Bun.version,
        platform: `${process.platform}-${process.arch}`,
        measuredFrom: "Germany → default Solari endpoint (api.getsolari.com)",
        handoffTimeoutMs: HANDOFF_TIMEOUT_MS,
        viewport: VIEWPORT,
      },
      summaries,
      runs,
    },
    null,
    2,
  )}\n`,
)

printTable(summaries)
console.log("")
console.log(
  JSON.stringify({
    event: "rescue_done",
    workflowsPerArm: summaries[0]?.runs ?? 0,
    baselineCompleted: summaries[0]?.completed ?? 0,
    handraiseCompleted: summaries[1]?.completed ?? 0,
    medianHandoffMs: summaries[1]?.medianHandoffMs ?? null,
    medianHumanActiveMs: summaries[1]?.medianHumanActiveMs ?? null,
    rescueFailures: failures.length,
    browserRelaunches: relaunches,
    totalMs: Date.now() - benchStartedAt,
    results: RESULTS_PATH.pathname,
  }),
)
for (const failure of failures) {
  console.log(
    JSON.stringify({
      event: "rescue_failure",
      index: failure.index,
      reachedWall: failure.reachedWall,
      handoffOutcome: failure.handoffOutcome,
      error: failure.error,
      browserAgeMs: failure.browserAgeMs,
    }),
  )
}
