/**
 * S1 follow-up:
 *  1. Does an authenticated preview request leave a session (cookie) so that
 *     tokenless sub-requests — a mobile page's own JS/CSS/fetch — still pass?
 *  2. What is the proxy's real idle timeout on a WebSocket with zero traffic?
 * Run: bun --env-file=.env spikes/s1/session-test.ts
 */
import { readFileSync } from "node:fs"
import { SolariClient } from "@solarisdk/sdk"
import WebSocket from "ws"

const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const at = (previewUrl: string, path: string) => {
  const u = new URL(previewUrl)
  u.pathname = path
  return u.toString()
}

const out: Record<string, unknown> = {}
const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
let sandbox: Awaited<ReturnType<typeof pt.sandboxes.create>> | undefined

try {
  // the plan allows 2 concurrent sandboxes; sibling spikes may hold both
  for (let i = 0; i < 40 && !sandbox; i++) {
    try {
      sandbox = await pt.sandboxes.create({ template: "base", timeoutMs: 10 * 60_000 })
    } catch (e) {
      if (!String(e).includes("Too many concurrent")) throw e
      log("429 concurrency, retrying in 15s")
      await sleep(15_000)
    }
  }
  if (!sandbox) throw new Error("could not acquire a sandbox slot")
  await sandbox.connect()
  await sandbox.files.write("/tmp/server.js", readFileSync(new URL("./server.js", import.meta.url), "utf8"))
  await sandbox.commands.run("sh", { args: ["-c", "nohup node /tmp/server.js 3000 >/tmp/s.log 2>&1 & sleep 0.3; echo up"] })
  const { url: preview } = await sandbox.previewUrl(3000)
  const host = new URL(preview).origin
  log("preview", host)
  for (let i = 0; i < 40 && !(await fetch(at(preview, "/ping")).then((r) => r.ok).catch(() => false)); i++) await sleep(250)

  // ---- 1. session propagation ----
  const authed = await fetch(at(preview, "/ping"), { redirect: "manual" })
  await authed.text()
  const setCookies = (authed.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ")
  log("set-cookie after authed request:", JSON.stringify(setCookies.map((c) => c.slice(0, 60))))

  const bare = await fetch(`${host}/ping`, { redirect: "manual" })
  const withCookies = await fetch(`${host}/ping`, { headers: cookieHeader ? { cookie: cookieHeader } : {}, redirect: "manual" })
  const withHeaderToken = await fetch(`${host}/ping`, {
    headers: { authorization: `Bearer ${new URL(preview).searchParams.get("pt_token")}` },
    redirect: "manual",
  })
  const withXHeader = await fetch(`${host}/ping`, {
    headers: { "x-pt-token": new URL(preview).searchParams.get("pt_token") ?? "" },
    redirect: "manual",
  })
  // does the token survive on a *different* path with the query kept?
  const otherPath = await fetch(at(preview, "/anything/deep/path"))
  out.session = {
    authedStatus: authed.status,
    setCookieNames: setCookies.map((c) => c.split("=")[0]),
    tokenlessSamePathStatus: bare.status,
    tokenlessWithProxyCookiesStatus: withCookies.status,
    bearerHeaderStatus: withHeaderToken.status,
    xPtTokenHeaderStatus: withXHeader.status,
    tokenOnOtherPathStatus: otherPath.status,
  }
  log("SESSION", JSON.stringify(out.session))

  // ---- 2. true idle WS timeout (no traffic in either direction) ----
  out.wsIdle = await new Promise((resolve) => {
    const url = at(preview, "/ws-quiet").replace(/^https:/, "wss:")
    const ws = new WebSocket(url)
    const opened = Date.now()
    let openedAt = 0
    ws.on("open", () => { openedAt = Date.now(); log("quiet ws open") })
    ws.on("close", (code, reason) =>
      resolve({ closedEarly: true, aliveMs: Date.now() - (openedAt || opened), code, reason: reason.toString() }))
    ws.on("error", (e) => resolve({ error: String(e), aliveMs: Date.now() - (openedAt || opened) }))
    setTimeout(() => {
      // still open after 4 min? then prove it still carries data
      let echoed = false
      ws.on("message", () => { echoed = true })
      try { ws.send("still-there") } catch {}
      setTimeout(() => {
        resolve({ closedEarly: false, aliveMs: Date.now() - (openedAt || opened), stillEchoesAfterIdle: echoed })
        try { ws.close() } catch {}
      }, 3000)
    }, 240_000)
  })
  log("WS-IDLE", JSON.stringify(out.wsIdle))
} catch (e) {
  console.error("ERROR:", e)
  out.fatal = String(e)
} finally {
  if (sandbox) await sandbox.kill().catch((e) => console.error("kill failed", e))
  console.log("\n===RESULTS_JSON===")
  console.log(JSON.stringify(out, null, 2))
}
