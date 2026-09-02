/**
 * The mixed-workload bench: across a realistic mix of human interrupts, what
 * does each mode cost, and how many workflows get done?
 *
 *   bun --env-file=.env e2e/mixed-bench.ts        # N=20
 *   MIXED_N=4 bun --env-file=.env e2e/mixed-bench.ts
 *
 * e2e/bench.ts times one handoff. e2e/rescue-bench.ts counts workflows that a
 * takeover saves. Neither answers the question a team asks before adopting
 * this: an agent fleet meets two different interrupts, and they do not cost the
 * same. One kind needs the browser driven; the other needs one decision.
 *
 * The two interrupts, both against ONE live Aurora Bank instance:
 *
 *   takeover    The agent signs in with the credentials it has and stops at a
 *               real RFC 6238 TOTP wall it cannot pass. A scripted human on the
 *               public WebSocket taps the field, types the code, presses Enter
 *               and hands back. This is the capability gap.
 *
 *   approval    The agent is signed in and not stuck at all. It fills a
 *               transfer form and stops before submitting, because moving money
 *               is not its decision. A scripted human sees one screenshot and
 *               the action in words, and answers. This is the authority
 *               boundary.
 *
 * Both interrupts are measured the same way, on the human's socket, so the two
 * columns of the output are comparable.
 *
 * What may be claimed from the output, and nothing wider: on this workload,
 * an approval costs one frame and a few kilobytes where a takeover costs a
 * stream, and both got their workflows done at rate X. It is NOT a claim about
 * the mix a real fleet sees — the 50/50 split here is a choice this harness
 * makes, not a measurement of anyone's traffic. Multiply the per-mode costs by
 * your own mix.
 *
 * Design notes that are load-bearing:
 *
 * - The kinds are interleaved (takeover, approval, takeover, …) so neither sees
 *   systematically older browsers or a different network minute than the other.
 * - Deterministic scripts, not an LLM. The claim is about the mechanism.
 * - Every 4th approval is DENIED, and a denied approval counts as completed:
 *   the workflow reached a decision and the agent obeyed it. A bench that only
 *   counted "yes" would be measuring agreement, not delivery.
 * - The approval arm signs itself in with the shared secret. That sign-in is
 *   setup, not the interrupt under measurement — the interrupt here is the
 *   authority boundary at the transfer, and it happens after the wall. Only the
 *   takeover arm is barred from the secret, because there the wall IS the test.
 * - ONE test-app sandbox is held for the whole bench, and each handoff takes
 *   the second sandbox slot the plan allows, so nothing else may run alongside.
 *   Check with `bun --env-file=.env scripts/cleanup-sandboxes.ts` before and
 *   after. Two handoffs never run at once.
 * - ONE browser session is reused and relaunched after 3 minutes, because
 *   Solari browser sessions die hard around 10 minutes and the sessions API
 *   still calls the corpse "active"
 *   (docs/measurements/04-browser-session-lifetime.md).
 * - Every workflow gets a fresh page and a cookie-free context, so no run
 *   inherits the session or the transfer receipt an earlier run left behind.
 * - A failed run is recorded as a failed run. Percentiles are over the runs
 *   that completed, with the failures shown next to them.
 *
 * Set MIXED_FAULT=invert-completed to invert the completion test. Both modes
 * must then read 0 of N — that is how the counting is known to be load-bearing
 * rather than decorative.
 */
import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright-core"

import type { HandoffEvent } from "../src/events"
import { raiseHand } from "../src/index"
import { startTestApp } from "../test-app/deploy"
import { totp } from "../test-app/totp"
import { openHandoffPage, type SimulatedHuman } from "./human-sim"

/** Total workflows, split evenly between the two interrupt kinds. */
const N = Number(process.env.MIXED_N ?? "20")
const FAULT = process.env.MIXED_FAULT ?? ""
const VIEWPORT = { width: 1280, height: 800 }
/** Every 4th approval is denied, so the denied path is measured, not assumed. */
const DENY_EVERY = 4
/** Sandbox idle budget for the test app. Comfortably longer than N runs. */
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
const BROWSER_MAX_AGE_MS = 3 * 60_000
/** Breather between runs so a just-killed relay sandbox is off the books. */
const COOLDOWN_MS = 1_000
/** Consecutive failures that mean the infrastructure is down, not the claim. */
const ABORT_AFTER_CONSECUTIVE_FAILURES = 5
const RESULTS_PATH = new URL(
  "../benchmarks/mixed-workload.json",
  import.meta.url,
)

const apiKey = process.env.SOLARI_API_KEY ?? ""
if (apiKey === "") {
  throw new Error("SOLARI_API_KEY missing — run with --env-file=.env")
}

type Kind = "takeover" | "approval"
type Decision = "approve" | "deny"

interface MixedRun {
  index: number
  kind: Kind
  startedAt: string
  /** The whole point: did this workflow reach its end state? */
  completed: boolean
  /** False means the run never got to the interrupt — infrastructure, not the claim. */
  reachedInterrupt: boolean
  /** Page load → standing at the interrupt, in ms. */
  reachedInterruptMs: number | null
  /** What the scripted human answered. Approval runs only. */
  decision: Decision | null
  handoffOutcome: string | null
  /** `raiseHand()` → the first frame arriving AT THE HUMAN, in ms. */
  stuckToVisibleMs: number | null
  /** `durationMs` from the handoff's own wide event: raiseHand → settled. */
  handoffDurationMs: number | null
  relayColdStartMs: number | null
  /** Frames the agent put on the wire (`framesSent` from the wide event). */
  framesSent: number | null
  /** The same frames counted on the human's socket, as a cross-check. */
  framesAtHuman: number | null
  /** Sum of the base64 frame payloads, in bytes. */
  bytesSent: number | null
  /** Taps, characters, keys and scrolls applied to the page. */
  inputsApplied: number | null
  /** First frame at the human → the answer being sent. A person's occupancy. */
  humanActiveMs: number | null
  /**
   * Wall-clock seconds a relay sandbox existed for this handoff: `raiseHand()`
   * to the promise settling, which is create + live + destroy. The cost proxy.
   */
  relaySandboxSeconds: number | null
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

interface Target {
  url: string
  user: string
  pass: string
  totpSecret: string
}

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
 * The sign-in step's definition of done: the account page, rendered, for our
 * user. Not "the URL changed" — the URL changes on a 303 before the page exists.
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
async function walkToWall(page: Page, app: Target): Promise<void> {
  await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await page.fill('[data-testid="username"]', app.user)
  await page.fill('[data-testid="password"]', app.pass)
  await page.click('[data-testid="login-submit"]')
  await page.waitForSelector('[data-testid="totp-code"]', { timeout: 30_000 })
}

/** Is a receipt for a sent transfer on the page right now? */
async function transferWasSent(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  return waitUntil(
    async () =>
      (await page.locator('[data-testid="transfer-done"]').count()) > 0,
    timeoutMs,
  )
}

// --- the takeover interrupt ------------------------------------------------

/** Tap the code field, type the current code, press Enter, hand back. */
async function humanSolvesTheWall(
  page: Page,
  human: SimulatedHuman,
  secret: string,
): Promise<void> {
  const first = await human.waitForFrame(FRAME_TIMEOUT_MS)

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
}

// --- the approval interrupt ------------------------------------------------

/** Sign in the way the agent would if it had been given the secret. */
async function signInWithTheSecret(page: Page, app: Target): Promise<void> {
  await walkToWall(page, app)
  await page.fill('[data-testid="totp-code"]', totp(app.totpSecret))
  await page.click('[data-testid="totp-submit"]')
  const arrived = await reachedAccount(page, app.user, SETTLE_TIMEOUT_MS)
  if (!arrived) throw new Error("the approval arm never got signed in")
}

/** Open the transfer form and fill it, stopping short of the submit button. */
async function fillTransfer(page: Page, amount: string, payee: string) {
  await page.click('[data-testid="transfer-link"]')
  await page.waitForSelector('[data-testid="transfer-submit"]', {
    timeout: 30_000,
  })
  await page.fill('[data-testid="transfer-amount"]', amount)
  await page.fill('[data-testid="transfer-payee"]', payee)
}

// --- one handoff -----------------------------------------------------------

interface HandoffRecord {
  outcome: string | null
  event: HandoffEvent | null
  stuckToVisibleMs: number | null
  humanActiveMs: number | null
  framesAtHuman: number | null
  relaySandboxSeconds: number | null
  error: string | null
}

/**
 * Raise the hand, run `script` as the human, and always let the handoff settle.
 *
 * Settling is what destroys the relay sandbox and frees the single slot the
 * next run needs, so it happens on the error path too.
 */
async function withHandoff(
  page: Page,
  options: Parameters<typeof raiseHand>[1],
  script: (human: SimulatedHuman, record: HandoffRecord) => Promise<void>,
): Promise<HandoffRecord> {
  const record: HandoffRecord = {
    outcome: null,
    event: null,
    stuckToVisibleMs: null,
    humanActiveMs: null,
    framesAtHuman: null,
    relaySandboxSeconds: null,
    error: null,
  }

  let announce: (url: string) => void = () => undefined
  let refuse: (error: Error) => void = () => undefined
  const urlReady = new Promise<string>((resolve, reject) => {
    announce = resolve
    refuse = reject
  })

  const raisedAt = Date.now()
  const handoff = raiseHand(page, {
    ...options,
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

  let human: SimulatedHuman | null = null
  try {
    human = await openHandoffPage(await urlReady)
    await human.waitForFrame(FRAME_TIMEOUT_MS)
    const firstFrameAt = human.firstFrameAt() ?? Date.now()
    record.stuckToVisibleMs = firstFrameAt - raisedAt
    await script(human, record)
    record.humanActiveMs = record.humanActiveMs ?? Date.now() - firstFrameAt
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error)
    // The script gave up, so say so on the wire instead of holding the relay
    // sandbox for the rest of the timeout. A takeover settles as `aborted`; an
    // approval ignores the message by design and still runs out the clock.
    await human?.abort().catch(() => undefined)
  }

  const result = await handoff.catch((error: Error) => {
    record.error = record.error ?? error.message
    return null
  })
  // Only when a relay actually came up: a handoff that never got one (the plan
  // was full) burned wall clock, but it did not burn a sandbox.
  record.relaySandboxSeconds =
    record.event === null ? null : (Date.now() - raisedAt) / 1000
  record.outcome = result?.outcome ?? "throw"
  record.framesAtHuman = human?.frameCount() ?? null
  await human?.close().catch(() => undefined)
  return record
}

// --- one run ---------------------------------------------------------------

/** Deterministic, so a rerun asks for the same money as the run before it. */
function transferFor(index: number) {
  return { amount: `${12_000 + index}.00`, payee: "Acme GmbH" }
}

async function runTakeover(
  page: Page,
  app: Target,
  run: MixedRun,
): Promise<void> {
  const walkAt = Date.now()
  await walkToWall(page, app)
  run.reachedInterrupt = true
  run.reachedInterruptMs = Date.now() - walkAt

  const handoff = await withHandoff(
    page,
    { reason: "Aurora Bank is asking for a 2FA code" },
    (human) => humanSolvesTheWall(page, human, app.totpSecret),
  )
  applyHandoff(run, handoff)

  const arrived = await reachedAccount(page, app.user, SETTLE_TIMEOUT_MS)
  run.completed = arrived && handoff.outcome === "resolved"
}

async function runApproval(
  page: Page,
  app: Target,
  run: MixedRun,
  decision: Decision,
): Promise<void> {
  const walkAt = Date.now()
  await signInWithTheSecret(page, app)
  const { amount, payee } = transferFor(run.index)
  await fillTransfer(page, amount, payee)
  run.reachedInterrupt = true
  run.reachedInterruptMs = Date.now() - walkAt
  run.decision = decision

  const action = `Transfer EUR ${amount} to ${payee}`
  const handoff = await withHandoff(
    page,
    {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action,
    },
    async (human, record) => {
      const firstFrameAt = human.firstFrameAt() ?? Date.now()
      // If the phone were shown a different step than the one the agent is
      // about to take, the whole mode would be a lie. Cheap to check here.
      if (human.action() !== action) {
        throw new Error(`the phone showed "${human.action()}", not the action`)
      }
      if (decision === "approve") await human.approve()
      else await human.deny()
      record.humanActiveMs = Date.now() - firstFrameAt
    },
  )
  applyHandoff(run, handoff)

  // The agent, not the human, carries the decision out: an approval injects
  // nothing into the page, so the transfer only happens if the agent submits.
  if (handoff.outcome === "approved") {
    await page.click('[data-testid="transfer-submit"]')
    run.completed = await transferWasSent(page, SETTLE_TIMEOUT_MS)
  } else if (handoff.outcome === "denied") {
    // A denied approval is a completed workflow: the decision was delivered and
    // obeyed. What must be true is that no money moved.
    run.completed = !(await transferWasSent(page, 1_000))
  }
}

function applyHandoff(run: MixedRun, handoff: HandoffRecord): void {
  run.handoffOutcome = handoff.outcome
  run.stuckToVisibleMs = handoff.stuckToVisibleMs
  run.handoffDurationMs = handoff.event?.durationMs ?? null
  run.relayColdStartMs = handoff.event?.relayColdStartMs ?? null
  run.framesSent = handoff.event?.framesSent ?? null
  run.framesAtHuman = handoff.framesAtHuman
  run.bytesSent = handoff.event?.bytesSent ?? null
  run.inputsApplied = handoff.event?.inputsApplied ?? null
  run.humanActiveMs = handoff.humanActiveMs
  run.relaySandboxSeconds = handoff.relaySandboxSeconds
  run.error = handoff.error
}

async function runWorkflow(
  index: number,
  kind: Kind,
  decision: Decision,
  lease: BrowserLease,
  app: Target,
): Promise<MixedRun> {
  const run: MixedRun = {
    index,
    kind,
    startedAt: new Date().toISOString(),
    completed: false,
    reachedInterrupt: false,
    reachedInterruptMs: null,
    decision: null,
    handoffOutcome: null,
    stuckToVisibleMs: null,
    handoffDurationMs: null,
    relayColdStartMs: null,
    framesSent: null,
    framesAtHuman: null,
    bytesSent: null,
    inputsApplied: null,
    humanActiveMs: null,
    relaySandboxSeconds: null,
    error: null,
    browserAgeMs: Date.now() - lease.launchedAt,
  }

  const page = await freshPage(lease)
  try {
    if (kind === "takeover") await runTakeover(page, app, run)
    else await runApproval(page, app, run, decision)
  } catch (error) {
    run.error =
      run.error ?? (error instanceof Error ? error.message : String(error))
  } finally {
    await page.close().catch(() => undefined)
  }

  if (FAULT === "invert-completed") run.completed = !run.completed
  return run
}

// --- statistics ------------------------------------------------------------

/** Nearest-rank percentile: sort, then take index ceil(p * n) - 1. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil(p * sorted.length) - 1
  const index = Math.min(sorted.length - 1, Math.max(0, rank))
  return sorted[index] ?? Number.NaN
}

interface Stat {
  n: number
  p50: number
  p75: number
  worst: number
  total: number
}

function stat(values: number[]): Stat | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    worst: percentile(sorted, 1),
    total: Number(values.reduce((sum, value) => sum + value, 0).toFixed(3)),
  }
}

interface ModeSummary {
  mode: Kind
  label: string
  attempted: number
  completed: number
  /** Approval mode only: how the answers split. Denials count as completed. */
  approved: number | null
  denied: number | null
  /** Runs that never reached the interrupt: infrastructure, not the claim. */
  neverReachedInterrupt: number
  stuckToVisibleMs: Stat | null
  handoffDurationMs: Stat | null
  relayColdStartMs: Stat | null
  humanActiveMs: Stat | null
  framesSent: Stat | null
  bytesSent: Stat | null
  inputsApplied: Stat | null
  relaySandboxSeconds: Stat | null
}

function isNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

function summarise(mode: Kind, label: string, runs: MixedRun[]): ModeSummary {
  const mine = runs.filter((run) => run.kind === mode)
  const done = mine.filter((run) => run.completed)
  const of = (pick: (run: MixedRun) => number | null): Stat | null =>
    stat(done.map(pick).filter(isNumber))
  return {
    mode,
    label,
    attempted: mine.length,
    completed: done.length,
    approved:
      mode === "approval"
        ? mine.filter((run) => run.decision === "approve").length
        : null,
    denied:
      mode === "approval"
        ? mine.filter((run) => run.decision === "deny").length
        : null,
    neverReachedInterrupt: mine.filter((run) => !run.reachedInterrupt).length,
    stuckToVisibleMs: of((run) => run.stuckToVisibleMs),
    handoffDurationMs: of((run) => run.handoffDurationMs),
    relayColdStartMs: of((run) => run.relayColdStartMs),
    humanActiveMs: of((run) => run.humanActiveMs),
    framesSent: of((run) => run.framesSent),
    bytesSent: of((run) => run.bytesSent),
    inputsApplied: of((run) => run.inputsApplied),
    relaySandboxSeconds: of((run) => run.relaySandboxSeconds),
  }
}

function ms(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value)}`
}

function kb(value: number | undefined): string {
  return value === undefined ? "—" : `${(value / 1024).toFixed(1)}`
}

function seconds(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(1)
}

function printTable(summaries: ModeSummary[]): void {
  const header = [
    "",
    "completed",
    "visible p50",
    "handoff p50",
    "frames p50",
    "KB p50",
    "inputs p50",
    "relay s p50",
  ]
  const rows = summaries.map((summary) => [
    summary.label,
    `${summary.completed}/${summary.attempted}`,
    ms(summary.stuckToVisibleMs?.p50),
    ms(summary.handoffDurationMs?.p50),
    ms(summary.framesSent?.p50),
    kb(summary.bytesSent?.p50),
    ms(summary.inputsApplied?.p50),
    seconds(summary.relaySandboxSeconds?.p50),
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
const runs: MixedRun[] = []
let relaunches = 0
let consecutiveFailures = 0
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
  let approvals = 0
  for (let index = 1; index <= N && abortReason === null; index += 1) {
    const kind: Kind = index % 2 === 1 ? "takeover" : "approval"
    if (kind === "approval") approvals += 1
    const decision: Decision =
      kind === "approval" && approvals % DENY_EVERY === 0 ? "deny" : "approve"

    if (leaseIsStale(lease)) {
      await releaseBrowser(lease)
      lease = await leaseBrowser()
      relaunches += 1
      console.log(
        JSON.stringify({ event: "browser_relaunched", before: index }),
      )
    }

    const run = await runWorkflow(index, kind, decision, lease, app)
    runs.push(run)
    console.log(
      JSON.stringify({
        event: "mixed_run",
        index,
        kind,
        decision: run.decision,
        completed: run.completed,
        reachedInterrupt: run.reachedInterrupt,
        handoffOutcome: run.handoffOutcome,
        stuckToVisibleMs: run.stuckToVisibleMs,
        handoffDurationMs: run.handoffDurationMs,
        framesSent: run.framesSent,
        bytesSent: run.bytesSent,
        inputsApplied: run.inputsApplied,
        relaySandboxSeconds: run.relaySandboxSeconds,
        error: run.error,
      }),
    )

    // A dead session poisons every later run, so replace it now rather than
    // after N-1 more failures.
    if (run.handoffOutcome === "disconnected" || !lease.browser.isConnected()) {
      await releaseBrowser(lease)
      lease = await leaseBrowser()
      relaunches += 1
      console.log(JSON.stringify({ event: "browser_relaunched", after: index }))
    }

    consecutiveFailures = run.completed ? 0 : consecutiveFailures + 1
    if (consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
      abortReason = `${ABORT_AFTER_CONSECUTIVE_FAILURES} workflows failed in a row — the infrastructure is down, not the claim`
      console.log(
        JSON.stringify({ event: "mixed_aborted", reason: abortReason }),
      )
      break
    }

    await Bun.sleep(COOLDOWN_MS)
  }
} finally {
  await releaseBrowser(lease)
  await app.kill().catch(() => undefined)
}

const summaries = [
  summarise("takeover", "takeover — the human drives", runs),
  summarise("approval", "approval — the human decides", runs),
]
const failures = runs.filter((run) => !run.completed)
/** Every run, failures included — the per-mode stats below count only the
 * runs that completed, so these two totals are deliberately different. */
const relaySeconds = stat(
  runs.map((run) => run.relaySandboxSeconds).filter(isNumber),
)

await Bun.write(
  RESULTS_PATH,
  `${JSON.stringify(
    {
      meta: {
        date: new Date().toISOString(),
        requestedN: N,
        workload:
          "N workflows against one Aurora Bank instance, interleaved takeover, approval, takeover, …",
        interrupts: {
          takeover:
            "a real RFC 6238 TOTP wall the agent cannot pass; a scripted human types the code and hands back",
          approval:
            "a filled transfer form the agent may not submit alone; a scripted human answers yes or no",
        },
        claim:
          "on this workload, each mode's cost per handoff and how many workflows completed",
        notAClaim:
          "the 50/50 mix is this harness's choice, not a measurement of any fleet's traffic; multiply the per-mode costs by your own mix",
        deniedCountAsCompleted:
          "yes — a denied approval delivered a decision the agent obeyed, and the bench asserts no transfer was sent",
        approvalSetup:
          "the approval arm signs itself in with the shared secret; that sign-in is setup, and the interrupt under measurement is the transfer",
        denyEvery: DENY_EVERY,
        interleaved: true,
        fault: FAULT === "" ? null : FAULT,
        abortReason,
        browserRelaunches: relaunches,
        totalMs: Date.now() - benchStartedAt,
        relaySandboxSecondsAllRuns: relaySeconds?.total ?? null,
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
    event: "mixed_done",
    workflows: runs.length,
    completed: runs.filter((run) => run.completed).length,
    takeoverCompleted: `${summaries[0]?.completed}/${summaries[0]?.attempted}`,
    approvalCompleted: `${summaries[1]?.completed}/${summaries[1]?.attempted}`,
    relaySandboxSecondsAllRuns: relaySeconds?.total ?? null,
    browserRelaunches: relaunches,
    totalMs: Date.now() - benchStartedAt,
    results: RESULTS_PATH.pathname,
  }),
)
for (const failure of failures) {
  console.log(
    JSON.stringify({
      event: "mixed_failure",
      index: failure.index,
      kind: failure.kind,
      decision: failure.decision,
      reachedInterrupt: failure.reachedInterrupt,
      handoffOutcome: failure.handoffOutcome,
      error: failure.error,
      browserAgeMs: failure.browserAgeMs,
    }),
  )
}
