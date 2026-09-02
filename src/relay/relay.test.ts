/**
 * Local tests for the in-guest relay. They run the real `guest/server.js` under
 * the real `node`, on a port the OS picks, and talk to it with the `ws` client —
 * no stubs, because the thing under test is wire behaviour.
 *
 *   bun test src/relay/
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { type ChildProcessByStdio, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { connect as netConnect, type Socket } from "node:net"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"
import type { HandoffMode } from "../types"
import { GUEST_SERVER_JS } from "./guest-source"
import {
  HEARTBEAT_INTERVAL_MS,
  RELAY_PORT,
  type RelayMessage,
} from "./protocol"

const SERVER_PATH = fileURLToPath(new URL("./guest/server.js", import.meta.url))
const MESSAGE_TIMEOUT_MS = 2000
const START_TIMEOUT_MS = 5000

const OP_TEXT = 0x1
const OP_CONTINUATION = 0x0
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

const META = {
  deviceWidth: 1280,
  deviceHeight: 800,
  jpegWidth: 800,
  jpegHeight: 500,
  pageScaleFactor: 1,
}

interface Relay {
  port: number
  process: ChildProcessByStdio<null, Readable, Readable>
}

interface Client {
  send(message: RelayMessage): void
  next(): Promise<RelayMessage>
  closed: Promise<number>
  socket: WebSocket
}

function parse(raw: string): RelayMessage {
  // SAFETY: every payload in this file is a RelayMessage produced by this file,
  // and the relay forwards bytes verbatim, so what comes back has that shape.
  return JSON.parse(raw) as RelayMessage
}

/** Processes spawned by an individual test; torn down in afterEach. */
const extraProcesses: ChildProcessByStdio<null, Readable, Readable>[] = []

/**
 * Start the real server on an OS-assigned port and read the port back out of
 * its log. `mode` is argv and not a message: what the human may send is fixed
 * when the relay boots, so it cannot be talked out of it afterwards.
 */
function startRelayProcess(
  agentKey?: string,
  mode?: HandoffMode,
): Promise<Relay> {
  const args = [SERVER_PATH, "0", agentKey ?? ""]
  if (mode) args.push(mode)
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (agentKey || mode) extraProcesses.push(child)
  return new Promise<Relay>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`relay did not start within ${START_TIMEOUT_MS}ms`))
    }, START_TIMEOUT_MS)

    let buffered = ""
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8")
      for (const line of buffered.split("\n")) {
        const match = /"event":"relay listening".*"port":(\d+)/.exec(line)
        if (!match?.[1]) continue
        clearTimeout(timer)
        resolve({ port: Number(match[1]), process: child })
        return
      }
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function connect(port: number, role: "agent" | "human"): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}`)
  const inbox: RelayMessage[] = []
  const waiters: ((message: RelayMessage) => void)[] = []

  socket.on("message", (raw: Buffer) => {
    const message = parse(raw.toString("utf8"))
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else inbox.push(message)
  })

  const closed = new Promise<number>((resolve) => {
    socket.once("close", (code: number) => resolve(code))
  })

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })

  return {
    socket,
    closed,
    send(message) {
      socket.send(JSON.stringify(message))
    },
    next() {
      const queued = inbox.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise<RelayMessage>((resolve, reject) => {
        const receive = (message: RelayMessage): void => {
          clearTimeout(timer)
          resolve(message)
        }
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(receive), 1)
          reject(
            new Error(
              `no message for role=${role} within ${MESSAGE_TIMEOUT_MS}ms`,
            ),
          )
        }, MESSAGE_TIMEOUT_MS)
        waiters.push(receive)
      })
    },
  }
}

let relay: Relay

beforeEach(async () => {
  relay = await startRelayProcess()
})

afterEach(() => {
  relay.process.kill("SIGKILL")
  while (extraProcesses.length > 0) extraProcesses.pop()?.kill("SIGKILL")
})

/** A masked client WebSocket frame, as an outside peer would put on the wire. */
function maskedFrame(opcode: number, fin: boolean, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const len = payload.length
  const b0 = (fin ? 0x80 : 0) | opcode
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([b0, 0x80 | len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = b0
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = b0
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: mask is a fixed 4-byte buffer.
    masked[i] = masked[i]! ^ mask[i % 4]!
  }
  return Buffer.concat([header, mask, masked])
}

/** Do a raw HTTP/1.1 WebSocket upgrade and hand back the socket + status line. */
function rawUpgrade(
  port: number,
  query: string,
  headers: Record<string, string> = {},
): Promise<{ socket: Socket; statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => {
      const key = randomBytes(16).toString("base64")
      const extra = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("")
      socket.write(
        `GET /ws?${query} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
          `${extra}\r\n`,
      )
    })
    socket.once("error", reject)
    socket.once("data", (chunk: Buffer) => {
      resolve({
        socket,
        statusLine: chunk.toString("utf8").split("\r\n")[0] ?? "",
      })
    })
  })
}

/** Open a `ws` client and resolve on open, reject on any refusal. */
function openWs(
  port: number,
  query: string,
  options?: WebSocket.ClientOptions,
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, options)
  return new Promise<WebSocket>((resolve, reject) => {
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
    socket.once("unexpected-response", (_req, res) =>
      reject(new Error(`status ${res.statusCode}`)),
    )
  })
}

test("serves the health check and the mobile UI on one port", async () => {
  const health = await fetch(`http://127.0.0.1:${relay.port}/healthz`)
  expect(health.status).toBe(200)
  expect(await health.text()).toBe("ok")

  const page = await fetch(`http://127.0.0.1:${relay.port}/`)
  expect(page.status).toBe(200)
  expect(page.headers.get("content-type")).toContain("text/html")
  const html = await page.text()
  expect(html).toContain("Typing goes straight to the browser")
  expect(html).toContain("/ws?role=human")

  const missing = await fetch(`http://127.0.0.1:${relay.port}/nope`)
  expect(missing.status).toBe(404)
})

test("routes agent messages to the human", async () => {
  const agent = await connect(relay.port, "agent")
  const human = await connect(relay.port, "human")

  agent.send({ type: "state", reason: "GitHub is asking for a 2FA code" })
  agent.send({ type: "frame", data: "Zmlyc3QtZnJhbWU=", meta: META })

  expect(await human.next()).toEqual({
    type: "state",
    reason: "GitHub is asking for a 2FA code",
  })
  expect(await human.next()).toEqual({
    type: "frame",
    data: "Zmlyc3QtZnJhbWU=",
    meta: META,
  })
})

test("routes human messages to the agent", async () => {
  const agent = await connect(relay.port, "agent")
  const human = await connect(relay.port, "human")

  human.send({ type: "tap", fx: 412, fy: 233 })
  human.send({ type: "char", ch: "7" })
  human.send({ type: "key", key: "Enter" })
  human.send({ type: "handback" })

  expect(await agent.next()).toEqual({ type: "tap", fx: 412, fy: 233 })
  expect(await agent.next()).toEqual({ type: "char", ch: "7" })
  expect(await agent.next()).toEqual({ type: "key", key: "Enter" })
  expect(await agent.next()).toEqual({ type: "handback" })
})

test("replays the last state and frame to a human who joins late", async () => {
  const agent = await connect(relay.port, "agent")
  agent.send({ type: "state", reason: "stale reason" })
  agent.send({ type: "frame", data: "c3RhbGU=", meta: META })
  agent.send({ type: "state", reason: "Solve the captcha" })
  agent.send({ type: "frame", data: "bGF0ZXN0", meta: META })

  // Give the relay time to buffer before the human shows up.
  await Bun.sleep(100)

  const human = await connect(relay.port, "human")
  expect(await human.next()).toEqual({
    type: "state",
    reason: "Solve the captcha",
  })
  expect(await human.next()).toEqual({
    type: "frame",
    data: "bGF0ZXN0",
    meta: META,
  })
})

test("answers ping with pong without forwarding it", async () => {
  const agent = await connect(relay.port, "agent")
  const human = await connect(relay.port, "human")

  agent.send({ type: "ping" })
  expect(await agent.next()).toEqual({ type: "pong" })

  human.send({ type: "ping" })
  expect(await human.next()).toEqual({ type: "pong" })

  // If the ping had been relayed, this would arrive second, not first.
  agent.send({ type: "state", reason: "still here" })
  expect(await human.next()).toEqual({ type: "state", reason: "still here" })
})

test("a second connection for a role replaces the first", async () => {
  const human = await connect(relay.port, "human")
  const first = await connect(relay.port, "agent")
  const second = await connect(relay.port, "agent")

  expect(await first.closed).toBeGreaterThan(0)
  expect(second.socket.readyState).toBe(WebSocket.OPEN)

  human.send({ type: "abort" })
  expect(await second.next()).toEqual({ type: "abort" })
})

test("the embedded guest source is identical to guest/server.js", () => {
  expect(GUEST_SERVER_JS).toBe(readFileSync(SERVER_PATH, "utf8"))
})

test("the guest server honours the protocol constants", () => {
  expect(GUEST_SERVER_JS).toContain(
    `const HEARTBEAT_INTERVAL_MS = ${HEARTBEAT_INTERVAL_MS}`,
  )
  expect(GUEST_SERVER_JS).toContain(`}, ${HEARTBEAT_INTERVAL_MS})`)
  expect(GUEST_SERVER_JS).toContain(`|| ${RELAY_PORT})`)
})

// --- B3: the agent role is a secret, not a claim ---------------------------

test("role=agent is refused without the secret and accepted with it", async () => {
  const keyed = await startRelayProcess("open-sesame")

  // The handoff-URL holder guessing role=agent, with no secret or a wrong one.
  await expect(openWs(keyed.port, "role=agent")).rejects.toBeDefined()
  await expect(openWs(keyed.port, "role=agent&k=wrong")).rejects.toBeDefined()

  const agent = await openWs(keyed.port, "role=agent&k=open-sesame")
  expect(agent.readyState).toBe(WebSocket.OPEN)
  // The human never carries the secret and still connects.
  const human = await openWs(keyed.port, "role=human")
  expect(human.readyState).toBe(WebSocket.OPEN)
  agent.close()
  human.close()
})

test("a cross-origin upgrade is refused, a same-origin one is not", async () => {
  const evil = await rawUpgrade(relay.port, "role=human", {
    Origin: "http://evil.example",
  })
  expect(evil.statusLine).toContain("403")
  evil.socket.destroy()

  const same = await rawUpgrade(relay.port, "role=human", {
    Origin: `http://127.0.0.1:${relay.port}`,
  })
  expect(same.statusLine).toContain("101")
  same.socket.destroy()
})

// --- B1: a terminal human message survives an agent reconnect --------------

test("a handback reaches an agent that reconnects after the human sent it", async () => {
  const first = await connect(relay.port, "agent")
  const human = await connect(relay.port, "human")

  // The agent socket blips (a reconnect) just before the human hands back.
  first.socket.close()
  await Bun.sleep(50)
  human.send({ type: "handback" })
  await Bun.sleep(50)

  const second = await connect(relay.port, "agent")
  expect(await second.next()).toEqual({ type: "handback" })
})

// --- B6: a late human after the end sees the ending, never the last frame ---

test("a human who joins after the handoff ended sees the ending, not the frame", async () => {
  const agent = await connect(relay.port, "agent")
  agent.send({ type: "state", reason: "the logged-in page" })
  agent.send({ type: "frame", data: "bG9nZ2VkLWlu", meta: META })
  agent.send({ type: "ended", outcome: "resolved" })
  await Bun.sleep(80)

  const late = await connect(relay.port, "human")
  expect(await late.next()).toEqual({ type: "ended", outcome: "resolved" })
  // A pong arriving next proves no stale frame or state was queued ahead of it.
  late.send({ type: "ping" })
  expect(await late.next()).toEqual({ type: "pong" })
})

// --- B4: fragment reassembly is bounded ------------------------------------

test("a fragmented message past the byte cap closes the socket", async () => {
  const { socket, statusLine } = await rawUpgrade(relay.port, "role=agent")
  expect(statusLine).toContain("101")

  const closed = new Promise<boolean>((resolve) => {
    socket.once("close", () => resolve(true))
    socket.once("end", () => resolve(true))
  })
  // Each part is under MAX_MESSAGE_BYTES, so the per-frame check passes; the two
  // together exceed it, which only the cumulative cap can catch.
  const part = Buffer.alloc(Math.ceil(MAX_MESSAGE_BYTES / 2) + 1, 0x61)
  socket.write(maskedFrame(OP_TEXT, false, part))
  socket.write(maskedFrame(OP_CONTINUATION, false, part))

  const result = await Promise.race([closed, Bun.sleep(2000).then(() => false)])
  expect(result).toBe(true)
  socket.destroy()
})

// --- Ownership: a replaced peer can no longer route ------------------------

test("a replaced agent can no longer inject messages", async () => {
  const human = await connect(relay.port, "human")
  const stale = await rawUpgrade(relay.port, "role=agent")
  expect(stale.statusLine).toContain("101")

  // A second agent takes over; the raw one is now displaced.
  const live = await connect(relay.port, "agent")
  await Bun.sleep(50)

  // Collect everything the human sees over a window, so a message that routes
  // out of order is still caught rather than hidden behind the first one.
  const received: RelayMessage[] = []
  human.socket.on("message", (raw: Buffer) =>
    received.push(parse(raw.toString())),
  )

  // The displaced socket ignores its close frame and tries to inject a frame.
  stale.socket.write(
    maskedFrame(
      OP_TEXT,
      true,
      Buffer.from(JSON.stringify({ type: "state", reason: "injected" })),
    ),
  )
  live.send({ type: "state", reason: "legit" })
  await Bun.sleep(300)

  const reasons = received.map((message) =>
    message.type === "state" ? message.reason : message.type,
  )
  expect(reasons).toContain("legit")
  expect(reasons).not.toContain("injected")
  stale.socket.destroy()
})

test("approval mode drops every takeover message the human sends", async () => {
  const approval = await startRelayProcess("", "approval")
  const agent = await connect(approval.port, "agent")
  const human = await connect(approval.port, "human")

  // Hiding the controls is not enough: the human's socket is reachable from
  // any HTTP client, so the refusal has to be the relay's, not the page's.
  human.send({ type: "tap", fx: 10, fy: 10 })
  human.send({ type: "char", ch: "a" })
  human.send({ type: "key", key: "Enter" })
  human.send({ type: "clear" })
  human.send({ type: "scroll", fdy: 40 })
  human.send({ type: "handback" })
  human.send({ type: "abort" })
  // Only this one is in the approval vocabulary, and it arrives after all of
  // them, so receiving it proves the others were dropped and not merely slow.
  human.send({ type: "approve" })

  expect(await agent.next()).toEqual({ type: "approve" })
})

test("takeover mode drops the approval answers", async () => {
  const agent = await connect(relay.port, "agent")
  const human = await connect(relay.port, "human")

  human.send({ type: "approve" })
  human.send({ type: "deny" })
  human.send({ type: "handback" })

  expect(await agent.next()).toEqual({ type: "handback" })
})

test("an approval relay serves the page in approval mode", async () => {
  const approval = await startRelayProcess("", "approval")

  const page = await fetch(`http://127.0.0.1:${approval.port}/`)
  const html = await page.text()
  expect(html).toContain('data-mode="approval"')
  // The same file serves both modes, so an approval page that still offered
  // the keyboard would render controls the relay refuses to route.
  expect(html).toContain("Hold to approve")
})

test("a deny reaches an agent that reconnects after the human sent it", async () => {
  const approval = await startRelayProcess("", "approval")
  const first = await connect(approval.port, "agent")
  const human = await connect(approval.port, "human")

  first.socket.close()
  await first.closed
  human.send({ type: "deny" })

  const second = await connect(approval.port, "agent")
  expect(await second.next()).toEqual({ type: "deny" })
})
