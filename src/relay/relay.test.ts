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
import { OPENABLE_SCHEMES } from "../core/qr-scan"
import type { HandoffMode } from "../types"
import { GUEST_SERVER_JS } from "./guest-source"
import {
  type AgentToHuman,
  HEARTBEAT_INTERVAL_MS,
  type Heartbeat,
  type HumanToAgent,
  RELAY_PORT,
  type RelayMessage,
  type RelayToAgent,
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
  /** The next message the relay *routed* here from the other peer. */
  next(): Promise<RelayMessage>
  /**
   * The next message the relay sent on its own behalf — `presence` and
   * `ended_ack`, which no peer wrote. Kept in a second queue so a test about
   * routing reads routed traffic only, and a test about presence cannot pass
   * on a forwarded message that happened to look right.
   */
  fromRelay(): Promise<RelayMessage>
  closed: Promise<number>
  socket: WebSocket
}

/** What the relay says for itself; everything else on the wire was forwarded. */
const RELAY_ORIGINATED = new Set<string>(["presence", "ended_ack"])

interface Mailbox {
  deliver(message: RelayMessage): void
  next(what: string): Promise<RelayMessage>
}

/** A queue of received messages with a waiter for the next one. */
function mailbox(): Mailbox {
  const queued: RelayMessage[] = []
  const waiters: ((message: RelayMessage) => void)[] = []
  return {
    deliver(message) {
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queued.push(message)
    },
    next(what) {
      const ready = queued.shift()
      if (ready) return Promise.resolve(ready)
      return new Promise<RelayMessage>((resolve, reject) => {
        const receive = (message: RelayMessage): void => {
          clearTimeout(timer)
          resolve(message)
        }
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(receive), 1)
          reject(new Error(`no ${what} within ${MESSAGE_TIMEOUT_MS}ms`))
        }, MESSAGE_TIMEOUT_MS)
        waiters.push(receive)
      })
    },
  }
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
  const routed = mailbox()
  const own = mailbox()

  socket.on("message", (raw: Buffer) => {
    const message = parse(raw.toString("utf8"))
    if (RELAY_ORIGINATED.has(message.type)) own.deliver(message)
    else routed.deliver(message)
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
    next: () => routed.next(`message for role=${role}`),
    fromRelay: () => own.next(`relay message for role=${role}`),
  }
}

/**
 * Resolve when the relay logs a given event with the given fields. The relay
 * writes one JSON line per event to stdout; this reads them. Arm it before the
 * action that causes the event, so the line cannot land before we are looking.
 *
 * `agent.closed` only tells us the client's socket is down — the server may not
 * have run its close handler yet. When a test's next step depends on that
 * handler having run (a scrubbed buffer, a freed role), wait for its log line
 * instead of the client close, or the two race.
 */
function waitForLog(
  relay: Relay,
  event: string,
  fields: Record<string, string>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buffered = ""
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8")
      for (const line of buffered.split("\n")) {
        if (!line.includes(`"event":"${event}"`)) continue
        const all = Object.entries(fields).every(([key, value]) =>
          line.includes(`"${key}":"${value}"`),
        )
        if (all) {
          cleanup()
          resolve()
          return
        }
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`no ${event} log within ${MESSAGE_TIMEOUT_MS}ms`))
    }, MESSAGE_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      relay.process.stdout.removeListener("data", onData)
    }
    relay.process.stdout.on("data", onData)
  })
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

// --- the wire vocabulary: one set, three places ----------------------------

/**
 * The constant name `guest/server.js` must give every message type on the
 * wire, keyed by the protocol's own unions.
 *
 * The annotation is a mapped type over all three, so a member added to
 * `AgentToHuman`, `HumanToAgent` or `Heartbeat` does not compile here until it
 * is listed — and does not go green until the relay names it too. That is the
 * point: the relay is untyped JavaScript, where a mistyped `"framme"` is not a
 * compile error but a message that is silently never matched.
 */
const WIRE_NAMES = {
  frame: "FRAME",
  state: "STATE",
  focus: "FOCUS",
  links: "LINKS",
  ended: "ENDED",
  tap: "TAP",
  char: "CHAR",
  key: "KEY",
  clear: "CLEAR",
  scroll: "SCROLL",
  scanqr: "SCANQR",
  handback: "HANDBACK",
  abort: "ABORT",
  approve: "APPROVE",
  deny: "DENY",
  presence: "PRESENCE",
  ended_ack: "ENDED_ACK",
  ping: "PING",
  pong: "PONG",
} satisfies {
  [K in
    | AgentToHuman["type"]
    | HumanToAgent["type"]
    | RelayToAgent["type"]
    | Heartbeat["type"]]: string
}

/** The relay's own `MSG` object, read back out of the source that defines it. */
function guestVocabulary(): Map<string, string> {
  const block = /const MSG = \{([\s\S]*?)\n\}/.exec(GUEST_SERVER_JS)?.[1]
  if (!block) throw new Error("guest/server.js no longer defines MSG")
  const found = new Map<string, string>()
  for (const [, name, value] of block.matchAll(/(\w+): "([^"]+)"/g)) {
    if (name && value) found.set(name, value)
  }
  return found
}

test("the relay names every message type the protocol defines, and no others", () => {
  const found = guestVocabulary()
  for (const [type, name] of Object.entries(WIRE_NAMES)) {
    expect(found.get(name)).toBe(type)
  }
  // No extras either: a constant the relay carries but the protocol has never
  // heard of is a message nobody on the TypeScript side can send or receive.
  expect([...found.keys()].sort()).toEqual(Object.values(WIRE_NAMES).sort())
})

test("neither the relay nor the page it serves spells a message type by hand", () => {
  for (const type of Object.keys(WIRE_NAMES)) {
    expect(GUEST_SERVER_JS).not.toContain(`type: "${type}"`)
    expect(GUEST_SERVER_JS).not.toContain(`type === "${type}"`)
  }
})

test("the relay's openable schemes are the core's list, not a second one", () => {
  const block = /const OPENABLE_SCHEMES = \[([^\]]*)\]/.exec(
    GUEST_SERVER_JS,
  )?.[1]
  if (!block) throw new Error("guest/server.js no longer defines the schemes")
  const schemes = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  // The phone re-checks a link's scheme before it builds an anchor for it, and
  // the check is only worth anything if it is checking the same list the agent
  // classified against.
  expect(schemes.sort()).toEqual([...OPENABLE_SCHEMES].sort())
})

test("the served page carries the relay's own vocabulary, not a copy", async () => {
  const html = await (await fetch(`http://127.0.0.1:${relay.port}/`)).text()

  // The placeholder is gone, which is the only proof the substitution ran.
  expect(html).not.toContain("__HANDRAISE_VOCAB__")
  for (const [name, type] of guestVocabulary()) {
    expect(html).toContain(`"${name}":"${type}"`)
  }
  expect(html).toContain(`"TAKEOVER":"takeover"`)
  expect(html).toContain(`"APPROVAL":"approval"`)
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

// --- 0.7.0: peer presence, and a receipt for the ending --------------------

test("the agent is told when the human arrives and when they leave", async () => {
  const agent = await connect(relay.port, "agent")
  // Nobody has scanned the code yet, and the agent is told exactly that: the
  // first presence is the current state, not the first change.
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: false })

  const human = await connect(relay.port, "human")
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: true })

  human.socket.close()
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: false })
})

test("an agent that connects while the human is there is told so at once", async () => {
  const human = await connect(relay.port, "human")
  // The human scanned the QR code before the agent's socket was up, which is
  // the ordinary race on a fast phone.
  const agent = await connect(relay.port, "agent")
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: true })

  // And a reconnecting agent — the 60 s proxy cut — starts from the truth
  // rather than from what it believed before the cut.
  agent.socket.close()
  await waitForLog(relay, "peer closed", { role: "agent" })
  const second = await connect(relay.port, "agent")
  expect(await second.fromRelay()).toEqual({ type: "presence", human: true })
  human.socket.close()
  expect(await second.fromRelay()).toEqual({ type: "presence", human: false })
})

test("a phone replaced by a second one is a leave and a join, not silence", async () => {
  const agent = await connect(relay.port, "agent")
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: false })
  const first = await connect(relay.port, "human")
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: true })

  // A second holder of the link opens it; the relay keeps one human socket, so
  // the first is closed. The agent must not be left believing nobody is there.
  await connect(relay.port, "human")
  expect(await first.closed).toBeGreaterThan(0)
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: false })
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: true })
})

test("presence is for the agent only and is never sent to the phone", async () => {
  const agent = await connect(relay.port, "agent")
  const human = await connect(relay.port, "human")
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: false })

  agent.send({ type: "state", reason: "the first thing the phone hears" })
  expect(await human.next()).toEqual({
    type: "state",
    reason: "the first thing the phone hears",
  })
})

test("the relay acknowledges the ending once it has stored it", async () => {
  const agent = await connect(relay.port, "agent")
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: false })
  const human = await connect(relay.port, "human")
  expect(await agent.fromRelay()).toEqual({ type: "presence", human: true })

  agent.send({ type: "ended", outcome: "approved" })
  expect(await agent.fromRelay()).toEqual({ type: "ended_ack" })

  // The ack means stored, not merely received: the next visitor of the link is
  // told how it ended, which is the whole reason the agent waits for it.
  human.socket.close()
  const late = await connect(relay.port, "human")
  expect(await late.next()).toEqual({ type: "ended", outcome: "approved" })
})

test("an agent that reconnects before sending the ending is acknowledged too", async () => {
  const first = await connect(relay.port, "agent")
  first.socket.close()
  await waitForLog(relay, "peer closed", { role: "agent" })

  const second = await connect(relay.port, "agent")
  expect(await second.fromRelay()).toEqual({ type: "presence", human: false })
  second.send({ type: "ended", outcome: "timeout" })
  expect(await second.fromRelay()).toEqual({ type: "ended_ack" })
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
  human.send({ type: "scanqr" })
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

test("the first terminal answer wins, and a second holder cannot overturn it", async () => {
  // The handoff link is a bearer URL and may be shared. Two people can hold it
  // at once, and the relay hands the agent whichever answer arrived while it
  // was away — so the second one must not be able to overwrite a denial with
  // an approval.
  const approval = await startRelayProcess("", "approval")
  const first = await connect(approval.port, "agent")
  const human = await connect(approval.port, "human")

  first.socket.close()
  await first.closed
  human.send({ type: "deny" })
  human.send({ type: "approve" })

  const second = await connect(approval.port, "agent")
  expect(await second.next()).toEqual({ type: "deny" })
  // And nothing else: the approval was dropped, not queued behind it.
  await expect(second.next()).rejects.toThrow(/no message/)
})

test("a takeover answer is terminal too: an abort cannot follow a handback", async () => {
  const agent = await connect(relay.port, "agent")
  const human = await connect(relay.port, "human")

  human.send({ type: "handback" })
  human.send({ type: "abort" })
  human.send({ type: "tap", fx: 1, fy: 2 })

  expect(await agent.next()).toEqual({ type: "handback" })
  await expect(agent.next()).rejects.toThrow(/no message/)
})

test("an agent frame after the human answered is not replayed to a late human", async () => {
  const approval = await startRelayProcess("", "approval")
  const agent = await connect(approval.port, "agent")
  const human = await connect(approval.port, "human")

  agent.send({ type: "state", reason: "may I pay this invoice?" })
  agent.send({ type: "frame", data: "c2NyZWVuc2hvdA==", meta: META })
  expect(await human.next()).toEqual({
    type: "state",
    reason: "may I pay this invoice?",
  })
  human.send({ type: "deny" })
  expect(await agent.next()).toEqual({ type: "deny" })

  // A reconnecting agent re-sends what it has. The handoff is over, so none of
  // it may go back into the replay buffer the next visitor is served from.
  agent.send({ type: "state", reason: "may I pay this invoice?" })
  agent.send({ type: "frame", data: "c2NyZWVuc2hvdA==", meta: META })
  await Bun.sleep(150)

  const late = await connect(approval.port, "human")
  await expect(late.next()).rejects.toThrow(/no message/)
})

test("the replay buffer is dropped when the agent disconnects, and restored when it returns", async () => {
  // If the agent dies without delivering its `ended` — a timeout during an
  // outage, a killed process — the relay would otherwise keep serving the
  // page's last frame to anyone holding the link until the sandbox idles out.
  const agent = await connect(relay.port, "agent")
  agent.send({ type: "state", reason: "Aurora Bank is asking for a code" })
  agent.send({ type: "frame", data: "Zmlyc3QtZnJhbWU=", meta: META })
  const human = await connect(relay.port, "human")
  expect(await human.next()).toEqual({
    type: "state",
    reason: "Aurora Bank is asking for a code",
  })

  // Arm the wait before the close so the log line cannot slip past us, then
  // wait for the server to have run its close handler — not just the client
  // socket to be down — before a late human can prove the buffer is gone.
  const scrubbed = waitForLog(relay, "peer closed", { role: "agent" })
  agent.socket.close()
  await agent.closed
  await scrubbed
  const late = await connect(relay.port, "human")
  await expect(late.next()).rejects.toThrow(/no message/)

  // A handoff that is still running recovers on its own: the agent reconnects
  // and re-sends its state, and the next visitor sees it again.
  const back = await connect(relay.port, "agent")
  back.send({ type: "state", reason: "Aurora Bank is asking for a code" })
  await Bun.sleep(150)
  const later = await connect(relay.port, "human")
  expect(await later.next()).toEqual({
    type: "state",
    reason: "Aurora Bank is asking for a code",
  })
})

// --- what the human side may cost this process -----------------------------

test("a human message past 4 KiB closes the socket instead of being routed", async () => {
  const agent = await connect(relay.port, "agent")
  const human = await connect(relay.port, "human")

  // Every message this side can send is a handful of small fields. The agent's
  // frames are why the general cap is megabytes; a bearer-link holder padding
  // an accepted message to eight of them is why this one is four kilobytes,
  // and why it is enforced in the reader before anything is parsed.
  human.socket.send(
    JSON.stringify({ type: "char", ch: "7", pad: "x".repeat(8 * 1024) }),
  )
  expect(await human.closed).toBeGreaterThan(0)
  await expect(agent.next()).rejects.toThrow(/no message/)

  // An ordinary message on a fresh socket is untouched by the cap.
  const second = await connect(relay.port, "human")
  second.send({ type: "char", ch: "7" })
  expect(await agent.next()).toEqual({ type: "char", ch: "7" })
})

test("the relay drops a second scan inside its own floor", async () => {
  const agent = await connect(relay.port, "agent")
  const human = await connect(relay.port, "human")

  // The core enforces this too, and its copy is the one that protects the
  // browser. This one is what stops a burst costing the agent a wake-up and a
  // JSON parse per message — which the core cannot refuse, because by then it
  // has already paid for both.
  human.send({ type: "scanqr" })
  human.send({ type: "scanqr" })
  human.send({ type: "scanqr" })
  // A message the relay always routes, sent last: receiving it proves the two
  // extra scans were dropped rather than merely slow.
  human.send({ type: "char", ch: "7" })

  expect(await agent.next()).toEqual({ type: "scanqr" })
  expect(await agent.next()).toEqual({ type: "char", ch: "7" })
})

test("a terminal answer is delivered even while the agent is backpressured", async () => {
  // A human faster than the agent's socket can take: the relay stops reading
  // that socket rather than growing its own write queue. What it must never do
  // is hold back a message it has already accepted — the handback is the one
  // the agent is waiting for, and a human who has answered has stopped
  // producing anything that could push it through.
  //
  // A raw TCP socket for the agent, because this test needs a receiver that
  // really stops reading: `ws`'s `pause()` is not implemented under bun. The
  // relay writes unmasked frames, so the JSON is plain in the stream and
  // "did the handback arrive" is a substring of the bytes.
  const { socket: agentSocket } = await rawUpgrade(relay.port, "role=agent")
  const human = await connect(relay.port, "human")
  agentSocket.pause()

  const paused = waitForLog(relay, "human paused", {})
  // Enough to fill both socket buffers and make the relay's write to the agent
  // return false. Each message is just under the 4 KiB human ceiling, so this
  // is about eight megabytes aimed at a receiver that has stopped reading.
  const filler = JSON.stringify({
    type: "char",
    ch: "x",
    pad: "p".repeat(3800),
  })
  for (let i = 0; i < 2_000; i++) human.socket.send(filler)
  human.send({ type: "handback" })
  await paused

  let seen = ""
  agentSocket.on("data", (chunk: Buffer) => {
    seen += chunk.toString("utf8")
  })
  const resumed = waitForLog(relay, "human resumed", {})
  agentSocket.resume()
  await resumed

  const deadline = Date.now() + 8000
  while (!seen.includes('"handback"') && Date.now() < deadline) {
    await Bun.sleep(50)
  }
  expect(seen).toContain('"handback"')
  agentSocket.destroy()
}, 20000)
