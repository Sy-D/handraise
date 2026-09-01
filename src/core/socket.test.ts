/**
 * The agent's socket, tested against two servers.
 *
 * Routing runs against the **real** `src/relay/guest/server.js` under the real
 * `node`, because the thing under test is wire behaviour and the relay is the
 * peer it has to survive. Heartbeat and reconnect run against a bare `ws`
 * server, because the relay answers pings itself and never sends one, so there
 * is no way to observe either from behind it.
 *
 *   bun test src/core/
 */
import { afterEach, expect, test } from "bun:test"
import { type ChildProcessByStdio, spawn } from "node:child_process"
import type { AddressInfo } from "node:net"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import WebSocket, { WebSocketServer } from "ws"

import type { HumanToAgent, RelayMessage } from "../relay/protocol"
import { connectRelay, type RelayConnection } from "./socket"

const SERVER_PATH = fileURLToPath(
  new URL("../relay/guest/server.js", import.meta.url),
)
const START_TIMEOUT_MS = 5000

const META = {
  deviceWidth: 1280,
  deviceHeight: 800,
  jpegWidth: 800,
  jpegHeight: 500,
  pageScaleFactor: 1,
}

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

function parse(raw: string): RelayMessage {
  // SAFETY: every payload in this file is written by this file or by the relay
  // it starts, and the relay forwards bytes verbatim.
  return JSON.parse(raw) as RelayMessage
}

/** Wait until `check` is true, or fail the test with `what`. */
async function until(
  what: string,
  check: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

/** The real relay, on an OS-assigned port read back out of its startup log. */
function startRelayProcess(): Promise<{
  port: number
  process: ChildProcessByStdio<null, Readable, Readable>
}> {
  const child = spawn(process.execPath, [SERVER_PATH, "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanups.push(() => {
    child.kill("SIGKILL")
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`relay did not start within ${START_TIMEOUT_MS}ms`))
    }, START_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      const match = /"event":"relay listening".*"port":(\d+)/.exec(
        chunk.toString("utf8"),
      )
      if (!match?.[1]) return
      clearTimeout(timer)
      resolve({ port: Number(match[1]), process: child })
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

interface FakeRelay {
  port: number
  /** Every application message the server received, newest last. */
  received: RelayMessage[]
  /** One entry per accepted connection. */
  sockets: WebSocket[]
  send(message: RelayMessage): void
}

/** A bare WebSocket server: no relay semantics, full control over the socket. */
async function startFakeRelay(): Promise<FakeRelay> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  const received: RelayMessage[] = []
  const sockets: WebSocket[] = []

  server.on("connection", (socket: WebSocket) => {
    sockets.push(socket)
    socket.on("message", (data: Buffer) =>
      received.push(parse(data.toString())),
    )
  })
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  )
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate()
        server.close(() => resolve())
      }),
  )

  const address = server.address()
  // SAFETY: the server was opened on a TCP port and is listening, and
  // `address()` only returns a string for a unix socket.
  const port = (address as AddressInfo).port
  return {
    port,
    received,
    sockets,
    send(message) {
      sockets.at(-1)?.send(JSON.stringify(message))
    },
  }
}

/** A raw peer, the way the phone or a second agent would connect. */
async function rawPeer(
  port: number,
  role: "agent" | "human",
): Promise<{ inbox: RelayMessage[]; socket: WebSocket }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}`)
  const inbox: RelayMessage[] = []
  socket.on("message", (data: Buffer) => inbox.push(parse(data.toString())))
  cleanups.push(() => socket.close())
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })
  return { inbox, socket }
}

function track(connection: RelayConnection): RelayConnection {
  cleanups.push(() => connection.close())
  return connection
}

test("state and frames reach a human through the real relay", async () => {
  const relay = await startRelayProcess()
  const human = await rawPeer(relay.port, "human")
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${relay.port}/ws?role=agent`,
      onMessage: () => undefined,
    }),
  )

  await until("the agent socket to open", () => connection.isOpen())
  await connection.send({ type: "state", reason: "Aurora Bank wants a code" })
  await connection.send({ type: "frame", data: "Zmlyc3Q=", meta: META })

  await until("two messages on the phone", () => human.inbox.length === 2)
  expect(human.inbox[0]).toEqual({
    type: "state",
    reason: "Aurora Bank wants a code",
  })
  expect(human.inbox[1]).toEqual({
    type: "frame",
    data: "Zmlyc3Q=",
    meta: META,
  })
})

test("what the human does arrives as typed messages", async () => {
  const relay = await startRelayProcess()
  const received: HumanToAgent[] = []
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${relay.port}/ws?role=agent`,
      onMessage: (message) => received.push(message),
    }),
  )
  await until("the agent socket to open", () => connection.isOpen())
  const human = await rawPeer(relay.port, "human")

  human.socket.send(JSON.stringify({ type: "tap", fx: 412, fy: 233 }))
  human.socket.send(JSON.stringify({ type: "char", ch: "7" }))
  human.socket.send(JSON.stringify({ type: "key", key: "Enter" }))
  human.socket.send(JSON.stringify({ type: "handback" }))

  await until("four human messages", () => received.length === 4)
  expect(received).toEqual([
    { type: "tap", fx: 412, fy: 233 },
    { type: "char", ch: "7" },
    { type: "key", key: "Enter" },
    { type: "handback" },
  ])
})

test("the state is re-sent on every connect, including after a takeover", async () => {
  // The relay closes an agent's socket when a second agent connects. That is
  // indistinguishable from the proxy's 60 s idle kill, and the answer to both
  // is the same: reconnect and say who you are again.
  const relay = await startRelayProcess()
  const human = await rawPeer(relay.port, "human")
  let opens = 0
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${relay.port}/ws?role=agent`,
      onMessage: () => undefined,
      onOpen: () => {
        opens += 1
        void connection.send({ type: "state", reason: "still here" })
      },
    }),
  )
  await until("the first state", () => human.inbox.length === 1)

  const intruder = await rawPeer(relay.port, "agent")
  intruder.socket.close()

  await until("a reconnect", () => opens === 2, 6000)
  await until("a second state", () => human.inbox.length === 2)
  expect(human.inbox[1]).toEqual({ type: "state", reason: "still here" })
  expect(connection.isOpen()).toBe(true)
})

test("a ping from the relay is answered with a pong", async () => {
  const fake = await startFakeRelay()
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${fake.port}/ws?role=agent`,
      onMessage: () => undefined,
      heartbeatMs: 60_000,
    }),
  )
  await until("the socket to open", () => connection.isOpen())

  fake.send({ type: "ping" })
  await until("a pong", () =>
    fake.received.some((message) => message.type === "pong"),
  )
})

test("a heartbeat goes out on its own, because the proxy kills a silent socket", async () => {
  const fake = await startFakeRelay()
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${fake.port}/ws?role=agent`,
      onMessage: () => undefined,
      heartbeatMs: 30,
    }),
  )
  await until("the socket to open", () => connection.isOpen())

  await until(
    "three unprompted pings",
    () => fake.received.filter((m) => m.type === "ping").length >= 3,
  )
})

test("a socket dropped mid-handoff comes back", async () => {
  const fake = await startFakeRelay()
  let opens = 0
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${fake.port}/ws?role=agent`,
      onMessage: () => undefined,
      onOpen: () => {
        opens += 1
      },
      heartbeatMs: 60_000,
    }),
  )
  await until("the first connect", () => opens === 1)

  // Close 1006, exactly what the preview proxy does after 60 s of silence.
  fake.sockets[0]?.terminate()

  await until("a second connect", () => opens === 2, 6000)
  expect(fake.sockets).toHaveLength(2)
  expect(connection.isOpen()).toBe(true)
})

test("close() ends the handoff and stops reconnecting", async () => {
  const fake = await startFakeRelay()
  let opens = 0
  const connection = connectRelay({
    url: `ws://127.0.0.1:${fake.port}/ws?role=agent`,
    onMessage: () => undefined,
    onOpen: () => {
      opens += 1
    },
    heartbeatMs: 20,
  })
  await until("the first connect", () => opens === 1)

  await connection.close()
  const sent = fake.received.length
  await Bun.sleep(700)

  expect(opens).toBe(1)
  expect(fake.sockets).toHaveLength(1)
  expect(connection.isOpen()).toBe(false)
  // No heartbeat survives the close, so no timer keeps the process alive.
  expect(fake.received.length).toBe(sent)
  // Sending after close is a no-op rather than a crash.
  await connection.send({ type: "state", reason: "too late" })
  expect(fake.received.length).toBe(sent)
})
