/**
 * Render the measured numbers in README.md and benchmarks/README.md from the
 * raw benchmark JSON, so no figure in the docs can be typed by hand.
 *
 *   bun scripts/render-measured.ts          # rewrite the generated blocks
 *   bun scripts/render-measured.ts --check  # fail if a block is stale
 *
 * The benches in `e2e/` write `benchmarks/*.json`; this turns those files into
 * the tables and headline counts the docs show. Every block it owns is fenced
 * by `<!-- generated:NAME -->` … `<!-- /generated:NAME -->`; prose between the
 * blocks is written by hand and is not checked, so a claim that needs a number
 * belongs inside a block.
 *
 * The output is a pure function of the JSON, so a second run is byte-identical
 * to the first — that is what lets CI run it and then `git diff --exit-code`.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const README = fileURLToPath(new URL("../README.md", import.meta.url))
const BENCH_README = fileURLToPath(
  new URL("../benchmarks/README.md", import.meta.url),
)

interface LatencyStat {
  metric: string
  n: number
  p50: number
  p75: number
  max: number
}

interface LatencyReport {
  meta: { completedN: number; successes: number }
  stats: LatencyStat[]
}

interface RescueSummary {
  arm: string
  runs: number
  completed: number
  medianHandoffMs: number | null
}

interface RescueReport {
  summaries: RescueSummary[]
}

interface MixedMetric {
  p50: number
  p75: number
}

interface MixedSummary {
  mode: string
  label: string
  attempted: number
  completed: number
  stuckToVisibleMs: MixedMetric
  handoffDurationMs: MixedMetric
  framesSent: MixedMetric
  bytesSent: MixedMetric
  inputsApplied: MixedMetric
  relaySandboxSeconds: MixedMetric
}

interface MixedReport {
  summaries: MixedSummary[]
}

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
}

// SAFETY: these three files are written by e2e/bench.ts, e2e/rescue-bench.ts
// and e2e/mixed-bench.ts, which own the schema. Every field this script reads
// is fetched through `stat()`, `arm()` or `mode()` below, each of which throws
// on a missing entry — a renamed metric fails the run instead of rendering
// "undefined" into the README.
const latency = JSON.parse(
  read("../benchmarks/handoff-latency.json"),
) as LatencyReport
// SAFETY: as above — written by e2e/rescue-bench.ts, arms looked up by name.
const rescue = JSON.parse(
  read("../benchmarks/rescue-rate.json"),
) as RescueReport
// SAFETY: as above — written by e2e/mixed-bench.ts, modes looked up by name.
const mixed = JSON.parse(
  read("../benchmarks/mixed-workload.json"),
) as MixedReport

function stat(metric: string): LatencyStat {
  const found = latency.stats.find((entry) => entry.metric === metric)
  if (!found) {
    throw new Error(`handoff-latency.json has no stat "${metric}"`)
  }
  return found
}

function arm(name: string): RescueSummary {
  const found = rescue.summaries.find((entry) => entry.arm === name)
  if (!found) {
    throw new Error(`rescue-rate.json has no arm "${name}"`)
  }
  return found
}

function mode(name: string): MixedSummary {
  const found = mixed.summaries.find((entry) => entry.mode === name)
  if (!found) {
    throw new Error(`mixed-workload.json has no mode "${name}"`)
  }
  return found
}

/** 3532 → "3.5" — the README speaks in seconds, the JSON in milliseconds. */
function s(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/** 145104 → "142" — KB as the README writes it, 1024 bytes to the KB. */
function kb(bytes: number): string {
  return String(Math.round(bytes / 1024))
}

function readmeHeadline(): string {
  const rescued = arm("handraise")
  const baseline = arm("baseline")
  const visible = stat("stuckToVisibleMs")
  return [
    `- **${rescued.completed}/${rescued.runs} blocked workflows rescued** (baseline ${baseline.completed}/${baseline.runs}).`,
    `- **${latency.meta.successes}/${latency.meta.completedN} handoffs resolved** in the latency benchmark.`,
    `- **${s(visible.p50)} s median** from raise to live on the phone.`,
  ].join("\n")
}

function readmeLatencyTable(): string {
  const visible = stat("stuckToVisibleMs")
  const cold = stat("relayColdStartMs")
  const rtt = stat("inputRttMs")
  return [
    `| | p50 | p75 | worst of ${visible.n} |`,
    "|---|---|---|---|",
    `| Agent raises its hand → the phone shows the live page | ${s(visible.p50)}s | ${s(visible.p75)}s | ${s(visible.max)}s |`,
    `| — of which: relay sandbox cold start | ${s(cold.p50)}s | ${s(cold.p75)}s | ${s(cold.max)}s |`,
    `| Input round trip through the relay (${rtt.n} samples) | ${rtt.p50}ms | ${rtt.p75}ms | ${rtt.max}ms |`,
  ].join("\n")
}

function readmeRescueTable(): string {
  const baseline = arm("baseline")
  const rescued = arm("handraise")
  const median = rescued.medianHandoffMs
  return [
    "| | completed | median human time |",
    "|---|---|---|",
    `| baseline agent (no human available) | ${baseline.completed}/${baseline.runs} | — |`,
    `| with handraise | **${rescued.completed}/${rescued.runs}** | ${median === null ? "—" : `${s(median)}s`} |`,
  ].join("\n")
}

function readmeMixedRow(summary: MixedSummary): string {
  return `| ${summary.label} | ${summary.completed}/${summary.attempted} | ${summary.stuckToVisibleMs.p50}ms | ${summary.framesSent.p50} | ${kb(summary.bytesSent.p50)} KB | ${summary.relaySandboxSeconds.p50.toFixed(1)}s |`
}

function readmeMixedTable(): string {
  return [
    "| | completed | to visible | frames | bytes | relay sandbox |",
    "|---|---|---|---|---|---|",
    readmeMixedRow(mode("takeover")),
    readmeMixedRow(mode("approval")),
  ].join("\n")
}

function benchLatencyHeading(): string {
  return `## Handoff latency — ${latency.meta.completedN} handoffs, ${latency.meta.successes} resolved`
}

function benchLatencyRow(metric: string, description: string): string {
  const entry = stat(metric)
  return `| \`${metric}\` — ${description} | ${entry.p50} | ${entry.p75} | ${entry.max} |`
}

function benchLatencyTable(): string {
  return [
    "| Metric | p50 | p75 | worst |",
    "|---|---|---|---|",
    benchLatencyRow(
      "stuckToVisibleMs",
      "`raiseHand()` → first frame at the human",
    ),
    benchLatencyRow(
      "relayColdStartMs",
      "sandbox create → public URL answering",
    ),
    benchLatencyRow("firstFrameMs", "same frame, timed agent-side"),
    benchLatencyRow(
      "inputRttMs",
      `human → relay → human, ${stat("inputRttMs").n} samples`,
    ),
    benchLatencyRow("handoffDurationMs", "whole handoff live, scripted human"),
  ].join("\n")
}

function benchRescueHeading(): string {
  const rescued = arm("handraise")
  return `## Rescue rate — ${rescued.completed} of ${rescued.runs} blocked workflows completed`
}

function benchRescueTable(): string {
  const baseline = arm("baseline")
  const rescued = arm("handraise")
  const median = rescued.medianHandoffMs
  return [
    "| | completed | median handoff |",
    "|---|---|---|",
    `| baseline — no human, no access to the shared secret | ${baseline.completed}/${baseline.runs} | — |`,
    `| with handraise | **${rescued.completed}/${rescued.runs}** | ${median === null ? "—" : `${median} ms`} |`,
  ].join("\n")
}

function benchMixedHeading(): string {
  const attempted = mixed.summaries.reduce(
    (sum, entry) => sum + entry.attempted,
    0,
  )
  const completed = mixed.summaries.reduce(
    (sum, entry) => sum + entry.completed,
    0,
  )
  return `## Mixed workload — ${completed} of ${attempted} workflows completed, and what each mode cost`
}

function benchMixedRow(summary: MixedSummary): string {
  const visible = `${summary.stuckToVisibleMs.p50} / ${summary.stuckToVisibleMs.p75} ms`
  const handoff = `${summary.handoffDurationMs.p50} / ${summary.handoffDurationMs.p75} ms`
  return `| ${summary.mode} | ${summary.completed}/${summary.attempted} | ${visible} | ${handoff} | ${summary.framesSent.p50} | ${kb(summary.bytesSent.p50)} KB | ${summary.inputsApplied.p50} | ${summary.relaySandboxSeconds.p50.toFixed(1)} |`
}

function benchMixedTable(): string {
  return [
    "| | completed | time to visible p50 / p75 | handoff p50 / p75 | frames | bytes | inputs | relay-sandbox s |",
    "|---|---|---|---|---|---|---|---|",
    benchMixedRow(mode("takeover")),
    benchMixedRow(mode("approval")),
  ].join("\n")
}

const TARGETS: ReadonlyArray<{
  path: string
  blocks: ReadonlyArray<{ name: string; render: () => string }>
}> = [
  {
    path: README,
    blocks: [
      { name: "readme-headline", render: readmeHeadline },
      { name: "readme-latency", render: readmeLatencyTable },
      { name: "readme-rescue", render: readmeRescueTable },
      { name: "readme-mixed", render: readmeMixedTable },
    ],
  },
  {
    path: BENCH_README,
    blocks: [
      { name: "bench-latency-heading", render: benchLatencyHeading },
      { name: "bench-latency-table", render: benchLatencyTable },
      { name: "bench-rescue-heading", render: benchRescueHeading },
      { name: "bench-rescue-table", render: benchRescueTable },
      { name: "bench-mixed-heading", render: benchMixedHeading },
      { name: "bench-mixed-table", render: benchMixedTable },
    ],
  },
]

function replaceBlock(text: string, name: string, body: string): string {
  const open = `<!-- generated:${name} — bun scripts/render-measured.ts -->`
  const close = `<!-- /generated:${name} -->`
  const start = text.indexOf(open)
  const end = text.indexOf(close)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no "${name}" block to fill — expected ${open} … ${close}`)
  }
  if (text.indexOf(open, start + 1) !== -1) {
    throw new Error(`"${name}" block appears twice; block names must be unique`)
  }
  return `${text.slice(0, start + open.length)}\n${body}\n${text.slice(end)}`
}

const checkOnly = process.argv.includes("--check")
const stale: string[] = []
const written: string[] = []
for (const target of TARGETS) {
  const current = readFileSync(target.path, "utf8")
  let next = current
  for (const block of target.blocks) {
    next = replaceBlock(next, block.name, block.render())
  }
  if (next === current) {
    continue
  }
  if (checkOnly) {
    stale.push(target.path)
  } else {
    writeFileSync(target.path, next)
    written.push(target.path)
  }
}

if (stale.length > 0) {
  console.error(
    `measured numbers are stale — run: bun scripts/render-measured.ts\n  ${stale.join("\n  ")}`,
  )
  process.exit(1)
}
if (written.length > 0) {
  console.log(`rewrote measured numbers in:\n  ${written.join("\n  ")}`)
} else {
  console.log("measured numbers match benchmarks/*.json")
}
