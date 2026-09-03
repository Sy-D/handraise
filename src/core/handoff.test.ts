/**
 * A whole handoff, end to end, against the real in-guest relay under node — the
 * same peer the socket and relay tests use — with a fake browser page in place
 * of a Solari session. It proves the observability contract:
 *
 *   - `onEvent` fires exactly once, with a plausible wide event;
 *   - the frame, tap and handback flow through the real relay so the counters
 *     (framesSent, bytesSent, inputsApplied, firstFrameMs) are real;
 *   - a throwing `onEvent` does not break the handoff.
 *
 *   bun test src/core/
 */
import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core"
import WebSocket, { WebSocketServer } from "ws"

import type {
  ChannelHandoff,
  HandoffChannel,
  TakeoverChannelHandoff,
} from "../channels"
import type { HandoffEvent } from "../events"
import { type Logger, noopLogger } from "../logger"
import type { RelayMessage } from "../relay/protocol"
import type {
  HandoffMode,
  HandoffResult,
  RaiseHandOptions,
  StorageState,
} from "../types"
import { raiseHand, runHandoff, watchPresence } from "./raise-hand"
import type { ScreencastFrame } from "./screencast"

const SERVER_PATH = fileURLToPath(
  new URL("../relay/guest/server.js", import.meta.url),
)
const START_TIMEOUT_MS = 5000

const FRAME: ScreencastFrame = {
  // A tiny valid-enough base64 payload; jpegSize falls back to profile scaling.
  data: Buffer.from("a frame from the fake page").toString("base64"),
  sessionId: 1,
  metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1 },
}

const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

/** Wait until `check` is true, or fail with `what`. */
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

/** The real relay on an OS-assigned port, read back out of its startup log. */
function startRelayProcess(mode: HandoffMode = "takeover"): Promise<number> {
  const child = spawn(process.execPath, [SERVER_PATH, "0", "", mode], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanups.push(() => child.kill("SIGKILL"))
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
      resolve(Number(match[1]))
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** A raw human phone: a WebSocket that speaks the wire protocol. */
async function connectHuman(port: number): Promise<{
  inbox: RelayMessage[]
  send(message: RelayMessage): void
  /** Close the tab, the way a human who has given up does: no message first. */
  close(): void
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=human`)
  const inbox: RelayMessage[] = []
  socket.on("message", (data: Buffer) =>
    // SAFETY: every payload on this socket is a RelayMessage the relay forwarded
    // verbatim from the agent under test.
    inbox.push(JSON.parse(data.toString("utf8")) as RelayMessage),
  )
  cleanups.push(() => socket.close())
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })
  return {
    inbox,
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  }
}

interface FakeCdp {
  cdp: CDPSession
  calls: string[]
  emitFrame(frame: ScreencastFrame): void
}

/** A CDP session that records commands and can push a screencast frame. */
function fakeCdp(): FakeCdp {
  const calls: string[] = []
  const handlers = new Set<(frame: ScreencastFrame) => void>()
  const partial: Partial<CDPSession> = {
    // SAFETY: runHandoff awaits every CDP command and discards its value, so no
    // member of the command's return type is ever read.
    send: (async (method: string) => {
      calls.push(method)
      return {}
    }) as CDPSession["send"],
    // SAFETY: on/off manage only the screencastFrame listener; the emitter's
    // `this` return is never used, so a void body under the real type is safe.
    on: ((event: string, listener: (frame: ScreencastFrame) => void) => {
      if (event === "Page.screencastFrame") handlers.add(listener)
    }) as CDPSession["on"],
    // SAFETY: as `on`, above — the unused `this` return under the real type.
    off: ((_event: string, listener: (frame: ScreencastFrame) => void) => {
      handlers.delete(listener)
    }) as CDPSession["off"],
    detach: async () => undefined,
  }
  return {
    // SAFETY: runHandoff drives only send/on/off/detach on the CDP session; the
    // rest of CDPSession is never reached on this path.
    cdp: partial as CDPSession,
    calls,
    emitFrame: (frame) => {
      for (const handler of handlers) handler(frame)
    },
  }
}

const STORAGE: StorageState = { cookies: [], origins: [] }

/**
 * A gateway that cannot answer. The guards under test throw before any client
 * is built; this is only here so that a regression fails against a closed port
 * rather than creating a sandbox with whatever key the environment holds.
 */
const CLOSED_PORT = "http://127.0.0.1:1"

/** A real 800x500 JPEG, so the approval frame's metadata is parsed, not guessed. */
const SAMPLE_JPEG = readFileSync(
  fileURLToPath(new URL("./fixtures/sample-frame.jpg", import.meta.url)),
)

/**
 * A real screenshot of a real page carrying a real QR code, so a `scanqr` is
 * answered by the decoder rather than by a stub that always agrees.
 * `page.screenshot({ type: "png" })` is what a scan asks for; an approval's one
 * frame asks for a JPEG, and `fakePage` answers each with its own bytes.
 */
const QR_PAGE_PNG = readFileSync(
  fileURLToPath(new URL("./fixtures/qr-page.png", import.meta.url)),
)
const QR_PAGE_LINK = `https://verify.example.com/device?token=${"a1b2c3d4".repeat(20)}`

/** A white PNG: a page with nothing on it to find. */
function blankPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1), 0xff)
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, "ascii")
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

const BLANK_PNG = blankPng(64, 40)
const VIEWPORT = { width: 1280, height: 800 }

/** CDP sessions opened on the fake page since the last reset. */
let cdpSessions = 0

/** Screenshots the newest `fakePage()` has been asked for. */
let screenshots = 0

/** Kills the browser session behind the newest `fakePage()`. */
let killSession: () => void = () => undefined

/**
 * A page whose context yields the fake CDP session and a live fake browser.
 *
 * `screenshotDelayMs` holds the approval's one screenshot in flight, which is
 * the window in which a handoff can settle before the frame ever lands.
 */
function fakePage(
  cdp: CDPSession,
  screenshotDelayMs = 0,
  storageStateDelayMs = 0,
  pngScreenshot: Buffer = QR_PAGE_PNG,
): Page {
  cdpSessions = 0
  screenshots = 0
  let browser: Browser
  let connected = true
  const gone = new Set<() => void>()
  // Solari sessions die on their own about ten minutes in; `killSession()` is
  // how a test reproduces that, so the disconnected path is driven rather than
  // assumed.
  killSession = () => {
    connected = false
    for (const listener of gone) listener()
  }
  const browserPartial: Partial<Browser> = {
    // SAFETY: only the "disconnected" listener is kept; the returned emitter is
    // for chaining and is never used, so pointing it back at the fake is safe.
    once: ((event: string, listener: () => void) => {
      if (event === "disconnected") gone.add(listener)
      return browser
    }) as Browser["once"],
    // SAFETY: as `once`, above — an unused chaining emitter.
    off: ((_event: string, listener: () => void) => {
      gone.delete(listener)
      return browser
    }) as Browser["off"],
    isConnected: () => connected,
  }
  // SAFETY: runHandoff drives only once/off/isConnected on the browser.
  browser = browserPartial as Browser
  const contextPartial: Partial<BrowserContext> = {
    browser: () => browser,
    newCDPSession: async () => {
      cdpSessions += 1
      return cdp
    },
    storageState: async () => {
      if (storageStateDelayMs > 0) await Bun.sleep(storageStateDelayMs)
      return STORAGE
    },
  }
  // SAFETY: runHandoff drives only browser/newCDPSession/storageState here.
  const context = contextPartial as BrowserContext
  let page: Page
  const pagePartial: Partial<Page> = {
    context: () => context,
    // A live page, which is what `raiseHand` checks before it starts anything.
    isClosed: () => false,
    // SAFETY: approval mode calls screenshot() for its one frame and reads the
    // viewport for that frame's metadata; a QR scan calls it for a PNG. Neither
    // result is used as anything else.
    screenshot: (async (options?: { type?: "png" | "jpeg" }) => {
      if (screenshotDelayMs > 0) await Bun.sleep(screenshotDelayMs)
      screenshots += 1
      return options?.type === "png" ? pngScreenshot : SAMPLE_JPEG
    }) as Page["screenshot"],
    viewportSize: () => VIEWPORT,
    // SAFETY: as the browser's, above — an unused chaining emitter.
    once: (() => page) as Page["once"],
    // SAFETY: as `once`, above — an unused chaining emitter.
    off: (() => page) as Page["off"],
  }
  // SAFETY: runHandoff uses only context/once/off, plus screenshot and
  // viewportSize in approval mode, on the page.
  page = pagePartial as Page
  return page
}

test("a full handoff emits exactly one wide event with plausible fields", async () => {
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "Aurora Bank is asking for a 2FA code",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "test-handoff",
    relayColdStartMs: 123,
    logger: noopLogger,
  })

  // The agent connects and replays its state; the phone sees it.
  await until("the phone to see the reason", () =>
    human.inbox.some(
      (message) =>
        message.type === "state" && message.reason.includes("Aurora"),
    ),
  )

  // A frame leaves the fake page, crosses the real relay and reaches the phone.
  cdp.emitFrame(FRAME)
  await until("the phone to see a frame", () =>
    human.inbox.some((message) => message.type === "frame"),
  )

  // The human taps: it flows back and lands as a real CDP mouse event.
  human.send({ type: "tap", fx: 400, fy: 250 })
  await until("the tap to dispatch as a mouse event", () =>
    cdp.calls.includes("Input.dispatchMouseEvent"),
  )

  human.send({ type: "handback" })
  const end = await handoff

  expect(end.outcome).toBe("resolved")

  // The one wide event, exactly once.
  expect(events).toHaveLength(1)
  const event = events[0]
  expect(event).toBeDefined()
  if (!event) throw new Error("no event")
  expect(event.outcome).toBe("resolved")
  expect(event.handoffId).toBe("test-handoff")
  expect(event.reason).toBe("Aurora Bank is asking for a 2FA code")
  expect(event.relayColdStartMs).toBe(123)
  expect(event.durationMs).toBeGreaterThan(0)
  expect(event.framesSent).toBeGreaterThanOrEqual(1)
  expect(event.bytesSent).toBeGreaterThan(0)
  expect(event.inputsApplied).toBeGreaterThanOrEqual(1)
  expect(event.reconnects).toBe(0)
  expect(event.storageStateCaptured).toBe(true)
  expect(event.firstFrameMs ?? -1).toBeGreaterThanOrEqual(0)
  // What the caller is handed is the time the human took, frozen at the same
  // instant the event's is — not that plus the ack, the CDP detach and the
  // socket close, which the caller never waited for.
  expect(end.durationMs).toBe(event.durationMs)
  // No secret ever rides along in the wide event.
  expect(JSON.stringify(event)).not.toContain("pt_token")
})

test("a throwing onEvent callback does not break the handoff", async () => {
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "the callback is hostile",
      logger: noopLogger,
      onEvent: () => {
        throw new Error("onEvent blew up")
      },
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "throwing",
    relayColdStartMs: 5,
    logger: noopLogger,
  })

  await until("the phone to connect", () => human.inbox.length >= 0)
  human.send({ type: "abort" })

  // The handoff still settles cleanly despite the throwing callback.
  const end = await handoff
  expect(end.outcome).toBe("aborted")
})

test("an approval handoff sends one screenshot and settles on approve", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "Agent wants to submit this payment",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "approval-handoff",
    relayColdStartMs: 42,
    logger: noopLogger,
  })

  await until("the phone to see the action", () =>
    human.inbox.some(
      (message) => message.type === "state" && message.action !== undefined,
    ),
  )
  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )

  human.send({ type: "approve" })
  const end = await handoff

  expect(end.outcome).toBe("approved")
  // One screenshot, not a stream: the approval never starts a screencast, so
  // nothing arrives after the first frame either.
  expect(
    human.inbox.filter((message) => message.type === "frame"),
  ).toHaveLength(1)
  // No CDP session is opened at all: no screencast, no input, no focus probe.
  expect(cdpSessions).toBe(0)
  expect(cdp.calls).toEqual([])

  const event = events[0]
  if (!event) throw new Error("no event")
  expect(events).toHaveLength(1)
  expect(event.mode).toBe("approval")
  expect(event.outcome).toBe("approved")
  // One frame per connection, and this handoff had exactly one connection.
  expect(event.reconnects).toBe(0)
  expect(event.framesSent).toBe(1)
  expect(event.bytesSent).toBeGreaterThan(0)
  expect(event.inputsApplied).toBe(0)
  // The human never touched the page, so there is no new state to capture.
  expect(event.storageStateCaptured).toBe(false)
  expect(end.storageState).toBeUndefined()
})

test("an approval handoff ignores takeover messages that reach it anyway", async () => {
  // A takeover relay in front of an approval handoff is the mismatch the agent
  // has to survive on its own: an older or tampered relay routes tap and
  // handback, and neither may do anything here.
  const port = await startRelayProcess("takeover")
  const human = await connectHuman(port)
  const cdp = fakeCdp()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "Agent wants to submit this payment",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
    },
    timeoutMs: 1500,
    logger: noopLogger,
    url: "https://relay.example/?pt_token=x",
    handoffId: "approval-mismatch",
    relayColdStartMs: 7,
  })

  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )
  human.send({ type: "tap", fx: 400, fy: 250 })
  human.send({ type: "char", ch: "9" })
  human.send({ type: "handback" })

  // Not "resolved": a handback is not an approval, so the wait runs out.
  const end = await handoff
  expect(end.outcome).toBe("timeout")
  expect(cdp.calls).toEqual([])
})

test("a denied approval reports denied", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "Agent wants to delete the production bucket",
      action: "Delete s3://prod-invoices",
      logger: noopLogger,
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "approval-denied",
    relayColdStartMs: 9,
    logger: noopLogger,
  })

  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )
  human.send({ type: "deny" })

  const end = await handoff
  expect(end.outcome).toBe("denied")
  await until("the phone to be told how it ended", () =>
    human.inbox.some(
      (message) => message.type === "ended" && message.outcome === "denied",
    ),
  )
})

/**
 * A bare WebSocket server standing in for the relay, which cuts every
 * connection the moment it has received a frame.
 *
 * The real relay is the right peer for routing; it is the wrong one here,
 * because what is under test is what the agent puts on the wire *after* its
 * handoff is over. Terminating on every frame means a connection that carries
 * a frame can never also carry the ending — so an ending that arrives at all
 * proves the frame was withheld.
 */
interface FakeRelay {
  port: number
  /** Messages received, split by the connection they arrived on. */
  connections: RelayMessage[][]
}

async function startFrameCuttingRelay(): Promise<FakeRelay> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  const connections: RelayMessage[][] = []
  const sockets: WebSocket[] = []

  server.on("connection", (socket: WebSocket) => {
    const inbox: RelayMessage[] = []
    connections.push(inbox)
    sockets.push(socket)
    socket.on("message", (data: Buffer) => {
      // SAFETY: the only writer on this socket is the handoff under test.
      const message = JSON.parse(data.toString("utf8")) as RelayMessage
      inbox.push(message)
      if (message.type === "frame") socket.terminate()
    })
  })
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  )
  cleanups.push(() => {
    for (const socket of sockets) socket.terminate()
    server.close()
  })

  const address = server.address()
  // SAFETY: the server listens on a TCP port; `address()` only returns a
  // string for a unix socket.
  const port = (address as AddressInfo).port
  return { port, connections }
}

test("the approval screenshot is not re-published once the handoff is over", async () => {
  // The relay scrubs its replay buffer when a handoff ends, so that whoever
  // opens the link next cannot see the page. A reconnect during teardown that
  // re-sent the screenshot would undo exactly that.
  const relay = await startFrameCuttingRelay()
  const cdp = fakeCdp()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${relay.port}/`,
    options: {
      mode: "approval",
      reason: "Agent wants to submit this payment",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
    },
    // Long enough for a reconnect or two while the "human" decides, short
    // enough that the ending falls into one of them.
    timeoutMs: 1200,
    url: "https://relay.example/?pt_token=x",
    handoffId: "approval-reconnect",
    relayColdStartMs: 3,
    logger: noopLogger,
  })

  const end = await handoff
  expect(end.outcome).toBe("timeout")
  // `raiseHand` does not wait for the relay to read its ending, so this test
  // has to.
  await until("the ending to reach the relay", () =>
    relay.connections.some((inbox) =>
      inbox.some((message) => message.type === "ended"),
    ),
  )

  // Every connection that carried a frame was cut, so the one that carried the
  // ending is one the agent chose not to re-send the screenshot on.
  const ending = relay.connections.find((inbox) =>
    inbox.some((message) => message.type === "ended"),
  )
  expect(ending).toBeDefined()
  expect(ending?.filter((message) => message.type === "frame")).toEqual([])
  // It really did reconnect: the first connection was cut on the frame.
  expect(relay.connections.length).toBeGreaterThan(1)
}, 20000)

// --- 0.7.0: the human who was there and went ------------------------------

/**
 * A takeover against the real relay, with the presence grace turned down to
 * something a test can wait for. The wait itself stays long, because the whole
 * point is that the handoff ends before it.
 */
function presenceHandoff(
  port: number,
  cdp: CDPSession,
  graceMs: number,
  timeoutMs: number,
  events: HandoffEvent[],
): Promise<{ outcome: string }> {
  return runHandoff({
    page: fakePage(cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "Aurora Bank is asking for a 2FA code",
      humanGoneGraceMs: graceMs,
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    },
    timeoutMs,
    url: "https://relay.example/?pt_token=x",
    handoffId: "presence",
    relayColdStartMs: 3,
    logger: noopLogger,
  })
}

test("a human who was there and then closed the tab ends the handoff early", async () => {
  const port = await startRelayProcess()
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const human = await connectHuman(port)

  const startedAt = Date.now()
  const handoff = presenceHandoff(port, cdp.cdp, 400, 30_000, events)
  await until("the phone to see the reason", () =>
    human.inbox.some((message) => message.type === "state"),
  )
  cdp.emitFrame(FRAME)
  await until("the phone to see a frame", () =>
    human.inbox.some((message) => message.type === "frame"),
  )

  // No handback, no abort: the tab is simply gone, which before this release
  // cost the agent the whole `timeoutMs`.
  human.close()
  const end = await handoff
  const waited = Date.now() - startedAt

  // The existing outcome, deliberately: a handoff nobody finished is a
  // timeout, whether the wait ran out or the human walked away from it.
  expect(end.outcome).toBe("timeout")
  expect(waited).toBeLessThan(10_000)
  const event = events[0]
  if (!event) throw new Error("no event")
  expect(event.outcome).toBe("timeout")
  expect(event.humanSeen).toBe(true)
  expect(event.endedEarly).toBe(true)
  expect(event.humanLeftMs ?? -1).toBeGreaterThanOrEqual(0)
  expect(event.humanLeftMs ?? Infinity).toBeLessThanOrEqual(event.durationMs)
}, 20000)

test("a phone that comes back inside the grace keeps the handoff alive", async () => {
  const port = await startRelayProcess()
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const first = await connectHuman(port)

  const handoff = presenceHandoff(port, cdp.cdp, 1500, 30_000, events)
  await until("the phone to see the reason", () =>
    first.inbox.some((message) => message.type === "state"),
  )

  // The 60 s proxy cut, and the phone's own reconnect a moment later.
  first.close()
  await Bun.sleep(300)
  const second = await connectHuman(port)
  await until("the phone to see the reason again", () =>
    second.inbox.some((message) => message.type === "state"),
  )

  // Well past the grace, had it not been reset by the reconnect.
  await Bun.sleep(1800)
  second.send({ type: "handback" })
  const end = await handoff

  expect(end.outcome).toBe("resolved")
  const event = events[0]
  if (!event) throw new Error("no event")
  expect(event.humanSeen).toBe(true)
  expect(event.endedEarly).toBe(false)
}, 20000)

test("a handoff nobody ever opened waits the whole timeout", async () => {
  const port = await startRelayProcess()
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []

  const startedAt = Date.now()
  // A grace far shorter than the wait: a QR code nobody scanned must not be
  // read as a human who left, or every unattended handoff would end at once.
  const end = await presenceHandoff(port, cdp.cdp, 200, 1200, events)
  const waited = Date.now() - startedAt

  expect(end.outcome).toBe("timeout")
  expect(waited).toBeGreaterThanOrEqual(1200)
  const event = events[0]
  if (!event) throw new Error("no event")
  expect(event.humanSeen).toBe(false)
  expect(event.endedEarly).toBe(false)
  expect(event.humanLeftMs).toBeUndefined()
}, 20000)

test("a grace longer than what is left of the wait changes nothing", async () => {
  const port = await startRelayProcess()
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const human = await connectHuman(port)

  const handoff = presenceHandoff(port, cdp.cdp, 30_000, 1200, events)
  await until("the phone to see the reason", () =>
    human.inbox.some((message) => message.type === "state"),
  )
  human.close()

  const end = await handoff
  expect(end.outcome).toBe("timeout")
  const event = events[0]
  if (!event) throw new Error("no event")
  // Seen and gone, but the wait ran out first, so this is an ordinary timeout.
  expect(event.humanSeen).toBe(true)
  expect(event.endedEarly).toBe(false)
  expect(event.humanLeftMs ?? -1).toBeGreaterThanOrEqual(0)
}, 20000)

test("an approval whose human walks away ends early too", async () => {
  const port = await startRelayProcess("approval")
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const human = await connectHuman(port)

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Transfer EUR 12,430.00 to Acme GmbH",
      humanGoneGraceMs: 400,
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 30_000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "presence-approval",
    relayColdStartMs: 3,
    logger: noopLogger,
  })

  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )
  // Leaving a decision open is exactly as informative as leaving a browser
  // open: nobody is coming back, and the agent should not wait five minutes.
  human.close()

  const end = await handoff
  expect(end.outcome).toBe("timeout")
  const event = events[0]
  if (!event) throw new Error("no event")
  expect(event.mode).toBe("approval")
  expect(event.endedEarly).toBe(true)
  expect(event.humanSeen).toBe(true)
}, 20000)

test("a watch that has been stopped records nothing and arms nothing", () => {
  let gone = 0
  const watch = watchPresence(50, Date.now(), () => {
    gone += 1
  })
  watch.saw(true, true, 0)
  watch.stop()
  // The ordinary teardown: the phone closes its socket the instant it renders
  // the ending, the relay reports that, and the report arrives while the
  // agent's own socket is still finishing its close handshake. It is not a
  // departure from a handoff that is already over.
  watch.saw(false, true, 0)

  expect(watch.leftMs()).toBeUndefined()
  return Bun.sleep(150).then(() => {
    expect(gone).toBe(0)
  })
})

test("a stopped watch leaves no timer holding the process open", async () => {
  // The cost of the bug this pins was invisible from inside the process: the
  // stale timer's callback did nothing, it just kept the event loop alive for
  // the whole grace — a minute of hang at exit for a CLI agent, after
  // `raiseHand` had already resolved. So the assertion is the exit itself.
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const probe = Bun.spawn(
    [
      "bun",
      "-e",
      'import { watchPresence } from "./src/core/raise-hand"; const w = watchPresence(60_000, Date.now(), () => undefined); w.saw(true, true, 0); w.stop(); w.saw(false, true, 0)',
    ],
    { cwd: root, stdout: "ignore", stderr: "ignore" },
  )
  const outcome = await Promise.race([
    probe.exited,
    Bun.sleep(6000).then(() => "still running after 6s" as const),
  ])
  probe.kill()
  expect(outcome).toBe(0)
}, 15000)

test("a human who leaves after answering never left", async () => {
  const port = await startRelayProcess()
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const human = await connectHuman(port)

  const handoff = presenceHandoff(port, cdp.cdp, 60_000, 30_000, events)
  await until("the phone to see the reason", () =>
    human.inbox.some((message) => message.type === "state"),
  )
  human.send({ type: "handback" })
  // What a real phone does the moment it has answered.
  human.close()

  const end = await handoff
  expect(end.outcome).toBe("resolved")
  const event = events[0]
  if (!event) throw new Error("no event")
  expect(event.humanSeen).toBe(true)
  expect(event.endedEarly).toBe(false)
  // Not a departure: it happened after the handoff was over, and reporting it
  // would tell an alert that watches this field the opposite of the truth.
  expect(event.humanLeftMs).toBeUndefined()
}, 20000)

test("the ending is acknowledged by the relay before the sandbox could be killed", async () => {
  const port = await startRelayProcess()
  const cdp = fakeCdp()
  const lines: string[] = []
  const recording: Logger = {
    debug: () => undefined,
    info: (event, fields) => lines.push(`${event} ${JSON.stringify(fields)}`),
    warn: () => undefined,
    error: () => undefined,
  }

  const human = await connectHuman(port)
  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: { reason: "Aurora Bank is asking for a 2FA code" },
    timeoutMs: 10_000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "ack",
    relayColdStartMs: 3,
    logger: recording,
  })
  await until("the phone to see the reason", () =>
    human.inbox.some((message) => message.type === "state"),
  )
  human.send({ type: "abort" })
  await handoff

  // The line the live e2e reads its timing off — and its `acked` field is the
  // whole point: `false` there means the ending raced the kill exactly as it
  // did before this release, which a test that only looks for the event name
  // would call a pass.
  const ack = lines.find((line) => line.startsWith("ended_ack "))
  expect(ack ?? "no ended_ack line").toContain('"acked":true')
}, 20000)

/** Evict the handoff's agent socket the way a second agent process would. */
async function forceAgentOutage(port: number): Promise<void> {
  const impostor = new WebSocket(`ws://127.0.0.1:${port}/ws?role=agent`)
  await new Promise<void>((resolve, reject) => {
    impostor.once("open", () => resolve())
    impostor.once("error", reject)
  })
  // Closing it leaves no agent at all, which is the state under test: the
  // handoff's own socket is down and backing off.
  impostor.close()
}

test("a departure the agent only hears about later is counted from when it happened", () => {
  let gone = 0
  // A handoff that started five seconds ago.
  const watch = watchPresence(1_000, Date.now() - 5_000, () => {
    gone += 1
  })
  // The relay's report to a reconnecting agent: nobody is here, somebody was,
  // and that has been true for 800 ms.
  watch.saw(false, true, 800)

  expect(watch.everSeen()).toBe(true)
  expect(watch.leftMs() ?? -1).toBeGreaterThanOrEqual(4_100)
  expect(watch.leftMs() ?? -1).toBeLessThanOrEqual(4_300)
  // 200 ms of the grace are left, and the floor gives the reconnect a beat to
  // deliver whatever else it is holding first.
  return Bun.sleep(120)
    .then(() => {
      expect(gone).toBe(0)
      return Bun.sleep(400)
    })
    .then(() => {
      expect(gone).toBe(1)
    })
})

test("a whole visit during an agent outage still counts, and the grace runs from the real departure", async () => {
  const port = await startRelayProcess()
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []

  const startedAt = Date.now()
  const handoff = presenceHandoff(port, cdp.cdp, 1500, 20_000, events)
  await Bun.sleep(300)
  await forceAgentOutage(port)

  // The human opens the link, sees a handoff nobody is driving, and closes it
  // — all of it while the agent's socket is down and backing off. Both
  // announcements find no agent; only the history the relay keeps survives.
  const visitor = await connectHuman(port)
  await Bun.sleep(80)
  const leftAt = Date.now()
  visitor.close()

  const end = await handoff
  expect(end.outcome).toBe("timeout")
  const event = events[0]
  if (!event) throw new Error("no event")
  expect(event.humanSeen).toBe(true)
  expect(event.endedEarly).toBe(true)
  // The grace ran from the departure, not from the reconnect that reported it.
  expect(Date.now() - leftAt).toBeLessThan(4_000)
  expect(event.humanLeftMs ?? -1).toBeGreaterThan(leftAt - startedAt - 400)
  expect(event.humanLeftMs ?? -1).toBeLessThan(leftAt - startedAt + 400)
}, 30000)

test("an answer given during an agent outage still resolves the handoff", async () => {
  const port = await startRelayProcess()
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []

  // A grace shorter than the outage, so the departure the reconnecting agent
  // hears about is already past it. The answer is one frame behind that
  // report, and it must not lose a race to a timer.
  const handoff = presenceHandoff(port, cdp.cdp, 400, 20_000, events)
  await Bun.sleep(300)
  await forceAgentOutage(port)

  const visitor = await connectHuman(port)
  visitor.send({ type: "handback" })
  await Bun.sleep(50)
  visitor.close()

  const end = await handoff
  expect(end.outcome).toBe("resolved")
  const event = events[0]
  if (!event) throw new Error("no event")
  expect(event.humanSeen).toBe(true)
  expect(event.endedEarly).toBe(false)
}, 30000)

test("input that arrives after the grace ended the handoff never reaches the page", async () => {
  const port = await startRelayProcess()
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  // A slow screenshot, so the QR scan below is still in flight when the grace
  // settles the handoff: teardown waits for it, and that wait is the window in
  // which a phone that comes back could still be routed to a live page.
  const handoff = runHandoff({
    page: fakePage(cdp.cdp, 1500),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "Aurora Bank is asking for a 2FA code",
      humanGoneGraceMs: 300,
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 30_000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "late-input",
    relayColdStartMs: 3,
    logger: noopLogger,
  })

  const human = await connectHuman(port)
  await until("the phone to see the reason", () =>
    human.inbox.some((message) => message.type === "state"),
  )
  cdp.emitFrame(FRAME)
  await until("the phone to see a frame", () =>
    human.inbox.some((message) => message.type === "frame"),
  )
  human.send({ type: "tap", fx: 400, fy: 250 })
  await until("the tap to dispatch as a mouse event", () =>
    cdp.calls.includes("Input.dispatchMouseEvent"),
  )
  const dispatches = (): number =>
    cdp.calls.filter((call) => call === "Input.dispatchMouseEvent").length
  const before = dispatches()

  human.send({ type: "scanqr" })
  await Bun.sleep(100)
  // Gone, and the grace ends the handoff while the scan is still in flight.
  human.close()
  await Bun.sleep(600)

  // Somebody opens the link again and taps at a page the agent has already
  // moved on from. Before 0.7.0 the only guard here was "a terminal message
  // arrived", and a grace timeout is not one.
  const late = await connectHuman(port)
  for (let i = 0; i < 5; i++) late.send({ type: "tap", fx: 100, fy: 100 })

  const end = await handoff
  expect(end.outcome).toBe("timeout")
  expect(dispatches()).toBe(before)
  expect(events[0]?.inputsApplied).toBe(1)
}, 30000)

test("a grace that is not a usable number is refused before anything is created", async () => {
  const asking = raiseHand(fakePage(fakeCdp().cdp), {
    reason: "Aurora Bank is asking for a 2FA code",
    // Below the floor: a grace this short would end a handoff on the gap
    // between a proxy cut and the phone's own reconnect.
    humanGoneGraceMs: 10,
    baseUrl: CLOSED_PORT,
    logger: noopLogger,
  })

  await expect(asking).rejects.toMatchObject({
    name: "HandraiseError",
    code: "invalid_option",
  })

  const infinite = raiseHand(fakePage(fakeCdp().cdp), {
    reason: "Aurora Bank is asking for a 2FA code",
    humanGoneGraceMs: Number.POSITIVE_INFINITY,
    baseUrl: CLOSED_PORT,
    logger: noopLogger,
  })
  await expect(infinite).rejects.toMatchObject({
    name: "HandraiseError",
    code: "invalid_option",
  })

  // One past the largest delay a Node timer can hold. It is finite and far
  // above the floor, and Node silently collapses it to 1 ms — a request for a
  // three-week grace that ends the handoff on the first blink.
  const overflowed = raiseHand(fakePage(fakeCdp().cdp), {
    reason: "Aurora Bank is asking for a 2FA code",
    humanGoneGraceMs: 2_147_483_648,
    baseUrl: CLOSED_PORT,
    logger: noopLogger,
  })
  await expect(overflowed).rejects.toMatchObject({
    name: "HandraiseError",
    code: "invalid_option",
  })

  // And the last value that is still a timer: accepted, so the guard fails on
  // the relay rather than on the option.
  const largest = raiseHand(fakePage(fakeCdp().cdp), {
    reason: "Aurora Bank is asking for a 2FA code",
    humanGoneGraceMs: 2_147_483_647,
    apiKey: "not-a-real-key",
    baseUrl: CLOSED_PORT,
    logger: noopLogger,
  })
  await expect(largest).rejects.toMatchObject({
    name: "HandraiseError",
    code: "relay_start_failed",
  })
}, 20000)

test("an approval with a blank action is refused before a relay is started", async () => {
  // The tool guards this for the model; the library has to guard it for every
  // caller, and here is the one place raiseHand may still throw — no URL
  // exists yet, so nobody has been asked for anything.
  const asking = raiseHand(fakePage(fakeCdp().cdp), {
    mode: "approval",
    reason: "The agent may not move money without a human",
    action: "   ",
    // bun loads .env, so a key is usually in the environment when this runs.
    // A closed port is what keeps a regression here from creating a real
    // sandbox instead of failing.
    baseUrl: CLOSED_PORT,
    logger: noopLogger,
  })

  // The code is the contract; the sentence is for whoever reads the log.
  await expect(asking).rejects.toMatchObject({
    name: "HandraiseError",
    code: "empty_action",
  })
})

test("an unknown mode is refused before anything is created", async () => {
  // `HandoffMode` closes this for TypeScript callers. This package ships as
  // JavaScript, the mode reaches the relay's command line, and an unknown one
  // would otherwise fall open as a takeover — with a live input path.
  // `Object.assign` is how a test written in TypeScript produces the value a
  // JavaScript caller would pass.
  const options: RaiseHandOptions = {
    reason: "The agent may not move money without a human",
    baseUrl: CLOSED_PORT,
    logger: noopLogger,
  }
  Object.assign(options, { mode: "approval; touch /tmp/handraise-pwned" })

  const asking = raiseHand(fakePage(fakeCdp().cdp), options)
  await expect(asking).rejects.toMatchObject({
    name: "HandraiseError",
    code: "invalid_mode",
  })
})

test("a handoff without an API key is refused, with a code", async () => {
  // `apiKey: ""` rather than deleting the environment variable: bun loads
  // `.env`, and a test that mutates `process.env` would decide the outcome of
  // whatever runs next to it.
  const asking = raiseHand(fakePage(fakeCdp().cdp), {
    reason: "Aurora Bank is asking for a 2FA code",
    apiKey: "",
    baseUrl: CLOSED_PORT,
    logger: noopLogger,
  })

  await expect(asking).rejects.toMatchObject({
    name: "HandraiseError",
    code: "missing_api_key",
  })
})

/** Ask for a handoff on `page`, against a gateway that cannot answer. */
function askOn(page: Page): Promise<HandoffResult> {
  return raiseHand(page, {
    reason: "Aurora Bank is asking for a 2FA code",
    apiKey: "not-a-real-key",
    baseUrl: CLOSED_PORT,
    logger: noopLogger,
  })
}

/**
 * A page with exactly what the pre-flight guard reads, and modelled on what a
 * real Playwright page does: `context()` keeps answering on a closed page (it
 * is a field read), so `isClosed()` is the only thing that can report one.
 */
function pageThatIs(closed: boolean, connected: boolean): Page {
  const browserPartial: Partial<Browser> = { isConnected: () => connected }
  const contextPartial: Partial<BrowserContext> = {
    // SAFETY: the guard reads only `browser()` off the context.
    browser: () => browserPartial as Browser,
  }
  const pagePartial: Partial<Page> = {
    isClosed: () => closed,
    // SAFETY: the guard reads only `context().browser()` on the page.
    context: () => contextPartial as BrowserContext,
  }
  // SAFETY: the guard touches `isClosed` and `context` and nothing else; it
  // refuses before any other member could be reached.
  return pagePartial as Page
}

test("a closed page is refused before a sandbox is created", async () => {
  // The agent closed the page — or its own step raced a `page.close()` —
  // while the browser is still connected. Starting a relay for it would spend
  // a sandbox and a person's attention on a page nobody can drive.
  await expect(askOn(pageThatIs(true, true))).rejects.toMatchObject({
    name: "HandraiseError",
    code: "browser_unusable",
  })
})

test("a page whose state cannot be read at all is refused too", async () => {
  // Not a Playwright page any more: a stub, a proxy over a dead CDP
  // connection, a page from a browser object that has been torn down. The
  // guard may not turn that into an unhandled TypeError.
  const broken: Partial<Page> = {
    isClosed: () => {
      throw new Error("Target page, context or browser has been closed")
    },
  }

  // SAFETY: the refusal under test reads only `isClosed()`, which is the one
  // member this page has.
  await expect(askOn(broken as Page)).rejects.toMatchObject({
    name: "HandraiseError",
    code: "browser_unusable",
  })
})

test("a browser whose liveness accessor throws is refused too", async () => {
  // The last unguarded read in the pre-flight check: a browser proxy — a
  // remote-CDP wrapper, a pooled session object, a page handed over between
  // processes — whose `isConnected()` throws instead of answering. Outside the
  // `try` that would leave `raiseHand` rejecting with a plain `Error`, which
  // is exactly what typed codes exist to stop.
  const browserPartial: Partial<Browser> = {
    isConnected: () => {
      throw new Error("Browser has been closed")
    },
  }
  const contextPartial: Partial<BrowserContext> = {
    // SAFETY: the guard reads only `browser()` off the context.
    browser: () => browserPartial as Browser,
  }
  const pagePartial: Partial<Page> = {
    isClosed: () => false,
    // SAFETY: the guard reads only `context().browser()` on the page.
    context: () => contextPartial as BrowserContext,
  }

  // SAFETY: the guard touches `isClosed` and `context` and nothing else.
  await expect(askOn(pagePartial as Page)).rejects.toMatchObject({
    name: "HandraiseError",
    code: "browser_unusable",
  })
})

test("an open page whose browser has disconnected is refused too", async () => {
  // The Solari session hit its ~10-minute hard lifetime while the agent was
  // still working. The page is not closed and `context()` answers — only the
  // browser is gone, which is the case this guard exists for.
  await expect(askOn(pageThatIs(false, false))).rejects.toMatchObject({
    name: "HandraiseError",
    code: "browser_unusable",
  })
})

// --- Channels ------------------------------------------------------------
//
// A channel is an in-process object handraise notifies when the handoff URL
// exists. In approval mode it also gets the screenshot and can answer without
// the phone, through the same settle path a relay `approve` takes.

interface ChannelRecorder {
  channel: HandoffChannel
  /** Every handoff this channel was notified about, in order. */
  seen: ChannelHandoff[]
}

/** A channel that records what it was handed, and never answers by itself. */
function recordingChannel(): ChannelRecorder {
  const seen: ChannelHandoff[] = []
  return {
    channel: {
      notify: (handoff) => {
        seen.push(handoff)
      },
    },
    seen,
  }
}

interface LoggerRecorder {
  logger: Logger
  /** The event names passed to `warn`, in order. */
  warnings: string[]
}

/** A logger that keeps its warnings, so a swallowed failure is still provable. */
function recordingLogger(): LoggerRecorder {
  const warnings: string[] = []
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (event) => {
        warnings.push(event)
      },
      error: () => undefined,
    },
    warnings,
  }
}

test("a channel that approves settles the handoff and the phone is told", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
      channels: [
        {
          notify: (raised) => {
            if (raised.mode === "approval") raised.answer("approve")
          },
        },
      ],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "channel-approve",
    relayColdStartMs: 11,
    logger: noopLogger,
  })

  const end = await handoff
  expect(end.outcome).toBe("approved")

  const event = events[0]
  if (!event) throw new Error("no event")
  expect(event.outcome).toBe("approved")
  expect(event.answeredVia).toBe("channel")

  // The phone was never asked, and still sees the handoff end: the relay gets
  // the same `ended` message an answer from the phone would have produced.
  await until("the phone to be told how it ended", () =>
    human.inbox.some(
      (message) => message.type === "ended" && message.outcome === "approved",
    ),
  )
})

test("the first answer wins: the phone denies, a later channel approve is refused", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not delete production data",
      action: "Delete s3://prod-invoices",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "relay-wins",
    relayColdStartMs: 12,
    logger: noopLogger,
  })

  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )
  human.send({ type: "deny" })

  const end = await handoff
  expect(end.outcome).toBe("denied")
  expect(events[0]?.answeredVia).toBe("relay")

  // The channel was notified, and its answer arrives too late.
  const raised = recorder.seen[0]
  if (raised?.mode !== "approval") throw new Error("no approval handoff")
  expect(raised.answer("approve")).toBe(false)
})

test("the first answer wins the other way round: the channel denies first", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not delete production data",
      action: "Delete s3://prod-invoices",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "channel-wins",
    relayColdStartMs: 13,
    logger: noopLogger,
  })

  await until("the channel to be notified", () => recorder.seen.length === 1)
  const raised = recorder.seen[0]
  if (raised?.mode !== "approval") throw new Error("no approval handoff")

  // The channel answers first, then the phone tries to overturn it.
  expect(raised.answer("deny")).toBe(true)
  human.send({ type: "approve" })

  const end = await handoff
  expect(end.outcome).toBe("denied")
  expect(events[0]?.answeredVia).toBe("channel")
  // And a second answer from the channel itself is refused just the same.
  expect(raised.answer("deny")).toBe(false)
})

test("a channel that throws is logged and does not touch the handoff", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const recorder = recordingLogger()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: recorder.logger,
      channels: [
        {
          notify: () => {
            throw new Error("the chat API is down")
          },
        },
        // A rejected promise is the same failure one tick later, and the
        // channel behind the broken one still has to be notified.
        { notify: () => Promise.reject(new Error("and so is the other one")) },
      ],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "channel-throws",
    relayColdStartMs: 14,
    logger: recorder.logger,
  })

  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )
  human.send({ type: "approve" })

  const end = await handoff
  expect(end.outcome).toBe("approved")
  expect(
    recorder.warnings.filter((event) => event === "channel_failed"),
  ).toHaveLength(2)
})

test("a takeover channel gets the link and nothing to answer with", async () => {
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "Aurora Bank is asking for a 2FA code",
      logger: noopLogger,
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://takeover.example/?pt_token=secret",
    handoffId: "takeover-channel",
    relayColdStartMs: 15,
    logger: noopLogger,
  })

  await until("the channel to be notified", () => recorder.seen.length === 1)
  const raised = recorder.seen[0]
  if (!raised) throw new Error("the channel was not notified")
  expect(raised.mode).toBe("takeover")
  expect(raised.url).toBe("https://takeover.example/?pt_token=secret")
  expect(raised.reason).toBe("Aurora Bank is asking for a 2FA code")
  expect(raised.handoffId).toBe("takeover-channel")
  // There is no moment to show and no question to answer in a takeover, so
  // neither field exists — the union says so, and the value agrees.
  expect("screenshot" in raised).toBe(false)
  expect("answer" in raised).toBe(false)

  human.send({ type: "handback" })
  expect((await handoff).outcome).toBe("resolved")
})

test("an approval channel gets the same JPEG bytes the phone gets", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "channel-bytes",
    relayColdStartMs: 16,
    logger: noopLogger,
  })

  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )
  const frame = human.inbox.find((message) => message.type === "frame")
  if (frame?.type !== "frame") throw new Error("no frame reached the phone")

  const raised = recorder.seen[0]
  if (raised?.mode !== "approval") throw new Error("no approval handoff")
  expect(raised.action).toBe("Submit $12,430 vendor payment to Acme GmbH")
  // Byte for byte the picture the human on the phone is looking at, so the two
  // cannot be shown different things and asked the same question.
  expect(raised.screenshot).toEqual(Buffer.from(frame.data, "base64"))
  expect(raised.screenshot).toEqual(SAMPLE_JPEG)

  human.send({ type: "deny" })
  expect((await handoff).outcome).toBe("denied")
})

test("a handoff that ends before the screenshot lands is never announced", async () => {
  // The window between "take the screenshot" and "send it": a round trip to
  // the browser, during which the page can close or the wait can run out.
  // `sendApprovalFrame` already refuses to put a frame on the wire after that;
  // a channel that posted anyway would leave live buttons under a request that
  // no longer exists, and the first press would be told "already decided".
  const port = await startRelayProcess("approval")
  await connectHuman(port)
  const cdp = fakeCdp()
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp, 250),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      channels: [recorder.channel],
    },
    // Runs out while the screenshot above is still being taken.
    timeoutMs: 1,
    url: "https://relay.example/?pt_token=x",
    handoffId: "settled-before-announce",
    relayColdStartMs: 17,
    logger: noopLogger,
  })

  const end = await handoff
  expect(end.outcome).toBe("timeout")
  expect(recorder.seen).toEqual([])
})

test("a takeover handback carries no answeredVia", async () => {
  // A handback and a give-up go through the same `answerHandoff` as an
  // approval answer, so `answeredVia` is set on them too. The wide event only
  // carries it where it means something: "who said yes or no". This is the
  // guard that keeps it off every takeover event.
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "Aurora Bank is asking for a 2FA code",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "takeover-answered-via",
    relayColdStartMs: 18,
    logger: noopLogger,
  })

  await until("the phone to connect", () => human.inbox.length >= 0)
  human.send({ type: "handback" })
  expect((await handoff).outcome).toBe("resolved")

  const event = events[0]
  if (!event) throw new Error("no event")
  expect(event.answeredVia).toBeUndefined()
  expect(JSON.stringify(event)).not.toContain("answeredVia")
})

// --- The boundaries the ADR claims, as failing-first tests ---------------

test("an answer that arrives after a timeout is refused and emits nothing", async () => {
  const port = await startRelayProcess("approval")
  await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
      channels: [recorder.channel],
    },
    timeoutMs: 400,
    url: "https://relay.example/?pt_token=x",
    handoffId: "late-after-timeout",
    relayColdStartMs: 19,
    logger: noopLogger,
  })

  const end = await handoff
  expect(end.outcome).toBe("timeout")
  expect(events).toHaveLength(1)

  // A channel that was notified before the wait ran out still holds a live
  // `answer`. It has to be inert: the caller has already been told `timeout`
  // and has moved on.
  const raised = recorder.seen[0]
  if (raised?.mode !== "approval") throw new Error("no approval handoff")
  expect(raised.answer("approve")).toBe(false)
  await Bun.sleep(50)
  expect(events).toHaveLength(1)
  expect(events[0]?.outcome).toBe("timeout")
  expect(events[0]?.answeredVia).toBeUndefined()
})

test("an answer that arrives after the session died is refused and emits nothing", async () => {
  const port = await startRelayProcess("approval")
  await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "late-after-disconnect",
    relayColdStartMs: 20,
    logger: noopLogger,
  })

  await until("the channel to be notified", () => recorder.seen.length === 1)
  killSession()

  const end = await handoff
  expect(end.outcome).toBe("disconnected")
  expect(events).toHaveLength(1)

  const raised = recorder.seen[0]
  if (raised?.mode !== "approval") throw new Error("no approval handoff")
  expect(raised.answer("deny")).toBe(false)
  await Bun.sleep(50)
  expect(events).toHaveLength(1)
  expect(events[0]?.outcome).toBe("disconnected")
})

test("a session that dies during the screenshot notifies no channel", async () => {
  // The timeout half of this window is covered above; this is the other way
  // it closes, and the one that actually happened in the field — a Solari
  // session hitting its hard lifetime mid-capture.
  const port = await startRelayProcess("approval")
  await connectHuman(port)
  const cdp = fakeCdp()
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp, 250),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "died-mid-screenshot",
    relayColdStartMs: 21,
    logger: noopLogger,
  })

  // While `page.screenshot()` is still in flight.
  await Bun.sleep(40)
  killSession()

  expect((await handoff).outcome).toBe("disconnected")
  expect(recorder.seen).toEqual([])
})

test("a channel that mutates its screenshot cannot change what the phone got", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "buffer-isolation",
    relayColdStartMs: 22,
    logger: noopLogger,
  })

  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )
  const raised = recorder.seen[0]
  if (raised?.mode !== "approval") throw new Error("no approval handoff")

  // A channel gets a Buffer, and a Buffer is writable. An adapter that
  // compresses or watermarks in place must not be able to change the picture
  // the human on the phone is deciding on.
  raised.screenshot.fill(0)

  const frame = human.inbox.find((message) => message.type === "frame")
  if (frame?.type !== "frame") throw new Error("no frame reached the phone")
  expect(Buffer.from(frame.data, "base64")).toEqual(SAMPLE_JPEG)

  human.send({ type: "approve" })
  expect((await handoff).outcome).toBe("approved")
})

test("a channel whose notify never settles does not hold up the handoff", async () => {
  // `notify` is not awaited, and this is what that sentence has to mean: a
  // chat API that accepts the request and never answers costs the handoff
  // nothing. A regression that awaited it would hang here until the test
  // timeout rather than fail an assertion, which is the loudest failure this
  // boundary has.
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()

  const startedAt = Date.now()
  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      channels: [{ notify: () => new Promise<void>(() => undefined) }],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "never-settles",
    relayColdStartMs: 23,
    logger: noopLogger,
  })

  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )
  human.send({ type: "approve" })
  expect((await handoff).outcome).toBe("approved")
  expect(Date.now() - startedAt).toBeLessThan(4000)
})

test("a takeover ChannelHandoff has no answer and no screenshot, at compile time", () => {
  // The runtime shape is asserted elsewhere with `in`. This is the other half:
  // the union is what stops an adapter from writing `handoff.answer(...)` on a
  // takeover in the first place, and `tsc --noEmit` covers this file, so a
  // union that quietly grew those members would fail the typecheck here —
  // `@ts-expect-error` is an error of its own when there is no error to expect.
  const takeover: TakeoverChannelHandoff = {
    mode: "takeover",
    handoffId: "compile-negative",
    url: "https://relay.example/?pt_token=x",
    reason: "Aurora Bank is asking for a 2FA code",
    settled: Promise.resolve("resolved"),
  }
  // @ts-expect-error `answer` exists only on the approval member of the union.
  const answer = takeover.answer
  // @ts-expect-error `screenshot` exists only on the approval member.
  const screenshot = takeover.screenshot
  expect(answer).toBeUndefined()
  expect(screenshot).toBeUndefined()

  // And through the union itself, which is what an adapter actually receives.
  const handoff: ChannelHandoff = takeover
  // @ts-expect-error narrow on `mode` before reaching for an approval field.
  const unnarrowed = handoff.action
  expect(unnarrowed).toBeUndefined()
})

// --- `settled`: the signal a channel has to have -------------------------

test("settled resolves with the outcome when the phone answers", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "settled-relay",
    relayColdStartMs: 24,
    logger: noopLogger,
  })

  await until("the channel to be notified", () => recorder.seen.length === 1)
  const raised = recorder.seen[0]
  if (!raised) throw new Error("the channel was not notified")

  human.send({ type: "deny" })
  expect(await handoff).toMatchObject({ outcome: "denied" })
  // This is the whole point: the channel is told the phone answered, without
  // having been the one who was asked.
  expect(await raised.settled).toBe("denied")
  // And it stays resolved — an adapter may await it long after the fact.
  expect(await raised.settled).toBe("denied")
})

test("settled resolves when the channel itself answers", async () => {
  const port = await startRelayProcess("approval")
  await connectHuman(port)
  const cdp = fakeCdp()
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "settled-channel",
    relayColdStartMs: 25,
    logger: noopLogger,
  })

  await until("the channel to be notified", () => recorder.seen.length === 1)
  const raised = recorder.seen[0]
  if (raised?.mode !== "approval") throw new Error("no approval handoff")
  expect(raised.answer("approve")).toBe(true)

  expect((await handoff).outcome).toBe("approved")
  expect(await raised.settled).toBe("approved")
})

test("settled resolves on a timeout and on a dead session", async () => {
  const port = await startRelayProcess("approval")
  await connectHuman(port)
  const cdp = fakeCdp()
  const timedOut = recordingChannel()

  const waiting = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "nobody is going to answer this one",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      channels: [timedOut.channel],
    },
    timeoutMs: 400,
    url: "https://relay.example/?pt_token=x",
    handoffId: "settled-timeout",
    relayColdStartMs: 26,
    logger: noopLogger,
  })
  await until("the channel to be notified", () => timedOut.seen.length === 1)
  expect((await waiting).outcome).toBe("timeout")
  expect(await timedOut.seen[0]?.settled).toBe("timeout")

  const secondPort = await startRelayProcess("approval")
  await connectHuman(secondPort)
  const dead = recordingChannel()
  const dying = runHandoff({
    page: fakePage(fakeCdp().cdp),
    agentWsUrl: `ws://127.0.0.1:${secondPort}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "the session is about to die",
      action: "Submit $12,430 vendor payment to Acme GmbH",
      logger: noopLogger,
      channels: [dead.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "settled-disconnected",
    relayColdStartMs: 27,
    logger: noopLogger,
  })
  await until("the channel to be notified", () => dead.seen.length === 1)
  killSession()
  expect((await dying).outcome).toBe("disconnected")
  expect(await dead.seen[0]?.settled).toBe("disconnected")
})

test("every channel of one handoff gets the same settled promise", async () => {
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const first = recordingChannel()
  const second = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "Aurora Bank is asking for a 2FA code",
      logger: noopLogger,
      channels: [first.channel, second.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "settled-shared",
    relayColdStartMs: 28,
    logger: noopLogger,
  })

  await until(
    "both channels to be notified",
    () => first.seen.length === 1 && second.seen.length === 1,
  )
  // One handoff, one ending: two adapters must not be able to see different
  // ones, and a takeover channel gets it too — it posted a bearer link that
  // stops working when this resolves.
  expect(first.seen[0]?.settled).toBe(second.seen[0]?.settled)

  human.send({ type: "handback" })
  expect((await handoff).outcome).toBe("resolved")
  expect(await first.seen[0]?.settled).toBe("resolved")
})

test("settled reports the outcome the caller gets, not the one the human gave", async () => {
  // The one path where those differ: a handback wins the promise, and the
  // Solari session hits its ~10-minute hard death while the cookies are being
  // captured. `raiseHand` reports `disconnected` rather than a dead
  // "resolved" — and a channel that had been told "resolved" would post the
  // wrong ending into a chat that outlives the process.
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const recorder = recordingChannel()

  const handoff = runHandoff({
    page: fakePage(cdp.cdp, 0, 300),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "Aurora Bank is asking for a 2FA code",
      logger: noopLogger,
      channels: [recorder.channel],
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "settled-final-outcome",
    relayColdStartMs: 29,
    logger: noopLogger,
  })

  await until("the channel to be notified", () => recorder.seen.length === 1)
  human.send({ type: "handback" })
  // While `storageState()` is in flight: the handback has already settled the
  // handoff, so this only changes what `isConnected()` says afterwards.
  await Bun.sleep(120)
  killSession()

  const end = await handoff
  expect(end.outcome).toBe("disconnected")
  expect(end.storageState).toBeUndefined()
  expect(await recorder.seen[0]?.settled).toBe("disconnected")
})

test("a logger that throws does not break the handoff", async () => {
  // `logger` is a public option and it is the caller's object: a pino instance
  // over a closed transport throws. Every call handraise makes to it sits on a
  // failure path or inside a promise callback, so a throw would either lose
  // the outcome (the wide event is logged before it is returned) or reject a
  // promise nobody awaits, and node ends the process for that.
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const down = (): never => {
    throw new Error("logger is down (EPIPE)")
  }
  const hostile: Logger = { debug: down, info: down, warn: down, error: down }
  const events: HandoffEvent[] = []

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "the logger is hostile",
      logger: hostile,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "hostile-logger",
    relayColdStartMs: 5,
    logger: hostile,
  })

  await until("the phone to connect", () => human.inbox.length >= 0)
  human.send({ type: "handback" })

  const end = await handoff
  expect(end.outcome).toBe("resolved")
  // The wide event still reaches the caller: `logger.info` throwing must not
  // take `onEvent` with it.
  expect(events).toHaveLength(1)
})

test("a logger whose methods reject does not break the handoff either", async () => {
  // The same option, one shape further out: `debug(event, fields): void`
  // accepts an `async` implementation, so the failure arrives as a rejected
  // promise nobody holds rather than as a throw. Unhandled, that ends the
  // agent's process mid-handoff — before the relay sandbox is released, which
  // leaves a public URL and its last frame reachable until the idle timeout.
  //
  // The gate here is the runner: `bun test` fails a test that leaves an
  // unhandled rejection behind, which is how this was watched failing against
  // the unfixed wrapper. The listener below is NOT that gate — bun claims the
  // rejection first and never calls it, so `unhandled` stays empty either way.
  // It is kept because it costs nothing and states the invariant for a runner
  // that only warns; do not read it as the thing that catches a regression.
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const unhandled: string[] = []
  const record = (cause: unknown): void => {
    unhandled.push(String(cause))
  }
  process.on("unhandledRejection", record)
  try {
    let calls = 0
    const down = async (): Promise<never> => {
      calls += 1
      throw new Error("log shipper is gone (async)")
    }
    const rejecting: Logger = {
      debug: down,
      info: down,
      warn: down,
      error: down,
    }
    const events: HandoffEvent[] = []

    const handoff = runHandoff({
      page: fakePage(cdp.cdp),
      agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
      options: {
        reason: "the logger ships its lines over a socket that went away",
        logger: rejecting,
        onEvent: (event) => events.push(event),
      },
      timeoutMs: 5000,
      url: "https://relay.example/?pt_token=x",
      handoffId: "async-rejecting-logger",
      relayColdStartMs: 5,
      logger: rejecting,
    })

    await until("the phone to connect", () => human.inbox.length >= 0)
    human.send({ type: "handback" })

    const end = await handoff
    expect(end.outcome).toBe("resolved")
    // The wide event still reaches the caller, and the logger was really
    // called — a containment that stopped logging would pass vacuously.
    expect(events).toHaveLength(1)
    expect(calls).toBeGreaterThan(0)

    // Long enough for the loop turn on which an unhandled rejection is
    // reported, after the handoff has fully torn down. Inert under bun — see
    // the note above the listener.
    await Bun.sleep(50)
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", record)
  }
})

test("a logger that throws does not break the handoff", async () => {
  // `logger` is a public option and it is the caller's object: a pino instance
  // over a closed transport throws. Every call handraise makes to it sits on a
  // failure path or inside a promise callback, so a throw would either lose
  // the outcome (the wide event is logged before it is returned) or reject a
  // promise nobody awaits, and node ends the process for that.
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const down = (): never => {
    throw new Error("logger is down (EPIPE)")
  }
  const hostile: Logger = { debug: down, info: down, warn: down, error: down }
  const events: HandoffEvent[] = []

  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "the logger is hostile",
      logger: hostile,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "hostile-logger",
    relayColdStartMs: 5,
    logger: hostile,
  })

  await until("the phone to connect", () => human.inbox.length >= 0)
  human.send({ type: "handback" })

  const end = await handoff
  expect(end.outcome).toBe("resolved")
  // The wide event still reaches the caller: `logger.info` throwing must not
  // take `onEvent` with it.
  expect(events).toHaveLength(1)
})

// --- QR passthrough --------------------------------------------------------

/**
 * A takeover with a phone attached, ready to press Scan QR. Returns the pieces
 * the tests below drive; each one ends the handoff itself.
 */
async function scannableHandoff(pngScreenshot: Buffer = QR_PAGE_PNG): Promise<{
  human: Awaited<ReturnType<typeof connectHuman>>
  events: HandoffEvent[]
  handoff: ReturnType<typeof runHandoff>
}> {
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const handoff = runHandoff({
    page: fakePage(cdp.cdp, 0, 0, pngScreenshot),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "The site wants this code scanned with a phone",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "qr-handoff",
    relayColdStartMs: 12,
    logger: noopLogger,
  })
  await until("the phone to see the reason", () =>
    human.inbox.some((message) => message.type === "state"),
  )
  return { human, events, handoff }
}

/** Every `links` message the phone has been sent so far. */
function linksSeen(
  inbox: RelayMessage[],
): Extract<RelayMessage, { type: "links" }>[] {
  return inbox.filter(
    (message): message is Extract<RelayMessage, { type: "links" }> =>
      message.type === "links",
  )
}

test("a scan reads the page and sends the human the link it carries", async () => {
  const { human, events, handoff } = await scannableHandoff()

  human.send({ type: "scanqr" })
  await until(
    "the phone to be sent links",
    () => linksSeen(human.inbox).length === 1,
  )

  const answer = linksSeen(human.inbox)[0]
  expect(answer?.source).toBe("qr")
  expect(answer?.links).toEqual([{ text: QR_PAGE_LINK, kind: "url" }])

  human.send({ type: "handback" })
  await handoff
  expect(events[0]?.qrScans).toBe(1)
  expect(events[0]?.qrHits).toBe(1)
})

test("a page with no code answers nothing found, and still counts as a scan", async () => {
  const { human, events, handoff } = await scannableHandoff(BLANK_PNG)

  human.send({ type: "scanqr" })
  await until(
    "the phone to be sent links",
    () => linksSeen(human.inbox).length === 1,
  )
  expect(linksSeen(human.inbox)[0]?.links).toEqual([])

  human.send({ type: "handback" })
  await handoff
  // A scan that found nothing still happened, and the gap between these two is
  // the number worth watching.
  expect(events[0]?.qrScans).toBe(1)
  expect(events[0]?.qrHits).toBe(0)
})

test("a second scan inside the rate limit is dropped, not queued", async () => {
  const { human, events, handoff } = await scannableHandoff()

  // A held button, a double tap, or a second holder of the handoff link. The
  // limit is enforced here and not on the phone, because the socket behind
  // that link is reachable from any HTTP client.
  human.send({ type: "scanqr" })
  human.send({ type: "scanqr" })
  human.send({ type: "scanqr" })
  await until(
    "the phone to be sent links",
    () => linksSeen(human.inbox).length >= 1,
  )
  // Long enough for a queued scan to have answered, and well inside the 2s floor.
  await Bun.sleep(400)

  expect(linksSeen(human.inbox)).toHaveLength(1)
  human.send({ type: "handback" })
  await handoff
  expect(events[0]?.qrScans).toBe(1)
  // One screenshot for the scan and no other: a takeover casts, it does not
  // screenshot, so this is the whole count.
  expect(screenshots).toBe(1)
})

test("a scan that lands after the handoff ended is not counted or sent", async () => {
  // A screenshot is a CDP round trip and the human can hand back while it is
  // in flight. What comes back cannot be delivered — the phone has already
  // been told it is over — so it is not a scan that happened, and the wide
  // event must not claim one. The event is built after the scan task is
  // awaited, so the counters it reads are final.
  const port = await startRelayProcess()
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const handoff = runHandoff({
    page: fakePage(cdp.cdp, 400, 0, QR_PAGE_PNG),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      reason: "The site wants this code scanned with a phone",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "qr-settle-race",
    relayColdStartMs: 12,
    logger: noopLogger,
  })
  await until("the phone to see the reason", () =>
    human.inbox.some((message) => message.type === "state"),
  )

  human.send({ type: "scanqr" })
  // Inside the 400 ms the fake page holds the screenshot for.
  await Bun.sleep(120)
  human.send({ type: "handback" })

  const end = await handoff
  expect(end.outcome).toBe("resolved")
  expect(linksSeen(human.inbox)).toHaveLength(0)
  expect(events[0]?.qrScans).toBe(0)
  expect(events[0]?.qrHits).toBe(0)
})

test("an approval never scans, whatever the phone sends", async () => {
  const port = await startRelayProcess("approval")
  const human = await connectHuman(port)
  const cdp = fakeCdp()
  const events: HandoffEvent[] = []
  const handoff = runHandoff({
    page: fakePage(cdp.cdp),
    agentWsUrl: `ws://127.0.0.1:${port}/ws?role=agent`,
    options: {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: "Transfer EUR 12,430.00 to Acme GmbH",
      logger: noopLogger,
      onEvent: (event) => events.push(event),
    },
    timeoutMs: 5000,
    url: "https://relay.example/?pt_token=x",
    handoffId: "qr-approval",
    relayColdStartMs: 12,
    logger: noopLogger,
  })
  await until("the phone to see the screenshot", () =>
    human.inbox.some((message) => message.type === "frame"),
  )

  human.send({ type: "scanqr" })
  await Bun.sleep(300)
  expect(linksSeen(human.inbox)).toHaveLength(0)

  human.send({ type: "approve" })
  await handoff
  expect(events[0]?.qrScans).toBe(0)
  // The one screenshot is the approval's own frame; the scan added none.
  expect(screenshots).toBe(1)
})
