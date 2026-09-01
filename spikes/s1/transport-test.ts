/**
 * S1: Does *.preview.getsolari.com pass WebSocket / SSE / long-poll?
 * Run: bun --env-file=.env spikes/s1/transport-test.ts
 */
import { readFileSync } from "node:fs"
import { SolariClient } from "@solarisdk/sdk"
import WebSocket from "ws"

const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`
const log = (...a: unknown[]) => console.log(ts(), ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Put a path on the preview URL while keeping its ?pt_token= query. */
function at(previewUrl: string, path: string, extra?: Record<string, string>) {
  const u = new URL(previewUrl)
  u.pathname = path
  for (const [k, v] of Object.entries(extra ?? {})) u.searchParams.set(k, v)
  return u.toString()
}

const results: Record<string, unknown> = {}
const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
let sandbox: Awaited<ReturnType<typeof pt.sandboxes.create>> | undefined

try {
  // ---------- cold start ----------
  const tCreate = Date.now()
  sandbox = await pt.sandboxes.create({ template: "base", timeoutMs: 10 * 60_000 })
  const tCreated = Date.now()
  log("sandbox created", `${tCreated - tCreate}ms`)
  await sandbox.connect()
  const tConnected = Date.now()
  log("connected", `${tConnected - tCreated}ms`)

  const src = readFileSync(new URL("./server.js", import.meta.url), "utf8")
  await sandbox.files.write("/tmp/server.js", src)
  const tWritten = Date.now()
  log("server.js uploaded", `${tWritten - tConnected}ms`)

  await sandbox.commands.run("sh", {
    args: ["-c", "nohup node /tmp/server.js 3000 >/tmp/s3000.log 2>&1 & nohup node /tmp/server.js 3001 >/tmp/s3001.log 2>&1 & sleep 0.2; echo started"],
  })
  const tSpawned = Date.now()
  log("servers spawned", `${tSpawned - tWritten}ms`)

  const { url: preview, token } = await sandbox.previewUrl(3000)
  const { url: preview2 } = await sandbox.previewUrl(3001)
  const tPreview = Date.now()
  log("previewUrl resolved", `${tPreview - tSpawned}ms`)
  log("preview host:", new URL(preview).host, "token present:", Boolean(token))

  // poll until the preview URL answers
  let firstOk = 0
  let attempts = 0
  const statuses: number[] = []
  for (let i = 0; i < 60; i++) {
    attempts++
    try {
      const r = await fetch(at(preview, "/ping"), { headers: { "cache-control": "no-cache" } })
      statuses.push(r.status)
      await r.text()
      if (r.ok) { firstOk = Date.now(); break }
    } catch (e) {
      statuses.push(-1)
    }
    await sleep(250)
  }
  results.coldStart = {
    createMs: tCreated - tCreate,
    connectMs: tConnected - tCreated,
    uploadMs: tWritten - tConnected,
    spawnMs: tSpawned - tWritten,
    previewUrlMs: tPreview - tSpawned,
    untilFirst200Ms: firstOk ? firstOk - tCreate : null,
    pollAttempts: attempts,
    statusSequence: statuses.slice(0, 12),
  }
  log("COLD START", JSON.stringify(results.coldStart))
  if (!firstOk) throw new Error("preview URL never answered")

  // ---------- auth model ----------
  const noTok = await fetch(new URL("/ping", preview).toString(), { redirect: "manual" })
  const bodyNoTok = (await noTok.text()).slice(0, 120)
  const badTok = await fetch(at(preview, "/ping", { pt_token: "garbage" }), { redirect: "manual" })
  const cookieJar = `pt_token=${token}`
  const viaCookie = await fetch(new URL("/ping", preview).toString(), {
    headers: { cookie: cookieJar },
    redirect: "manual",
  })
  results.auth = {
    withoutToken: { status: noTok.status, body: bodyNoTok, setCookie: noTok.headers.get("set-cookie")?.slice(0, 80) ?? null },
    badToken: { status: badTok.status },
    tokenAsCookie: { status: viaCookie.status },
    tokenExp: token ? JSON.parse(Buffer.from(token.split(".")[0], "base64").toString()) : null,
  }
  log("AUTH", JSON.stringify(results.auth))

  // ---------- second port ----------
  try {
    const r2 = await fetch(at(preview2, "/ping"))
    results.secondPort = { status: r2.status, body: (await r2.text()).slice(0, 120) }
  } catch (e) {
    results.secondPort = { error: String(e) }
  }
  log("PORT 3001", JSON.stringify(results.secondPort))

  // ---------- HTTP polling ----------
  {
    const lat: number[] = []
    for (let i = 0; i < 15; i++) {
      const a = Date.now()
      const r = await fetch(at(preview, "/ping", { n: String(i) }), { headers: { "cache-control": "no-cache" } })
      const j = (await r.json()) as { echo: string }
      lat.push(Date.now() - a)
      if (j.echo !== String(i)) throw new Error(`polling echo mismatch: ${j.echo} != ${i}`)
    }
    results.polling = {
      ok: true,
      n: lat.length,
      medianMs: median(lat),
      minMs: Math.min(...lat),
      maxMs: Math.max(...lat),
      p90Ms: [...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.9)],
      all: lat,
    }
    log("POLLING", JSON.stringify(results.polling))
  }

  // ---------- SSE ----------
  results.sse = await (async () => {
    const started = Date.now()
    const ctrl = new AbortController()
    try {
      const r = await fetch(at(preview, "/sse"), {
        headers: { accept: "text/event-stream" },
        signal: ctrl.signal,
      })
      const ttfbHeaders = Date.now() - started
      if (!r.ok || !r.body) return { ok: false, status: r.status, contentType: r.headers.get("content-type") }
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      const arrivals: number[] = []
      let buf = ""
      let firstByteMs: number | null = null
      const deadline = Date.now() + 15_000
      while (arrivals.length < 8 && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        if (firstByteMs === null) firstByteMs = Date.now() - started
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (chunk.includes("event: tick")) arrivals.push(Date.now())
        }
      }
      ctrl.abort()
      const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i])
      return {
        ok: arrivals.length >= 3,
        status: r.status,
        contentType: r.headers.get("content-type"),
        transferEncoding: r.headers.get("transfer-encoding"),
        headersMs: ttfbHeaders,
        firstByteMs,
        events: arrivals.length,
        // server ticks every 250ms; ~250ms gaps == streamed, one big burst == buffered
        gapsMs: gaps,
        medianGapMs: gaps.length ? median(gaps) : null,
        streamedNotBuffered: gaps.length >= 2 && median(gaps) > 100,
      }
    } catch (e) {
      ctrl.abort()
      return { ok: false, error: String(e) }
    }
  })()
  log("SSE", JSON.stringify(results.sse))

  // ---------- SSE with big payloads ----------
  results.sseBig = await (async () => {
    const ctrl = new AbortController()
    const started = Date.now()
    try {
      const r = await fetch(at(preview, "/sse-big"), { headers: { accept: "text/event-stream" }, signal: ctrl.signal })
      if (!r.ok || !r.body) return { ok: false, status: r.status }
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      let n = 0
      let bytes = 0
      const deadline = Date.now() + 15_000
      while (n < 5 && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.length
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf("\n\n")) !== -1) { buf = buf_slice(buf, idx); n++ }
      }
      ctrl.abort()
      return { ok: n >= 3, events: n, bytes, elapsedMs: Date.now() - started }
    } catch (e) {
      ctrl.abort()
      return { ok: false, error: String(e) }
    }
    function buf_slice(b: string, idx: number) { return b.slice(idx + 2) }
  })()
  log("SSE-BIG", JSON.stringify(results.sseBig))

  // ---------- WebSocket ----------
  results.ws = await (async () => {
    const wsUrl = at(preview, "/ws").replace(/^https:/, "wss:")
    const out: Record<string, unknown> = { url: wsUrl.split("?")[0] }
    return await new Promise((resolve) => {
      const started = Date.now()
      const ws = new WebSocket(wsUrl)
      const rtts: number[] = []
      let phase: "small" | "big" | "done" = "small"
      let bigSentAt = 0
      const big = "A".repeat(100 * 1024)
      const timer = setTimeout(() => {
        out.ok = false
        out.error = "timeout after 20s"
        out.rtts = rtts
        try { ws.terminate() } catch {}
        resolve(out)
      }, 20_000)

      ws.on("unexpected-response", (_req, res) => {
        out.ok = false
        out.upgradeStatus = res.statusCode
        out.upgradeHeaders = Object.fromEntries(Object.entries(res.headers).slice(0, 8))
        let body = ""
        res.on("data", (c: Buffer) => { body += c.toString().slice(0, 300) })
        res.on("end", () => {
          out.upgradeBody = body.slice(0, 300)
          clearTimeout(timer)
          resolve(out)
        })
      })
      ws.on("error", (e) => {
        out.ok = out.ok ?? false
        out.error = out.error ?? String(e)
        clearTimeout(timer)
        resolve(out)
      })
      ws.on("open", () => {
        out.handshakeMs = Date.now() - started
        for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ ping: i, t: Date.now() }))
      })
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        const s = data.toString()
        if (phase === "small") {
          if (s.startsWith('{"push"')) { out.serverPushSeen = true; return }
          const m = JSON.parse(s) as { ping: number; t: number }
          rtts.push(Date.now() - m.t)
          if (rtts.length === 10) {
            phase = "big"
            bigSentAt = Date.now()
            ws.send(big)
          }
          return
        }
        if (phase === "big") {
          if (s.startsWith('{"push"')) { out.serverPushSeen = true; return }
          out.bigEchoBytes = data.length
          out.bigEchoOk = data.length === big.length && s[0] === "A"
          out.bigEchoRttMs = Date.now() - bigSentAt
          phase = "done"
          // wait a moment to confirm unsolicited server->client pushes arrive
          setTimeout(() => {
            out.ok = true
            out.echoRttMedianMs = median(rtts)
            out.echoRttMinMs = Math.min(...rtts)
            out.echoRttMaxMs = Math.max(...rtts)
            out.rtts = rtts
            clearTimeout(timer)
            try { ws.close() } catch {}
            resolve(out)
          }, 1500)
        }
      })
    })
  })()
  log("WS", JSON.stringify(results.ws))

  // ---------- WS idle: does the proxy cut an idle socket? ----------
  results.wsIdle = await (async () => {
    const wsUrl = at(preview, "/ws").replace(/^https:/, "wss:")
    return await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl)
      const opened = Date.now()
      let closed: number | null = null
      let pushes = 0
      ws.on("open", () => {})
      ws.on("message", (d: Buffer) => { if (d.toString().startsWith('{"push"')) pushes++ })
      ws.on("close", (code, reason) => {
        closed = Date.now()
        resolve({ survivedMs: closed - opened, code, reason: reason.toString(), serverPushes: pushes, closedEarly: true })
      })
      ws.on("error", (e) => resolve({ error: String(e), serverPushes: pushes }))
      setTimeout(() => {
        if (closed === null) {
          try { ws.close() } catch {}
          resolve({ survivedMs: Date.now() - opened, closedEarly: false, serverPushes: pushes })
        }
      }, 45_000)
    })
  })()
  log("WS-IDLE(45s)", JSON.stringify(results.wsIdle))

  const guestLog = await sandbox.commands.run("sh", { args: ["-c", "tail -5 /tmp/s3000.log; echo ---; tail -3 /tmp/s3001.log"] })
  results.guestLog = (guestLog.stdout ?? "").trim()
  log("guest log:", results.guestLog)
} catch (e) {
  console.error("SPIKE ERROR:", e)
  results.fatal = String(e)
} finally {
  if (sandbox) {
    await sandbox.kill().catch((e) => console.error("kill failed", e))
    log("sandbox killed")
  }
  console.log("\n===RESULTS_JSON===")
  console.log(JSON.stringify(results, null, 2))
}
