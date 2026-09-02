// Measures how long a Solari browser session lives and what GET /sessions/:id
// reports after it dies. Launches one browser, pings it every 30 s, waits for
// `disconnected`, then reads the status twice: immediately, and again at
// death + 5 min — past the documented ~3.5 min orphan grace.
//
//   bun --env-file=.env scripts/measure-session-lifetime.ts | tee /tmp/solari-repro.log
//
// Runs ~15 min on the current platform. Ctrl-C is safe; the session is released
// in `finally`. Findings: docs/measurements/04-browser-session-lifetime.md and
// https://github.com/solari-sdk/solari-cookbook/issues/25
import { Solari } from "@solarisdk/browser"

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) throw new Error("SOLARI_API_KEY is not set")

const solari = new Solari({ apiKey })
const t0 = Date.now()
const log = (m: string) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)

const status = async (id: string, label: string) => {
  const res = await solari.request("GET", `/sessions/${encodeURIComponent(id)}`)
  log(`${label} -> ${res.status} ${await res.text()}`)
}

const browser = await solari.launch()
const id = browser.id
log(`launched ${id} expiresAt=${browser.expiresAt}`)
await status(id, "status@t0")

const page = await browser.newPage()
const dead = new Promise<void>((r) => browser.raw.on("disconnected", () => r()))
const ping = setInterval(
  () =>
    void page.evaluate("1").then(
      () => log("ping ok"),
      (e: Error) => log(`ping FAILED: ${e.message}`),
    ),
  30_000,
)

try {
  await dead
  clearInterval(ping)
  log(`DISCONNECTED isConnected=${browser.isConnected()}`)
  await status(id, "status@death")
  await new Promise((r) => setTimeout(r, 5 * 60_000))
  await status(id, "status@death+5min")
} finally {
  clearInterval(ping)
  solari.sessions.release(id)
  await solari.close()
}
