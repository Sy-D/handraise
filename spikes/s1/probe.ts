/**
 * S1 probe: what is in the `base` template, and does previewUrl work at all?
 * Run: bun --env-file=.env spikes/s1/probe.ts
 */
import { SolariClient } from "@solarisdk/sdk"

const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`
const log = (...a: unknown[]) => console.log(ts(), ...a)

const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })

let sandbox: Awaited<ReturnType<typeof pt.sandboxes.create>> | undefined
try {
  log("creating sandbox...")
  sandbox = await pt.sandboxes.create({ template: "base", timeoutMs: 5 * 60_000 })
  log("created", sandbox.id)
  await sandbox.connect()
  log("connected")

  const sh = async (script: string) => {
    const r = await sandbox!.commands.run("sh", { args: ["-c", script] })
    return { code: r.exitCode, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() }
  }

  log("tooling:", JSON.stringify(await sh(
    "for b in sh bash node npm npx bun python3 pip3 curl nc socat; do printf '%s=%s\\n' $b \"$(command -v $b || echo -)\"; done",
  ), null, 0))
  log("os:", JSON.stringify(await sh("cat /etc/os-release | head -3; uname -a; id")))
  log("python:", JSON.stringify(await sh("python3 -V; python3 -c 'import ssl,socket,hashlib,base64,http.server;print(\"stdlib ok\")'")))
  log("node:", JSON.stringify(await sh("node -v 2>/dev/null || echo none")))

  const p1 = await sandbox.previewUrl(3000)
  const p2 = await sandbox.previewUrl(3001)
  log("previewUrl(3000):", JSON.stringify(p1))
  log("previewUrl(3001):", JSON.stringify(p2))
} catch (e) {
  console.error("FAILED:", e)
} finally {
  if (sandbox) {
    await sandbox.kill().catch((e) => console.error("kill failed", e))
    log("killed")
  }
}
