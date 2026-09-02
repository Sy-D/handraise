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
import { fileURLToPath } from "node:url"
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core"
import WebSocket from "ws"

import type { HandoffEvent } from "../events"
import { noopLogger } from "../logger"
import type { RelayMessage } from "../relay/protocol"
import type { HandoffMode, StorageState } from "../types"
import { runHandoff } from "./raise-hand"
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

/** A real 800x500 JPEG, so the approval frame's metadata is parsed, not guessed. */
const SAMPLE_JPEG = readFileSync(
  fileURLToPath(new URL("./fixtures/sample-frame.jpg", import.meta.url)),
)
const VIEWPORT = { width: 1280, height: 800 }

/** A page whose context yields the fake CDP session and a live fake browser. */
function fakePage(cdp: CDPSession): Page {
  let browser: Browser
  const browserPartial: Partial<Browser> = {
    // SAFETY: registration the test never fires; the returned emitter is only
    // for chaining and is never used, so pointing it back at the fake is safe.
    once: (() => browser) as Browser["once"],
    // SAFETY: as `once`, above — an unused chaining emitter.
    off: (() => browser) as Browser["off"],
    isConnected: () => true,
  }
  // SAFETY: runHandoff drives only once/off/isConnected on the browser.
  browser = browserPartial as Browser
  const contextPartial: Partial<BrowserContext> = {
    browser: () => browser,
    newCDPSession: async () => cdp,
    storageState: async () => STORAGE,
  }
  // SAFETY: runHandoff drives only browser/newCDPSession/storageState here.
  const context = contextPartial as BrowserContext
  let page: Page
  const pagePartial: Partial<Page> = {
    context: () => context,
    // SAFETY: approval mode calls screenshot() for its one frame and reads the
    // viewport for that frame's metadata; neither result is used as anything else.
    screenshot: (async () => SAMPLE_JPEG) as Page["screenshot"],
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
  expect(cdp.calls).toEqual([])

  const event = events[0]
  if (!event) throw new Error("no event")
  expect(events).toHaveLength(1)
  expect(event.mode).toBe("approval")
  expect(event.outcome).toBe("approved")
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
