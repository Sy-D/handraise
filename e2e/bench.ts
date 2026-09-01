/**
 * The latency bench: what does a handoff actually cost, measured?
 *
 *   bun --env-file=.env e2e/bench.ts        # N=30
 *   BENCH_N=5 bun --env-file=.env e2e/bench.ts
 *
 * N real handoffs against the real Solari API, run one at a time, with a
 * scripted human on the other end. Every number below comes from a wire event
 * or a wall clock in this process — nothing is modelled, extrapolated or
 * averaged over a synthetic load.
 *
 * The five metrics, and why each one exists:
 *
 *   relayColdStartMs   Sandbox create → public URL answering. The floor under
 *                      every handoff; handraise cannot be faster than this.
 *   stuckToVisibleMs   `raiseHand()` → the first frame arriving AT THE HUMAN.
 *                      The honest end-to-end number, measured on the human's
 *                      socket, not on the agent's.
 *   firstFrameMs       The same first frame, timed agent-side by the library.
 *                      Its gap to stuckToVisibleMs is the relay + network leg.
 *   inputRttMs         Human → relay → human round trip (`ping`/`pong`). What
 *                      a tap costs before the browser is even involved.
 *   handoffDurationMs  How long the whole handoff was live. With a scripted
 *                      human this is the machine floor, not a human's pace.
 *
 * Design notes that are load-bearing, not decoration:
 *
 * - ONE browser session is reused across runs and relaunched proactively after
 *   4 minutes. Solari browser sessions die hard about 10 minutes after
 *   creation, one measured at 319 s (spikes/s4-report.md), and the sessions API
 *   still calls the corpse "active" — so age, `isConnected()` and a
 *   `disconnected` outcome are the three relaunch triggers.
 * - The target page animates. Chromium emits screencast frames only on repaint
 *   (spikes/s2-report.md); a static page would make firstFrame unmeasurable.
 * - One sandbox at a time (the relay). Check with
 *   `bun --env-file=.env spikes/s1/cleanup.ts` before and after.
 * - A failed run is recorded and the bench continues. Percentiles are over the
 *   successes; the failure rate is reported separately, because for p99 honesty
 *   a run that never finished is worse than a slow one.
 *
 * The human here is scripted rather than `openHandoffPage()` from human-sim.ts
 * for one reason: the relay keeps at most one socket per role, and measuring
 * `ping`/`pong` needs the same socket that receives the frames. It speaks the
 * identical wire protocol and reuses human-sim's `humanWebSocketUrl()`, which
 * is where the query-string trap lives.
 */
import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright-core"
import WebSocket from "ws"

import type { HandoffEvent } from "../src/events"
import { raiseHand } from "../src/index"
import type { AgentToHuman } from "../src/relay/protocol"
import { humanWebSocketUrl } from "./human-sim"

const N = Number(process.env.BENCH_N ?? "30")
const VIEWPORT = { width: 1280, height: 800 }
/** Per-handoff wait budget. Generous: a run that hits it is a failure, not a datum. */
const HANDOFF_TIMEOUT_MS = 60_000
/** How long the human waits for its first frame before calling the run dead. */
const FRAME_TIMEOUT_MS = 30_000
/** How long a `ping` may go unanswered before the sample is abandoned. */
const PONG_TIMEOUT_MS = 10_000
/** Ping samples per run, pooled across runs into one inputRttMs distribution. */
const RTT_SAMPLES = 5
/** Relaunch the browser at this age — comfortably under the ~10 min hard death. */
const BROWSER_MAX_AGE_MS = 4 * 60_000
/** Breather between runs so a just-killed relay sandbox is off the books. */
const COOLDOWN_MS = 1_500
const RESULTS_PATH = new URL("../spikes/bench-results.json", import.meta.url)

const apiKey = process.env.SOLARI_API_KEY ?? ""
if (apiKey === "") {
  throw new Error("SOLARI_API_KEY missing — run with --env-file=.env")
}

/**
 * A page that repaints forever. The counter forces layout and paint every
 * 100 ms and the bar animates continuously, so Chromium has a reason to emit
 * screencast frames from the moment the cast starts.
 */
const TARGET_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>handraise bench</title>
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center;
         background: #08090b; color: #e7e9ec;
         font: 600 48px -apple-system, system-ui, sans-serif; }
  .bar { width: 240px; height: 240px; margin-top: 24px; border-radius: 24px;
         background: linear-gradient(120deg, #34d399, #2563eb);
         animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg) scale(1.1); } }
</style></head>
<body><div><div id="n">0</div><div class="bar"></div></div>
<script>
  var n = 0
  setInterval(function () {
    n += 1
    document.getElementById("n").textContent = String(n)
  }, 100)
</script></body></html>`

// --- the scripted human ----------------------------------------------------

type RelayInbound = AgentToHuman | { type: "pong" }

function parseRelay(raw: string): RelayInbound | null {
  try {
    // SAFETY: the only writers on this socket are handraise's agent side and
    // the relay's own pong; the relay forwards payloads verbatim. Anything
    // unrecognised falls through the checks below without being acted on.
    return JSON.parse(raw) as RelayInbound
  } catch {
    return null
  }
}

interface BenchHuman {
  /** Wall-clock time the first frame arrived here, in ms since the epoch. */
  waitForFrame(): Promise<number>
  /** One `ping` → `pong` round trip over the relay, in ms. */
  ping(): Promise<number>
  handback(): Promise<void>
  close(): Promise<void>
}

function openBenchHuman(humanUrl: string): Promise<BenchHuman> {
  const socket = new WebSocket(humanWebSocketUrl(humanUrl))
  let firstFrameAt: number | null = null
  const frameWaiters: ((at: number) => void)[] = []
  const pongWaiters: ((at: number) => void)[] = []

  socket.on("message", (data: Buffer) => {
    const message = parseRelay(data.toString("utf8"))
    if (!message) return
    if (message.type === "pong") {
      pongWaiters.shift()?.(Date.now())
      return
    }
    if (message.type !== "frame" || firstFrameAt !== null) return
    firstFrameAt = Date.now()
    const at = firstFrameAt
    while (frameWaiters.length > 0) frameWaiters.pop()?.(at)
  })

  const send = (message: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      socket.send(message, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })

  const human: BenchHuman = {
    waitForFrame: () =>
      new Promise<number>((resolve, reject) => {
        if (firstFrameAt !== null) {
          resolve(firstFrameAt)
          return
        }
        const timer = setTimeout(
          () =>
            reject(
              new Error(`no frame reached the human in ${FRAME_TIMEOUT_MS}ms`),
            ),
          FRAME_TIMEOUT_MS,
        )
        frameWaiters.push((at) => {
          clearTimeout(timer)
          resolve(at)
        })
      }),

    ping: () =>
      new Promise<number>((resolve, reject) => {
        const sentAt = Date.now()
        const timer = setTimeout(
          () => reject(new Error(`no pong in ${PONG_TIMEOUT_MS}ms`)),
          PONG_TIMEOUT_MS,
        )
        pongWaiters.push((at) => {
          clearTimeout(timer)
          resolve(at - sentAt)
        })
        socket.send(JSON.stringify({ type: "ping" }))
      }),

    handback: () => send(JSON.stringify({ type: "handback" })),

    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        const giveUp = setTimeout(() => {
          socket.terminate()
          resolve()
        }, 2_000)
        socket.once("close", () => {
          clearTimeout(giveUp)
          resolve()
        })
        socket.close()
      }),
  }

  return new Promise<BenchHuman>((resolve, reject) => {
    socket.once("open", () => resolve(human))
    socket.once("error", reject)
  })
}

// --- the browser lease -----------------------------------------------------

type SolariBrowser = Awaited<ReturnType<Solari["launch"]>>

interface BrowserLease {
  solari: Solari
  browser: SolariBrowser
  page: Page
  launchedAt: number
}

async function leaseBrowser(): Promise<BrowserLease> {
  const solari = new Solari({ apiKey })
  const launchedAt = Date.now()
  const browser = await solari.launch({ stealth: true })
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const opened = context.pages()[0] ?? (await context.newPage())
  await opened.setViewportSize(VIEWPORT)
  // SAFETY: `@solarisdk/browser` returns patchright-core's Page. patchright is
  // a Playwright fork whose runtime surface is the one handraise uses, and the
  // e2e drives exactly this object; the two declarations differ only in
  // optional-property variance.
  const page = opened as Page
  await page.setContent(TARGET_PAGE, { waitUntil: "load" })
  return { solari, browser, page, launchedAt }
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

// --- one run ---------------------------------------------------------------

interface BenchRun {
  index: number
  /** True only when the human saw a frame and the handoff resolved. */
  ok: boolean
  outcome: string
  error: string | null
  startedAt: string
  /** `raiseHand()` → the handoff URL existing, agent-side. */
  urlReadyMs: number | null
  /** `raiseHand()` → the human's socket being open. */
  humanConnectedMs: number | null
  /** `raiseHand()` → the first frame arriving at the human. The headline number. */
  stuckToVisibleMs: number | null
  rttMs: number[]
  event: HandoffEvent | null
  /** Age of the reused browser session when the run started, in ms. */
  browserAgeMs: number
}

async function runOnce(index: number, lease: BrowserLease): Promise<BenchRun> {
  const run: BenchRun = {
    index,
    ok: false,
    outcome: "not-started",
    error: null,
    startedAt: new Date().toISOString(),
    urlReadyMs: null,
    humanConnectedMs: null,
    stuckToVisibleMs: null,
    rttMs: [],
    event: null,
    browserAgeMs: Date.now() - lease.launchedAt,
  }

  let announce: (url: string) => void = () => undefined
  let refuse: (error: Error) => void = () => undefined
  const urlReady = new Promise<string>((resolve, reject) => {
    announce = resolve
    refuse = reject
  })

  const raisedAt = Date.now()
  const handoff = raiseHand(lease.page, {
    reason: "bench",
    qr: false,
    timeoutMs: HANDOFF_TIMEOUT_MS,
    onUrl: (url) => announce(url),
    onEvent: (event) => {
      run.event = event
    },
  })
  // `raiseHand` throws only when the relay never came up. That rejection has to
  // reach `urlReady` too, or this run would hang on a promise nobody resolves.
  handoff.catch((error: Error) => refuse(error))

  let human: BenchHuman | null = null
  try {
    const humanUrl = await urlReady
    run.urlReadyMs = Date.now() - raisedAt

    human = await openBenchHuman(humanUrl)
    run.humanConnectedMs = Date.now() - raisedAt

    run.stuckToVisibleMs = (await human.waitForFrame()) - raisedAt

    for (let sample = 0; sample < RTT_SAMPLES; sample += 1) {
      run.rttMs.push(await human.ping())
    }

    await human.handback()
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error)
  }

  // Whatever happened above, the handoff has to settle: that is what destroys
  // the relay sandbox and frees the single slot the next run needs.
  const result = await handoff.catch((error: Error) => {
    run.error = run.error ?? error.message
    return null
  })
  await human?.close()

  run.outcome = result?.outcome ?? "throw"
  run.ok = run.outcome === "resolved" && run.stuckToVisibleMs !== null
  return run
}

// --- statistics ------------------------------------------------------------

interface Stat {
  metric: string
  n: number
  min: number
  p50: number
  p75: number
  p99: number
  max: number
}

/** Nearest-rank percentile: sort, then take index ceil(p * n) - 1. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil(p * sorted.length) - 1
  const index = Math.min(sorted.length - 1, Math.max(0, rank))
  return sorted[index] ?? Number.NaN
}

function summarise(metric: string, values: number[]): Stat {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    metric,
    n: sorted.length,
    min: percentile(sorted, 0),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p99: percentile(sorted, 0.99),
    max: percentile(sorted, 1),
  }
}

function isNumber(value: number | undefined | null): value is number {
  return value !== undefined && value !== null && Number.isFinite(value)
}

function collect(runs: BenchRun[]): Stat[] {
  const ok = runs.filter((run) => run.ok)
  return [
    summarise(
      "relayColdStartMs",
      ok.map((run) => run.event?.relayColdStartMs).filter(isNumber),
    ),
    summarise(
      "stuckToVisibleMs",
      ok.map((run) => run.stuckToVisibleMs).filter(isNumber),
    ),
    summarise(
      "firstFrameMs",
      ok.map((run) => run.event?.firstFrameMs).filter(isNumber),
    ),
    summarise(
      "inputRttMs",
      ok.flatMap((run) => run.rttMs),
    ),
    summarise(
      "handoffDurationMs",
      ok.map((run) => run.event?.durationMs).filter(isNumber),
    ),
  ]
}

function cell(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : "—"
}

function printTable(stats: Stat[]): void {
  const header = ["metric", "n", "min", "p50", "p75", "p99", "max"]
  const rows = stats.map((stat) => [
    stat.metric,
    String(stat.n),
    cell(stat.min),
    cell(stat.p50),
    cell(stat.p75),
    cell(stat.p99),
    cell(stat.max),
  ])
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((row) => (row[column] ?? "").length)),
  )
  const line = (cells: string[]): string =>
    cells
      .map((text, column) =>
        column === 0
          ? text.padEnd(widths[column] ?? 0)
          : text.padStart(widths[column] ?? 0),
      )
      .join("  ")

  console.log("")
  console.log(line(header))
  console.log(widths.map((width) => "-".repeat(width)).join("  "))
  for (const row of rows) console.log(line(row))
}

// --- the bench ------------------------------------------------------------

const runs: BenchRun[] = []
let lease = await leaseBrowser()
let relaunches = 0
const benchStartedAt = Date.now()

try {
  for (let index = 1; index <= N; index += 1) {
    if (leaseIsStale(lease)) {
      await releaseBrowser(lease)
      lease = await leaseBrowser()
      relaunches += 1
      console.log(
        JSON.stringify({ event: "browser_relaunched", before: index }),
      )
    }

    const run = await runOnce(index, lease)
    runs.push(run)
    console.log(
      JSON.stringify({
        event: "bench_run",
        index,
        ok: run.ok,
        outcome: run.outcome,
        stuckToVisibleMs: run.stuckToVisibleMs,
        relayColdStartMs: run.event?.relayColdStartMs ?? null,
        firstFrameMs: run.event?.firstFrameMs ?? null,
        rttMs: run.rttMs,
        error: run.error,
      }),
    )

    // A dead session poisons every later run, so replace it before the next one
    // rather than after N-1 more failures.
    if (run.outcome === "disconnected" || !lease.browser.isConnected()) {
      await releaseBrowser(lease)
      lease = await leaseBrowser()
      relaunches += 1
      console.log(JSON.stringify({ event: "browser_relaunched", after: index }))
    }

    const failureRate = runs.filter((entry) => !entry.ok).length / runs.length
    if (runs.length >= 5 && failureRate > 0.2) {
      console.log(
        JSON.stringify({
          event: "bench_aborted",
          reason: "failure rate above 20%",
          failureRate,
          completed: runs.length,
        }),
      )
      break
    }

    if (index < N) await Bun.sleep(COOLDOWN_MS)
  }
} finally {
  await releaseBrowser(lease)
}

const failures = runs.filter((run) => !run.ok)
const stats = collect(runs)

await Bun.write(
  RESULTS_PATH,
  `${JSON.stringify(
    {
      meta: {
        date: new Date().toISOString(),
        requestedN: N,
        completedN: runs.length,
        successes: runs.length - failures.length,
        failures: failures.length,
        failureRate: runs.length === 0 ? 0 : failures.length / runs.length,
        browserRelaunches: relaunches,
        totalMs: Date.now() - benchStartedAt,
        bunVersion: Bun.version,
        platform: `${process.platform}-${process.arch}`,
        measuredFrom: "Germany → default Solari endpoint (api.getsolari.com)",
        handoffTimeoutMs: HANDOFF_TIMEOUT_MS,
        rttSamplesPerRun: RTT_SAMPLES,
        viewport: VIEWPORT,
      },
      stats,
      runs,
    },
    null,
    2,
  )}\n`,
)

printTable(stats)
console.log("")
console.log(
  JSON.stringify({
    event: "bench_done",
    completedN: runs.length,
    successes: runs.length - failures.length,
    failures: failures.length,
    failureRatePct:
      runs.length === 0
        ? 0
        : Math.round((failures.length / runs.length) * 1000) / 10,
    browserRelaunches: relaunches,
    totalMs: Date.now() - benchStartedAt,
    results: RESULTS_PATH.pathname,
  }),
)
for (const failure of failures) {
  console.log(
    JSON.stringify({
      event: "bench_failure",
      index: failure.index,
      outcome: failure.outcome,
      error: failure.error,
      browserAgeMs: failure.browserAgeMs,
    }),
  )
}
