/**
 * List every live Solari sandbox, and with `--kill` destroy them.
 *
 *   bun --env-file=.env scripts/cleanup-sandboxes.ts          # list only
 *   bun --env-file=.env scripts/cleanup-sandboxes.ts --kill   # list and kill
 *
 * The plan the benchmarks run on allows two concurrent sandboxes, so one stray
 * sandbox is the difference between a benchmark that runs and a 429. Run this
 * before and after any e2e or benchmark run.
 *
 * `sandboxes.listAll()` yields objects keyed `sandboxId`, not `id` — the trap
 * documented in docs/measurements/01-preview-transport.md §5.
 */
import { SolariClient } from "@solarisdk/sdk"

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("SOLARI_API_KEY is not set")
  process.exit(1)
}

const solari = new SolariClient({ apiKey })
const kill = process.argv.includes("--kill")

/** States a sandbox can still be killed from; the rest are already terminal. */
const KILLABLE = new Set(["starting", "running", "paused"])

for await (const sandbox of solari.sandboxes.listAll()) {
  console.log(JSON.stringify(sandbox).slice(0, 300))
  if (!kill || !KILLABLE.has(sandbox.state)) continue
  try {
    await solari.sandboxes.kill(sandbox.sandboxId)
    console.log("  -> killed")
  } catch (error) {
    console.log("  -> kill failed:", String(error).slice(0, 120))
  }
}
