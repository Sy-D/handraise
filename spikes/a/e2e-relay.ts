/**
 * A-agent end-to-end proof for the relay subsystem, against the real API.
 *
 *   bun --env-file=.env spikes/a/e2e-relay.ts
 *
 * Proves, in this order: startRelay() cold start, /healthz through the public
 * preview URL, an agent -> human WebSocket round trip through the preview proxy
 * (both hops carrying ?pt_token=, because a non-browser client keeps no cookie),
 * late-join replay, and an idempotent kill() that really releases the sandbox.
 */
import WebSocket from "ws"

import { startRelay } from "../../src/relay/deploy"

const results: Record<string, unknown> = {}
const started = Date.now()
const since = () => Date.now() - started

function wsUrl(httpsUrl: string, role: "agent" | "human"): string {
  const url = new URL(httpsUrl)
  url.pathname = "/ws"
  url.searchParams.set("role", role)
  return url.toString().replace(/^https:/, "wss:")
}

function open(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
    socket.once("unexpected-response", (_req, res) =>
      reject(new Error(`upgrade rejected: ${res.statusCode}`)),
    )
  })
}

function once(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message within 10s")), 10_000)
    socket.once("message", (raw: Buffer) => {
      clearTimeout(timer)
      resolve(raw.toString("utf8"))
    })
  })
}

const t0 = Date.now()
const relay = await startRelay({ apiKey: process.env.SOLARI_API_KEY ?? "", timeoutMs: 5 * 60_000 })
results.coldStartMs = Date.now() - t0
console.log(since(), "relay up", relay.humanUrl.replace(/pt_token=[^&]+/, "pt_token=…"))

try {
  // The trap, demonstrated: new URL(path, previewUrl) drops ?pt_token= -> 401.
  const tokenless = await fetch(new URL("/healthz", relay.humanUrl).toString())
  results.healthWithoutToken = tokenless.status

  const tHealth = Date.now()
  const healthUrl = new URL(relay.humanUrl)
  healthUrl.pathname = "/healthz"
  const authed = await fetch(healthUrl.toString())
  results.health = { status: authed.status, body: await authed.text(), ms: Date.now() - tHealth }

  const pageResponse = await fetch(relay.humanUrl)
  const page = await pageResponse.text()
  results.page = {
    status: pageResponse.status,
    bytes: page.length,
    hasKeyboardHint: page.includes("Typing goes straight to the browser"),
  }

  const agent = await open(relay.agentWsUrl)
  console.log(since(), "agent socket open")

  // Buffer a state + frame with nobody listening, then join late as the human.
  agent.send(JSON.stringify({ type: "state", reason: "GitHub is asking for a 2FA code" }))
  agent.send(
    JSON.stringify({
      type: "frame",
      data: "Zmxlc2gtd291bmQ=",
      meta: {
        deviceWidth: 1280,
        deviceHeight: 800,
        jpegWidth: 800,
        jpegHeight: 500,
        pageScaleFactor: 1,
      },
    }),
  )

  const human = await open(wsUrl(relay.humanUrl, "human"))
  console.log(since(), "human socket open")
  results.lateJoin = [await once(human), (await once(human)).slice(0, 60)]

  const tPing = Date.now()
  agent.send(JSON.stringify({ type: "ping" }))
  results.pong = { message: await once(agent), rttMs: Date.now() - tPing }

  const tRound = Date.now()
  agent.send(JSON.stringify({ type: "state", reason: "live round trip" }))
  results.agentToHuman = { message: await once(human), ms: Date.now() - tRound }

  const tBack = Date.now()
  human.send(JSON.stringify({ type: "tap", fx: 412, fy: 233 }))
  results.humanToAgent = { message: await once(agent), ms: Date.now() - tBack }

  agent.close()
  human.close()
} finally {
  const tKill = Date.now()
  await relay.kill()
  await relay.kill() // idempotent: the second call must not throw
  results.killMs = Date.now() - tKill
}

const gone = new URL(relay.humanUrl)
gone.pathname = "/healthz"
try {
  const after = await fetch(gone.toString())
  results.afterKill = after.status
} catch (error) {
  results.afterKill = String(error)
}

console.log(JSON.stringify(results, null, 2))
