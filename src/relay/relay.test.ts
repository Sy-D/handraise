/**
 * Local tests for the in-guest relay. They run the real `guest/server.js` under
 * the real `node`, on a port the OS picks, and talk to it with the `ws` client —
 * no stubs, because the thing under test is wire behaviour.
 *
 *   bun test src/relay/
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { type ChildProcessByStdio, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"

import { GUEST_SERVER_JS } from "./guest-source"
import {
  HEARTBEAT_INTERVAL_MS,
  RELAY_PORT,
  type RelayMessage,
} from "./protocol"

const SERVER_PATH = fileURLToPath(new URL("./guest/server.js", import.meta.url))
const MESSAGE_TIMEOUT_MS = 2000
const START_TIMEOUT_MS = 5000

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

/** Start the real server on an OS-assigned port and read the port back out of its log. */
function startRelayProcess(): Promise<Relay> {
  const child = spawn(process.execPath, [SERVER_PATH, "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  })
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
})

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
