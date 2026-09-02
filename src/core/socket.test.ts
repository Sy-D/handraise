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
import type { HandoffMode } from "../types"
import {
  connectRelay,
  ENDED_ACK_TIMEOUT_MS,
  type RelayConnection,
} from "./socket"

const SERVER_PATH = fileURLToPath(
  new URL("../relay/guest/server.js", import.meta.url),
)
const START_TIMEOUT_MS = 5000
/** Long enough for one local round trip through the real relay process. */
const MESSAGE_WAIT_MS = 2000

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
function startRelayProcess(mode: HandoffMode = "takeover"): Promise<{
  port: number
  process: ChildProcessByStdio<null, Readable, Readable>
}> {
  const child = spawn(process.execPath, [SERVER_PATH, "0", "", mode], {
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
  // The recovered drop is counted for the wide event; the first connect is not.
  expect(connection.stats().reconnects).toBe(1)
})

test("sendFinal waits for a reconnect before giving up on the ending", async () => {
  const fake = await startFakeRelay()
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${fake.port}/ws?role=agent`,
      onMessage: () => undefined,
      heartbeatMs: 60_000,
    }),
  )
  await until("the socket to open", () => connection.isOpen())

  // Drop the socket and wait until it is observably down, then deliver the
  // terminal message. A plain send would resolve without sending; sendFinal
  // must wait for the reconnect and get the ending across on the new socket.
  fake.sockets[0]?.terminate()
  await until("the socket to drop", () => !connection.isOpen())
  await connection.sendFinal({ type: "ended", outcome: "resolved" })

  await until("the ending arrived after the reconnect", () =>
    fake.received.some((message) => message.type === "ended"),
  )
})

test("presence from the real relay is reported, and only presence", async () => {
  const relay = await startRelayProcess()
  const presence: boolean[] = []
  const human: HumanToAgent[] = []
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${relay.port}/ws?role=agent`,
      onMessage: (message) => human.push(message),
      onPresence: (there) => presence.push(there),
    }),
  )
  await until("the agent socket to open", () => connection.isOpen())
  // Nobody has opened the link yet, and that is what the relay says first.
  await until("the empty relay to report itself", () => presence.length === 1)
  expect(presence).toEqual([false])

  const phone = await rawPeer(relay.port, "human")
  await until("the arrival", () => presence.length === 2)
  phone.socket.close()
  await until("the departure", () => presence.length === 3)

  expect(presence).toEqual([false, true, false])
  // Presence is the relay's own message, not the human's: it must never reach
  // the handoff as if a person had sent it.
  expect(human).toEqual([])
})

test("sendFinal waits for the relay to acknowledge the ending", async () => {
  const relay = await startRelayProcess()
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${relay.port}/ws?role=agent`,
      onMessage: () => undefined,
    }),
  )
  await until("the agent socket to open", () => connection.isOpen())

  await connection.sendFinal({ type: "ended", outcome: "approved" })

  // The ack is what makes the next line safe to assert without polling: the
  // relay has stored the ending before `sendFinal` resolved, so a phone that
  // opens the link now is told how it ended.
  expect(connection.stats().endedAcked).toBe(true)
  const late = await rawPeer(relay.port, "human")
  await until(
    "the late phone to be told",
    () => late.inbox.length > 0,
    MESSAGE_WAIT_MS,
  )
  expect(late.inbox).toEqual([{ type: "ended", outcome: "approved" }])
})

test("a relay that never acknowledges the ending costs two seconds, not the handoff", async () => {
  // An older relay, or one whose socket died between the write and the ack.
  // The ending still went out; the agent must not hang on the receipt.
  const fake = await startFakeRelay()
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${fake.port}/ws?role=agent`,
      onMessage: () => undefined,
      heartbeatMs: 60_000,
    }),
  )
  await until("the socket to open", () => connection.isOpen())

  const startedAt = Date.now()
  await connection.sendFinal({ type: "ended", outcome: "timeout" })
  const waited = Date.now() - startedAt

  expect(fake.received).toEqual([{ type: "ended", outcome: "timeout" }])
  expect(connection.stats().endedAcked).toBe(false)
  expect(waited).toBeGreaterThanOrEqual(ENDED_ACK_TIMEOUT_MS - 50)
  expect(waited).toBeLessThan(ENDED_ACK_TIMEOUT_MS + 1500)
}, 10000)

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

/**
 * One of every message the human can send, exhaustive by construction: the
 * mapped type below is keyed by `HumanToAgent["type"]`, so adding a member to
 * the protocol is a compile error here until it is listed.
 */
const SAMPLES = {
  tap: { type: "tap", fx: 412, fy: 233 },
  char: { type: "char", ch: "7" },
  key: { type: "key", key: "Enter" },
  clear: { type: "clear" },
  scroll: { type: "scroll", fdy: 40 },
  scanqr: { type: "scanqr" },
  handback: { type: "handback" },
  abort: { type: "abort" },
  approve: { type: "approve" },
  deny: { type: "deny" },
} satisfies { [K in HumanToAgent["type"]]: Extract<HumanToAgent, { type: K }> }

/** Which mode's relay routes which of them (`HUMAN_MESSAGES` in guest/server.js). */
const ROUTED_BY = {
  takeover: [
    "tap",
    "char",
    "key",
    "clear",
    "scroll",
    "scanqr",
    "handback",
    "abort",
  ],
  approval: ["approve", "deny"],
} satisfies Record<HandoffMode, HumanToAgent["type"][]>

/** The answers that end a handoff. The relay accepts the first one and no more. */
const TERMINAL = new Set<string>(["handback", "abort", "approve", "deny"])

/** Send a batch through one relay, and report what came out the other end. */
async function deliverBatch(
  mode: HandoffMode,
  types: HumanToAgent["type"][],
): Promise<HumanToAgent["type"][]> {
  const relay = await startRelayProcess(mode)
  const received: HumanToAgent[] = []
  const connection = track(
    connectRelay({
      url: `ws://127.0.0.1:${relay.port}/ws?role=agent`,
      onMessage: (message) => received.push(message),
    }),
  )
  await until("the agent socket to open", () => connection.isOpen())
  const human = await rawPeer(relay.port, "human")

  for (const type of types) human.socket.send(JSON.stringify(SAMPLES[type]))
  await until(
    `all ${types.length} ${mode} messages to arrive`,
    () => received.length === types.length,
  )
  return received.map((message) => message.type)
}

/**
 * Send everything this mode routes, and report what came out the other end.
 * One relay per terminal answer, because the first answer ends the handoff and
 * the relay then correctly refuses the rest.
 */
async function deliverThroughRelay(
  mode: HandoffMode,
): Promise<HumanToAgent["type"][]> {
  const routed: HumanToAgent["type"][] = [...ROUTED_BY[mode]]
  const ordinary = routed.filter((type) => !TERMINAL.has(type))
  const seen = ordinary.length > 0 ? await deliverBatch(mode, ordinary) : []
  for (const type of routed.filter((each) => TERMINAL.has(each))) {
    seen.push(...(await deliverBatch(mode, [type])))
  }
  return seen
}

test("every human message the protocol defines reaches the agent", async () => {
  // The human's vocabulary is written down three times: the protocol union,
  // the relay's per-mode HUMAN_MESSAGES, and the switch in socket.ts. They
  // drifted once — `clear` was in the first two and missing from the third, so
  // the phone's Clear key left the socket and died in the agent's own router,
  // silently. This is the test that turns that drift into a red build.
  const takeover = await deliverThroughRelay("takeover")
  const approval = await deliverThroughRelay("approval")

  expect(takeover).toEqual(ROUTED_BY.takeover)
  expect(approval).toEqual(ROUTED_BY.approval)

  // And no message in the protocol is routed by neither mode.
  const routed = new Set<string>([...ROUTED_BY.takeover, ...ROUTED_BY.approval])
  for (const type of Object.keys(SAMPLES)) {
    expect(routed.has(type)).toBe(true)
  }
}, 15000)
