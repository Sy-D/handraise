/** List every live sandbox and kill it. Run: bun --env-file=.env spikes/s1/cleanup.ts */
import { SolariClient } from "@solarisdk/sdk"

const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
const kill = process.argv.includes("--kill")

for await (const s of pt.sandboxes.listAll()) {
  const v = s as unknown as Record<string, string>
  const id = v.id ?? v.sandboxId ?? v.sessionId
  console.log(JSON.stringify(s).slice(0, 300))
  if (kill && id && v.state !== "stopped" && v.state !== "killed") {
    try {
      await pt.sandboxes.kill(id)
      console.log("  -> killed")
    } catch (e) {
      console.log("  -> kill failed:", String(e).slice(0, 120))
    }
  }
}
