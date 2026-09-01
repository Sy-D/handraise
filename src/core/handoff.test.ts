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
import { fileURLToPath } from "node:url"
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core"
import WebSocket from "ws"

import type { HandoffEvent } from "../events"
import { noopLogger } from "../logger"
import type { RelayMessage } from "../relay/protocol"
import type { StorageState } from "../types"
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
function startRelayProcess(): Promise<number> {
  const child = spawn(process.execPath, [SERVER_PATH, "0"], {
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
    // SAFETY: as the browser's, above — an unused chaining emitter.
    once: (() => page) as Page["once"],
    // SAFETY: as `once`, above — an unused chaining emitter.
    off: (() => page) as Page["off"],
  }
  // SAFETY: runHandoff uses only context/once/off on the page.
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
