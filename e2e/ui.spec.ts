/**
 * The browser-side e2e for the mobile handoff UI.
 *
 * Every other test in this repo either drives the relay with a `ws` client
 * (src/relay/relay.test.ts) or computes tap pixels in Node (e2e/human-sim.ts).
 * Neither runs the code the human actually sees: the canvas render, the
 * Canvas→frame-pixel maths in `toFrame()`, the keystroke diff, the JPEG decode,
 * the overlays and the reconnect. This test loads the real page in a real
 * Chromium and operates it through the DOM, with no Solari and no API key, so it
 * is safe as a CI gate.
 *
 *   bun test e2e/ui.spec.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test"
import { type ChildProcessByStdio, spawn } from "node:child_process"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { type Browser, chromium, type Page } from "playwright-core"
import WebSocket from "ws"

import { NEVER_OPENABLE } from "../src/core/qr-fixtures"
import type {
  FocusRect,
  FrameMeta,
  HumanToAgent,
  RelayMessage,
} from "../src/relay/protocol"
import type { HandoffMode } from "../src/types"

/**
 * The browser's WebSocket. This file imports `ws` under the same name for the
 * agent side, and the two types are not interchangeable.
 */
type BrowserSocket = InstanceType<typeof globalThis.WebSocket>

declare global {
  interface Window {
    /** Only present when a test installed `captureSockets` before the page. */
    handraiseSockets?: BrowserSocket[]
  }
}

const SERVER_PATH = fileURLToPath(
  new URL("../src/relay/guest/server.js", import.meta.url),
)
const AGENT_KEY = "handraise-ui-test-key"
const START_TIMEOUT_MS = 5000
const MESSAGE_TIMEOUT_MS = 3000

/** The letterboxed frame is deliberately a different aspect ratio than the
 *  portrait canvas, so the vertical bars in `toFrame()` are actually exercised. */
const FRAME_W = 320
const FRAME_H = 200

const META: FrameMeta = {
  deviceWidth: 1280,
  deviceHeight: 800,
  jpegWidth: FRAME_W,
  jpegHeight: FRAME_H,
  pageScaleFactor: 1,
}

interface Relay {
  port: number
  process: ChildProcessByStdio<null, Readable, Readable>
  logs: string[]
}

interface RelayLog {
  event?: string
  role?: string
  port?: number
}

interface AgentClient {
  send(message: RelayMessage): void
  /** Put bytes on the wire that the protocol has no way to describe. */
  sendRaw(text: string): void
  next(): Promise<RelayMessage>
  /** Every message the *phone* has sent, in order. `next()` never consumes it,
   *  so a test can assert that something was sent *exactly once*. The relay's
   *  own messages — `presence`, `ended_ack` — are not the phone's and are not
   *  here: every test in this file is about what the page puts on the wire. */
  received: RelayMessage[]
  close(): void
}

/** What the relay says for itself, rather than forwarding from the phone. */
const RELAY_ORIGINATED = new Set<string>(["presence", "ended_ack"])

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function parseLog(line: string): RelayLog | null {
  try {
    // SAFETY: the guest server writes exactly this shape to stdout in log().
    return JSON.parse(line) as RelayLog
  } catch {
    return null
  }
}

function parseMessage(raw: string): RelayMessage {
  // SAFETY: the relay forwards the human page's JSON verbatim, so every message
  // that reaches the agent socket is a RelayMessage the page produced.
  return JSON.parse(raw) as RelayMessage
}

/**
 * Start the real guest server on an OS-assigned port; read the port from its
 * log. The mode is an argument and not a message: the relay decides what the
 * human may send, so a test for approval mode has to boot its own relay.
 */
function startRelay(mode: HandoffMode = "takeover"): Promise<Relay> {
  const child = spawn(process.execPath, [SERVER_PATH, "0", AGENT_KEY, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const logs: string[] = []
  return new Promise<Relay>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`relay did not start within ${START_TIMEOUT_MS}ms`))
    }, START_TIMEOUT_MS)

    let buffered = ""
    let resolved = false
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8")
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (line.length === 0) continue
        logs.push(line)
        const event = parseLog(line)
        if (!resolved && event?.event === "relay listening" && event.port) {
          resolved = true
          clearTimeout(timer)
          resolve({ port: event.port, process: child, logs })
        }
      }
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Count open `role=human` connections the relay is currently holding, from its log. */
function openHumans(relay: Relay): number {
  let open = 0
  for (const line of relay.logs) {
    const event = parseLog(line)
    if (event?.role !== "human") continue
    if (event.event === "peer connected") open += 1
    else if (event.event === "peer closed") open -= 1
  }
  return open
}

/** A Node `ws` client standing in for the agent side of the handoff. */
async function connectAgent(port: number): Promise<AgentClient> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws?role=agent&k=${AGENT_KEY}`,
  )
  const inbox: RelayMessage[] = []
  const received: RelayMessage[] = []
  const waiters: ((message: RelayMessage) => void)[] = []

  socket.on("message", (raw: Buffer) => {
    const message = parseMessage(raw.toString("utf8"))
    if (RELAY_ORIGINATED.has(message.type)) return
    received.push(message)
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else inbox.push(message)
  })

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })

  return {
    send(message) {
      socket.send(JSON.stringify(message))
    },
    sendRaw(text) {
      socket.send(text)
    },
    received,
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
          reject(new Error(`no agent message within ${MESSAGE_TIMEOUT_MS}ms`))
        }, MESSAGE_TIMEOUT_MS)
        waiters.push(receive)
      })
    },
    close() {
      socket.close()
    },
  }
}

/** The letterbox the page computes in render(): the frame centred in the rect. */
function letterbox(rectW: number, rectH: number): Box {
  const scale = Math.min(rectW / FRAME_W, rectH / FRAME_H)
  const w = FRAME_W * scale
  const h = FRAME_H * scale
  return { x: (rectW - w) / 2, y: (rectH - h) / 2, w, h }
}

/** A base64 JPEG (no data-URL prefix) of a known size, produced once by Chromium. */
async function makeFrame(browser: Browser): Promise<string> {
  const page = await browser.newPage()
  const dataUrl = await page.evaluate(
    (size: { width: number; height: number }) => {
      const canvas = document.createElement("canvas")
      canvas.width = size.width
      canvas.height = size.height
      const context = canvas.getContext("2d")
      if (!context) throw new Error("no 2d context")
      context.fillStyle = "#2b6cb0"
      context.fillRect(0, 0, size.width, size.height)
      context.fillStyle = "#f6ad55"
      context.fillRect(0, 0, size.width / 2, size.height / 2)
      return canvas.toDataURL("image/jpeg", 0.9)
    },
    { width: FRAME_W, height: FRAME_H },
  )
  await page.close()
  return dataUrl.replace(/^data:image\/jpeg;base64,/, "")
}

let browser: Browser
let frameData: string

let relay: Relay
let agent: AgentClient
let page: Page
let consoleErrors: string[]

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
  frameData = await makeFrame(browser)
}, 30000)

afterAll(async () => {
  await browser.close()
})

/**
 * Keep every WebSocket the page opens, so a test can put one into CLOSING —
 * the state where an answer is queued while the page has already finished.
 * Installed before the page script runs, and only where a test asks for it.
 */
function captureSockets(): void {
  const Native = window.WebSocket
  const sockets: BrowserSocket[] = []
  window.handraiseSockets = sockets
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      sockets.push(this)
    }
  }
}

/**
 * A relay in `mode`, an agent on it, and the real page in a phone viewport.
 * `capture` records every WebSocket the page opens; `clock` freezes the page's
 * timers so a test drives the reconnect backoff itself instead of waiting on
 * it. Both are installed before the page script runs.
 */
async function openFixture(
  mode: HandoffMode,
  capture = false,
  clock = false,
): Promise<void> {
  relay = await startRelay(mode)
  agent = await connectAgent(relay.port)
  consoleErrors = []
  page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  })
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  // Fake time only touches the page, not Playwright's own waits, so a network
  // close still fires for real while a reconnect timer waits for fastForward.
  if (clock) await page.clock.install()
  if (capture) await page.addInitScript(captureSockets)
  await page.goto(`http://127.0.0.1:${relay.port}/`)
}

/** Throw the current fixture away and come back up in `mode`. */
async function reopenFixture(
  mode: HandoffMode,
  capture = false,
  clock = false,
): Promise<void> {
  await page.close()
  agent.close()
  relay.process.kill("SIGKILL")
  await openFixture(mode, capture, clock)
}

/**
 * Close the page's socket and answer in the same breath, so the answer is made
 * while the socket is CLOSING rather than after it is gone. Returns the socket
 * state the click actually saw.
 */
function answerWhileClosing(buttonId: string): Promise<number> {
  return page.evaluate((id: string) => {
    const live = window.handraiseSockets?.at(-1)
    if (!live) throw new Error("no socket was captured")
    live.close()
    document.getElementById(id)?.click()
    return live.readyState
  }, buttonId)
}

beforeEach(async () => {
  await openFixture("takeover")
})

afterEach(async () => {
  await page.close()
  agent.close()
  relay.process.kill("SIGKILL")
})

/** A field on the remote page, in its CSS viewport pixels — what the agent sends. */
const FOCUS_RECT: FocusRect = { x: 400, y: 240, width: 200, height: 40 }

const DEFAULT_HINT = "Typing goes straight to the browser"
const HOLD_HINT = "Hold the button to stop the agent"

/** Apple's 44pt minimum is a target, not a height: both axes have to clear it. */
const MIN_TAP_TARGET_PX = 44
/** The gutter that keeps a missed Backspace off "clear the whole field". */
const MIN_DESTRUCTIVE_GAP_PX = 24

/** The page's auto-zoom constants, restated so a change to one is a red test. */
const MAX_ZOOM = 3
const TAP_ZOOM = 2.5
const READABLE_FIELD_PX = 44
const FIELD_WIDTH_SHARE = 0.92
const FOCUS_ANCHOR_Y = 0.42

const QUEUE_HINT = "Reconnecting \u2014 your input is queued"

/** The zoom wrapper's transform: scale, then translate, origin at 0 0. */
interface Transform {
  scale: number
  tx: number
  ty: number
}

/**
 * The transform the page must settle on after a focus, computed here the long
 * way round from FOCUS_RECT and META so a mistake in the page's own maths
 * cannot cancel itself out.
 *
 * One k, not two: this META scales both axes by jpeg/device = 0.25 and the
 * letterbox is square in both, so kx and ky coincide.
 */
function expectedZoom(frame: Box): Transform {
  const fit = Math.min(frame.w / FRAME_W, frame.h / FRAME_H)
  const lb = letterbox(frame.w, frame.h)
  const k = (META.jpegWidth / META.deviceWidth) * META.pageScaleFactor * fit
  const scale = Math.min(
    Math.max(READABLE_FIELD_PX / (FOCUS_RECT.height * k), 1),
    Math.max((frame.w * FIELD_WIDTH_SHARE) / (FOCUS_RECT.width * k), 1),
    MAX_ZOOM,
  )
  const lx = lb.x + (FOCUS_RECT.x + FOCUS_RECT.width / 2) * k
  const ly = lb.y + (FOCUS_RECT.y + FOCUS_RECT.height / 2) * k
  const pan = (offset: number, size: number): number =>
    Math.min(0, Math.max(size - size * scale, offset))
  return {
    scale,
    tx: pan(frame.w / 2 - lx * scale, frame.w),
    ty: pan(frame.h * FOCUS_ANCHOR_Y - ly * scale, frame.h),
  }
}

/** What the zoom wrapper is actually transformed by, right now. */
function zoomTransform(target: Page): Promise<Transform> {
  return target.evaluate(() => {
    const zoom = document.getElementById("zoom")
    if (!zoom) throw new Error("no zoom wrapper")
    const live = new DOMMatrixReadOnly(getComputedStyle(zoom).transform)
    return { scale: live.a, tx: live.e, ty: live.f }
  })
}

/** #frame is never transformed, so this is the letterbox's own coordinate box. */
async function frameBox(): Promise<Box> {
  const box = await page.locator("#frame").boundingBox()
  if (!box) throw new Error("#frame has no bounding box")
  return { x: box.x, y: box.y, w: box.width, h: box.height }
}

/**
 * Where the ring must end up, computed here the long way round so a mistake in
 * the page's own maths cannot cancel out: page CSS px → frame px (the JPEG
 * scaling Chromium left out of the metadata) → canvas px (this page's
 * letterbox) → screen px (the auto-zoom transform, which the ring rides inside
 * rather than recomputing). Viewport-relative, like every Playwright box.
 */
function expectedRing(frame: Box): Box {
  const lb = letterbox(frame.w, frame.h)
  const kx =
    ((META.jpegWidth / META.deviceWidth) * META.pageScaleFactor * lb.w) /
    FRAME_W
  const ky =
    ((META.jpegHeight / META.deviceHeight) * META.pageScaleFactor * lb.h) /
    FRAME_H
  const zoom = expectedZoom(frame)
  return {
    x: frame.x + zoom.tx + (lb.x + FOCUS_RECT.x * kx) * zoom.scale,
    y: frame.y + zoom.ty + (lb.y + FOCUS_RECT.y * ky) * zoom.scale,
    w: FOCUS_RECT.width * kx * zoom.scale,
    h: FOCUS_RECT.height * ky * zoom.scale,
  }
}

/** Resolve once the ring is visible (or hidden, with `visible: false`). */
async function waitForRing(target: Page, visible: boolean): Promise<void> {
  await target.waitForFunction((want: boolean) => {
    const ring = document.getElementById("focus-ring")
    return ring ? !ring.hidden === want : false
  }, visible)
}

/** Wait until the terminal overlay is shown (its `hidden` attribute cleared). */
async function waitForOverlay(target: Page): Promise<void> {
  await target.waitForFunction(() => {
    const overlay = document.getElementById("overlay")
    return overlay ? !overlay.hidden : false
  })
}

/** Send one frame and wait until the page has decoded and drawn it. */
async function showFrame(): Promise<void> {
  agent.send({ type: "frame", data: frameData, meta: META })
  await page.waitForFunction(() => {
    const placeholder = document.getElementById("placeholder")
    return placeholder ? placeholder.hidden : false
  })
}

test("a tap maps to the exact frame pixel under the finger", async () => {
  await showFrame()

  const box = await page.locator("#view").boundingBox()
  if (!box) throw new Error("canvas has no bounding box")

  const frame = letterbox(box.width, box.height)
  // A point inside the letterbox, off-centre so a swapped axis would show up.
  const px = frame.x + frame.w * 0.5
  const py = frame.y + frame.h * 0.3
  const expectedFx = Math.round(((px - frame.x) * FRAME_W) / frame.w)
  const expectedFy = Math.round(((py - frame.y) * FRAME_H) / frame.h)

  await page.locator("#view").click({ position: { x: px, y: py } })

  const message = await agent.next()
  expect(message.type).toBe("tap")
  if (message.type !== "tap") throw new Error("expected a tap")
  expect(Math.abs(message.fx - expectedFx)).toBeLessThanOrEqual(1)
  expect(Math.abs(message.fy - expectedFy)).toBeLessThanOrEqual(1)
  expect(consoleErrors).toEqual([])
})

test("a tap on the canvas is acknowledged on the stage, then cleans up", async () => {
  await showFrame()

  // The mark lives for 300ms, so count the insertions instead of racing them.
  await page.evaluate(() => {
    const stage = document.getElementById("stage")
    if (!stage) throw new Error("no stage")
    stage.dataset.marks = "0"
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLElement && node.className === "tapmark") {
            stage.dataset.marks = String(Number(stage.dataset.marks) + 1)
          }
        }
      }
    }).observe(stage, { childList: true })
  })

  const box = await page.locator("#view").boundingBox()
  if (!box) throw new Error("canvas has no bounding box")
  const frame = letterbox(box.width, box.height)
  await page.locator("#view").click({
    position: { x: frame.x + frame.w * 0.5, y: frame.y + frame.h * 0.5 },
  })

  expect((await agent.next()).type).toBe("tap")
  expect(await page.locator("#stage").getAttribute("data-marks")).toBe("1")
  // And it takes itself back out again: no mark may outlive its animation.
  await page.waitForFunction(
    () => document.querySelectorAll(".tapmark").length === 0,
  )
  expect(consoleErrors).toEqual([])
})

test("typing, Enter and Backspace reach the agent as the right messages", async () => {
  await showFrame()

  const kbd = page.locator("#kbd")
  await kbd.focus()
  await kbd.pressSequentially("7")
  expect(await agent.next()).toEqual({ type: "char", ch: "7" })

  await page.keyboard.press("Enter")
  expect(await agent.next()).toEqual({ type: "key", key: "Enter" })

  // The field is now empty (Enter cleared it), so this is the empty-field path.
  await page.keyboard.press("Backspace")
  expect(await agent.next()).toEqual({ type: "key", key: "Backspace" })
  expect(consoleErrors).toEqual([])
})

test("multi-character input splits into one char message per keystroke", async () => {
  await showFrame()

  const kbd = page.locator("#kbd")
  await kbd.focus()
  await kbd.pressSequentially("ab")

  expect(await agent.next()).toEqual({ type: "char", ch: "a" })
  expect(await agent.next()).toEqual({ type: "char", ch: "b" })

  // Deleting one character mirrors as a single Backspace via the input diff.
  await page.keyboard.press("Backspace")
  expect(await agent.next()).toEqual({ type: "key", key: "Backspace" })
  expect(consoleErrors).toEqual([])
})

/** What `document.activeElement` is right now, by id. */
function activeId(target: Page): Promise<string> {
  return target.evaluate(() => document.activeElement?.id ?? "")
}

test("every key button sends its message without taking the focus", async () => {
  await showFrame()
  // #key-clear is only offered while a remote field is focused.
  agent.send({ type: "focus", rect: FOCUS_RECT, label: "Password" })
  await waitForRing(page, true)

  await page.locator("#kbd").focus()

  const keys: { id: string; message: HumanToAgent }[] = [
    { id: "#key-back", message: { type: "key", key: "Backspace" } },
    { id: "#key-clear", message: { type: "clear" } },
    { id: "#key-tab", message: { type: "key", key: "Tab" } },
    { id: "#key-enter", message: { type: "key", key: "Enter" } },
  ]
  for (const key of keys) {
    await page.locator(key.id).click()
    expect(await agent.next()).toEqual(key.message)
    // A button that steals the focus closes the phone's soft keyboard, and the
    // human has to tap the field again between every keystroke.
    expect(await activeId(page)).toBe("kbd")
  }
  expect(consoleErrors).toEqual([])
})

test("the backspace key deletes one character and sends exactly one Backspace", async () => {
  await showFrame()

  const kbd = page.locator("#kbd")
  await kbd.focus()
  await kbd.pressSequentially("ab")
  expect(await agent.next()).toEqual({ type: "char", ch: "a" })
  expect(await agent.next()).toEqual({ type: "char", ch: "b" })

  await page.locator("#key-back").click()
  expect(await agent.next()).toEqual({ type: "key", key: "Backspace" })
  expect(await kbd.inputValue()).toBe("a")

  // The regression this test exists for: if the local mirror kept the deleted
  // character, the next keystroke's diff would send a second Backspace before
  // the character — one character too many gone from the remote field.
  await kbd.pressSequentially("c")
  expect(await agent.next()).toEqual({ type: "char", ch: "c" })
  expect(consoleErrors).toEqual([])
})

test("the clear key is offered only while a remote field is focused", async () => {
  await showFrame()

  // Nothing focused yet: Ctrl+A would mark the whole remote page.
  expect(await page.locator("#key-clear").isDisabled()).toBe(true)

  agent.send({ type: "focus", rect: FOCUS_RECT, label: "Password" })
  await waitForRing(page, true)
  expect(await page.locator("#key-clear").isEnabled()).toBe(true)

  agent.send({ type: "focus", rect: null, label: null })
  await waitForRing(page, false)
  expect(await page.locator("#key-clear").isDisabled()).toBe(true)
  expect(consoleErrors).toEqual([])
})

const KEY_IDS = ["#key-back", "#key-tab", "#key-enter", "#key-clear", "#key-qr"]

/** Every key button's box, in the order the ids are given. */
async function keyBoxes(): Promise<Box[]> {
  const boxes: Box[] = []
  for (const id of KEY_IDS) {
    const box = await page.locator(id).boundingBox()
    if (!box) throw new Error(`${id} has no bounding box`)
    boxes.push({ x: box.x, y: box.y, w: box.width, h: box.height })
  }
  return boxes
}

test("every key is a 44px target and clear is fenced off from backspace", async () => {
  await showFrame()

  for (const box of await keyBoxes()) {
    expect(box.w).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX)
    expect(box.h).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX)
  }

  // ⌫ is pressed the most and ✕ destroys the whole field with no undo. They
  // are the two keys that must never be neighbours.
  const [back, , , clear] = await keyBoxes()
  if (!back || !clear) throw new Error("the key bar is missing keys")
  expect(clear.x - (back.x + back.w)).toBeGreaterThanOrEqual(
    MIN_DESTRUCTIVE_GAP_PX,
  )
  expect(consoleErrors).toEqual([])
})

test("the field owns its row and the key bar stays on one line", async () => {
  await page.setViewportSize({ width: 320, height: 568 })
  await showFrame()

  const field = await page.locator("#kbd").boundingBox()
  const keys = await page.locator(".keys").boundingBox()
  if (!field || !keys) throw new Error("the input bar has no bounding box")

  // Sharing the row with four keys left the field 69px here — about four
  // visible characters. Fine for a six-digit code, useless for an email.
  expect(field.width).toBeGreaterThan(260)
  expect(keys.y).toBeGreaterThanOrEqual(field.y + field.height - 1)

  // The keys themselves still share one line: a wrapped key bar on a 320px
  // phone pushes the hint and both buttons below the fold.
  const boxes = await keyBoxes()
  const first = boxes[0]
  if (!first) throw new Error("the key bar is missing keys")
  for (const key of boxes) {
    expect(Math.abs(key.y - first.y)).toBeLessThanOrEqual(1)
    expect(key.w).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX)
    expect(key.h).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX)
  }
  expect(keys.height).toBeLessThan(first.h * 1.5)

  // The footer took a row; the stage is what paid for it and it can afford to.
  const stage = await page.locator("#stage").boundingBox()
  if (!stage) throw new Error("#stage has no bounding box")
  expect(stage.height).toBeGreaterThan(200)
  expect(consoleErrors).toEqual([])
})

test("the focused field is zoomed to and a tap on it still lands exactly", async () => {
  await showFrame()

  const frame = await frameBox()
  const want = expectedZoom(frame)
  // The bug this exists for: at fit the field is 11.6 CSS px tall on a 390px
  // phone, which is the audit's "about a millimetre of glyph height".
  expect(want.scale).toBeGreaterThan(2)

  agent.send({ type: "focus", rect: FOCUS_RECT, label: "Code" })
  await waitForRing(page, true)
  await page.waitForTimeout(320)

  const live = await zoomTransform(page)
  expect(Math.abs(live.scale - want.scale)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(live.tx - want.tx)).toBeLessThanOrEqual(1)
  expect(Math.abs(live.ty - want.ty)).toBeLessThanOrEqual(1)

  // And the tap maths survived the transform. Inverted by hand from the
  // transform above: client px → canvas CSS px → frame px.
  //   local = (client - frameOrigin - t) / scale
  //   fx    = (local.x - letterbox.x) * FRAME_W / letterbox.w
  const clientX = frame.x + frame.w * 0.32
  const clientY = frame.y + frame.h * 0.55
  const lb = letterbox(frame.w, frame.h)
  const localX = (clientX - frame.x - want.tx) / want.scale
  const localY = (clientY - frame.y - want.ty) / want.scale
  const expectedFx = Math.round(((localX - lb.x) * FRAME_W) / lb.w)
  const expectedFy = Math.round(((localY - lb.y) * FRAME_H) / lb.h)
  // A point that fell outside the frame would make the assertion below vacuous.
  expect(expectedFx).toBeGreaterThanOrEqual(0)
  expect(expectedFx).toBeLessThanOrEqual(FRAME_W)
  expect(expectedFy).toBeGreaterThanOrEqual(0)
  expect(expectedFy).toBeLessThanOrEqual(FRAME_H)

  await page.mouse.click(clientX, clientY)

  const message = await agent.next()
  expect(message.type).toBe("tap")
  if (message.type !== "tap") throw new Error("expected a tap")
  expect(Math.abs(message.fx - expectedFx)).toBeLessThanOrEqual(1)
  expect(Math.abs(message.fy - expectedFy)).toBeLessThanOrEqual(1)
  expect(consoleErrors).toEqual([])
})

test("a double tap toggles the zoom and sends only the first tap", async () => {
  await showFrame()

  const frame = await frameBox()
  const lb = letterbox(frame.w, frame.h)
  const x = frame.x + lb.x + lb.w * 0.4
  const y = frame.y + lb.y + lb.h * 0.6

  // The first tap goes out immediately — waiting 250ms to learn whether a
  // second one is coming would delay the one action this page exists for.
  await page.mouse.click(x, y)
  expect(await agent.next()).toEqual({
    type: "tap",
    fx: Math.round((lb.w * 0.4 * FRAME_W) / lb.w),
    fy: Math.round((lb.h * 0.6 * FRAME_H) / lb.h),
  })

  await page.mouse.click(x, y)
  await page.waitForTimeout(320)
  expect(await zoomTransform(page)).toMatchObject({ scale: TAP_ZOOM })
  // The second tap paid for the zoom instead of reaching the remote page.
  expect(countOf("tap")).toBe(1)

  // And back to fit, which is the only way out of a zoom the human chose.
  await page.mouse.click(x, y)
  await page.mouse.click(x, y)
  await page.waitForTimeout(320)
  const back = await zoomTransform(page)
  expect(back.scale).toBe(1)
  expect(back.tx).toBe(0)
  expect(back.ty).toBe(0)
  expect(consoleErrors).toEqual([])
})

test("input made while the socket is down is queued, then sent once in order", async () => {
  await showFrame()

  // Displace the page's socket the way the preview proxy's 60s close does.
  const intruder = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?role=human`)
  await new Promise<void>((resolve, reject) => {
    intruder.once("open", () => resolve())
    intruder.once("error", reject)
  })
  await page.waitForFunction(() => {
    const dot = document.getElementById("dot")
    return dot ? dot.className.includes("waiting") : false
  })

  await page.locator("#kbd").focus()
  await page.locator("#kbd").pressSequentially("abc")
  // Silence is the one thing an interface may never do: the human has to be
  // told the characters are held, or they retype them and double-submit.
  expect(await page.locator("#hint").textContent()).toBe(QUEUE_HINT)

  intruder.close()
  await page.waitForFunction(() => {
    const dot = document.getElementById("dot")
    return dot ? dot.className === "dot" : false
  })
  await page.waitForFunction(
    () => document.querySelector<HTMLInputElement>("#kbd")?.value === "abc",
  )
  await page.waitForTimeout(300)

  // Exactly these three, in the order they were typed, once each.
  const typed = agent.received
    .filter((message) => message.type === "char")
    .map((message) => (message.type === "char" ? message.ch : ""))
  expect(typed).toEqual(["a", "b", "c"])
  expect(await page.locator("#hint").textContent()).toBe(DEFAULT_HINT)
  expect(consoleErrors).toEqual([])
}, 20000)

test("the local field dresses itself as the remote one: OTP, then password", async () => {
  await showFrame()

  agent.send({
    type: "focus",
    rect: FOCUS_RECT,
    label: "Verification code",
    kind: "otp",
  })
  await waitForRing(page, true)

  const kbd = page.locator("#kbd")
  // The reason the field is on the wire at all: this is what makes iOS offer
  // the code from Messages instead of making the human copy it between apps.
  expect(await kbd.getAttribute("autocomplete")).toBe("one-time-code")
  expect(await kbd.getAttribute("inputmode")).toBe("numeric")
  expect(await kbd.getAttribute("type")).toBe("text")
  // No pattern: plenty of one-time codes are alphanumeric.
  expect(await kbd.getAttribute("pattern")).toBe(null)

  await kbd.focus()
  await kbd.pressSequentially("31")
  expect(await agent.next()).toEqual({ type: "char", ch: "3" })
  expect(await agent.next()).toEqual({ type: "char", ch: "1" })

  agent.send({
    type: "focus",
    rect: { x: 400, y: 320, width: 200, height: 40 },
    label: "Password",
    kind: "password",
  })
  await page.waitForFunction(
    () => document.getElementById("kbd")?.getAttribute("type") === "password",
  )
  expect(await kbd.getAttribute("autocomplete")).toBe("off")
  // A new field is a new context: the mirror must not leave the old value for
  // the next keystroke's Backspace diff to run against.
  expect(await kbd.inputValue()).toBe("")

  await kbd.focus()
  await kbd.pressSequentially("s")
  expect(await agent.next()).toEqual({ type: "char", ch: "s" })
  expect(consoleErrors).toEqual([])
})

test("hand back sends handback and shows the handed-back overlay", async () => {
  await showFrame()

  await page.locator("#handback").click()
  expect(await agent.next()).toEqual({ type: "handback" })

  await waitForOverlay(page)
  // One string for one event: the local path and ENDINGS.resolved used to tell
  // the same story in two vocabularies.
  expect(await page.locator("#overlay-title").textContent()).toBe(
    "Thanks \u2014 that unblocked it",
  )
  expect(await page.locator("#overlay-note").textContent()).toBe(
    "The agent is driving again. You can close this tab.",
  )
  expect(consoleErrors).toEqual([])
})

/** Press the element with a real pointer, hold it, release it. */
async function pressAndHold(selector: string, holdMs: number): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`${selector} has no bounding box`)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(holdMs)
  await page.mouse.up()
}

function countOf(type: string): number {
  return agent.received.filter((message) => message.type === type).length
}

test("a press shorter than the hold never ends the handoff", async () => {
  await showFrame()

  // Emil's hold-to-delete: the gesture, not a dialog, is the confirmation. A
  // thumb that brushes the button — the failure mode this replaces — must do
  // nothing at all.
  await pressAndHold("#abort", 300)
  await page.waitForTimeout(400)

  expect(countOf("abort")).toBe(0)
  expect(await page.locator("#overlay").isHidden()).toBe(true)
  expect(await page.locator("#abort").getAttribute("data-holding")).toBe(null)
  // A tap that does nothing has to say why, or the human thinks it is broken.
  expect(await page.locator("#hint").textContent()).toBe(HOLD_HINT)
  expect(consoleErrors).toEqual([])
})

test("reduced motion drops the fill and keeps the 700ms", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await showFrame()

  // Reduced motion means less movement, never less safety: the progress fill
  // goes, the cost of the gesture stays.
  const fill = await page.evaluate(() => {
    const button = document.getElementById("abort")
    if (!button) throw new Error("no give-up button")
    return getComputedStyle(button, "::before").display
  })
  expect(fill).toBe("none")

  await pressAndHold("#abort", 300)
  await page.waitForTimeout(300)
  expect(countOf("abort")).toBe(0)

  await pressAndHold("#abort", 900)
  await waitForOverlay(page)
  expect(countOf("abort")).toBe(1)
  expect(consoleErrors).toEqual([])
})

test("holding the give-up button past 700ms aborts exactly once", async () => {
  await showFrame()

  const box = await page.locator("#abort").boundingBox()
  if (!box) throw new Error("#abort has no bounding box")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  // Mid-hold: the fill is running, so the human can see the cost accruing.
  await page.waitForTimeout(300)
  expect(await page.locator("#abort").getAttribute("data-holding")).toBe("")
  await page.waitForTimeout(600)
  await page.mouse.up()

  expect(await agent.next()).toEqual({ type: "abort" })
  await waitForOverlay(page)
  // The release fires a click on top of the completed hold: one abort, not two.
  await page.waitForTimeout(400)
  expect(countOf("abort")).toBe(1)
  expect(await page.locator("#overlay-title").textContent()).toBe(
    "Thanks for looking",
  )
  expect(consoleErrors).toEqual([])
})

test("an ended message shows the matching terminal overlay", async () => {
  await showFrame()

  agent.send({ type: "ended", outcome: "disconnected" })

  await waitForOverlay(page)
  expect(await page.locator("#overlay-title").textContent()).toBe(
    "Connection ended",
  )
  // A stranger who just typed a code must not be told they broke something.
  expect(await page.locator("#overlay-note").textContent()).toBe(
    "The remote browser closed. The agent has been told \u2014 this wasn't anything you did.",
  )
  expect(consoleErrors).toEqual([])
})

/** The animation running on the status dot's halo right now, or "none". */
function dotAnimation(target: Page): Promise<string> {
  return target.evaluate(() => {
    const dot = document.getElementById("dot")
    if (!dot) throw new Error("no status dot")
    return getComputedStyle(dot, "::after").animationName
  })
}

test("the header names the page and gives a long reason two lines", async () => {
  await showFrame()

  // A stranger arriving from a QR code is looking at a dark page that will ask
  // for a two-factor code. It has to say what it is.
  expect(await page.locator(".eyebrow").textContent()).toBe(
    "handraise \u00b7 an agent asked for your help",
  )
  // Motion marks change, not permanence: the live state does not pulse.
  expect(await dotAnimation(page)).toBe("none")

  const short = await page.locator("#reason").boundingBox()
  if (!short) throw new Error("#reason has no bounding box")

  agent.send({
    type: "state",
    reason:
      "Blocked on two-factor authentication at login.acme-bank.example \u2014 the code went to the phone ending 4417 and expires in a minute.",
  })
  await page.waitForFunction(() =>
    (document.getElementById("reason")?.textContent ?? "").startsWith(
      "Blocked",
    ),
  )

  const long = await page.locator("#reason").boundingBox()
  if (!long) throw new Error("#reason has no bounding box")
  // Two lines, not one truncated one — and clamped, so it can never take the
  // stage with it.
  expect(long.height).toBeGreaterThan(short.height * 1.5)
  expect(long.height).toBeLessThan(short.height * 2.5)
  expect(consoleErrors).toEqual([])
})

test("a focus message rings the remote field and names it in the bar", async () => {
  await showFrame()

  const want = expectedRing(await frameBox())

  agent.send({ type: "focus", rect: FOCUS_RECT, label: "Password" })
  await waitForRing(page, true)
  // Longer than the ring's 120 ms move and the zoom's 180 ms, so the box read
  // below is the one it settled on and not a frame somewhere along the way.
  await page.waitForTimeout(320)

  const ring = await page.locator("#focus-ring").boundingBox()
  if (!ring) throw new Error("the focus ring has no bounding box")
  expect(Math.abs(ring.x - want.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(ring.y - want.y)).toBeLessThanOrEqual(2)
  expect(Math.abs(ring.width - want.w)).toBeLessThanOrEqual(2)
  expect(Math.abs(ring.height - want.h)).toBeLessThanOrEqual(2)

  expect(await page.locator("#hint").textContent()).toBe(
    "Typing into: Password",
  )
  expect(consoleErrors).toEqual([])
})

test("clearing the focus hides the ring and restores the default hint", async () => {
  await showFrame()

  agent.send({ type: "focus", rect: FOCUS_RECT, label: "Password" })
  await waitForRing(page, true)

  agent.send({ type: "focus", rect: null, label: null })
  await waitForRing(page, false)

  expect(await page.locator("#hint").textContent()).toBe(DEFAULT_HINT)
  expect(consoleErrors).toEqual([])
})

test("a hostile field label reaches the bar as text, never as markup", async () => {
  await showFrame()

  // The label is copied out of whatever page the agent got stuck on, so it is
  // attacker-controlled input by construction.
  const hostile = "<img src=x onerror=\"window.name = 'pwned'\">"
  agent.send({ type: "focus", rect: FOCUS_RECT, label: hostile })
  await waitForRing(page, true)

  expect(await page.locator("#hint").textContent()).toBe(
    `Typing into: ${hostile}`,
  )
  expect(await page.locator("#hint img").count()).toBe(0)
  expect(await page.evaluate(() => window.name)).not.toBe("pwned")
  expect(consoleErrors).toEqual([])
})

test("a human who joins late is replayed the current focus", async () => {
  await showFrame()
  agent.send({ type: "focus", rect: FOCUS_RECT, label: "Password" })
  await waitForRing(page, true)

  // A second phone takes the human role. The relay replays state, frame and
  // focus, in that order — the ring can only appear once the frame decodes.
  const late = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  })
  try {
    await late.goto(`http://127.0.0.1:${relay.port}/`)
    await waitForRing(late, true)
    expect(await late.locator("#hint").textContent()).toBe(
      "Typing into: Password",
    )
  } finally {
    await late.close()
  }
})

test("the page reconnects after its socket drops, with a single live human", async () => {
  await showFrame()
  expect(openHumans(relay)).toBe(1)

  // Displace the page's human socket the way the preview proxy's 60s close
  // would: a second human takes the role, then leaves. The relay sends the
  // page a close frame; the page must reconnect on its own.
  const intruder = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?role=human`)
  await new Promise<void>((resolve, reject) => {
    intruder.once("open", () => resolve())
    intruder.once("error", reject)
  })
  await page.waitForFunction(() => {
    const dot = document.getElementById("dot")
    return dot ? dot.className.includes("waiting") : false
  })
  // Waiting is the one state where the human needs to know something is still
  // trying, so this is the one state that pulses.
  expect(await dotAnimation(page)).toBe("pulse")
  intruder.close()

  // The page's backoff reconnect brings the status dot back to live.
  await page.waitForFunction(() => {
    const dot = document.getElementById("dot")
    return dot ? dot.className === "dot" : false
  })

  // The reconnected socket receives agent traffic again.
  agent.send({ type: "state", reason: "reconnected-ok" })
  await page.waitForFunction(() => {
    const reason = document.getElementById("reason")
    return reason ? reason.textContent === "reconnected-ok" : false
  })

  // Exactly one human is connected: no overlapping sockets survived.
  expect(openHumans(relay)).toBe(1)
  expect(consoleErrors).toEqual([])
}, 20000)

// --- Approval mode --------------------------------------------------------
//
// A different job on the same page: the human is not driving the browser, they
// are answering one question about one screenshot. The tests below assert the
// two halves of that — the screen says what is about to happen, and nothing the
// human touches can reach the remote page.

const APPROVAL_REASON = "Agent wants to submit this payment"
const APPROVAL_ACTION = "Submit $12,430 vendor payment to Acme GmbH"
const APPROVAL_HINT = "Approve needs a hold. Deny is one tap."
const APPROVAL_HOLD_HINT = "Hold the button to approve"

/** Put the page in approval mode and give it the agent's ask. */
async function showApproval(capture = false): Promise<void> {
  await reopenFixture("approval", capture)
  agent.send({
    type: "state",
    reason: APPROVAL_REASON,
    action: APPROVAL_ACTION,
  })
  await page.waitForFunction(
    (action: string) =>
      document.getElementById("action")?.textContent === action,
    APPROVAL_ACTION,
  )
}

test("approval mode states the action and offers no way to type", async () => {
  await showApproval()

  expect(await page.locator("#reason").textContent()).toBe(APPROVAL_REASON)
  expect(await page.locator(".eyebrow").textContent()).toBe(
    "handraise · an agent needs your approval",
  )
  // The action is the sentence the decision is made on, so it is the largest
  // type on the page — larger than the reason above it.
  const sizes = await page.evaluate(() => {
    const size = (id: string): number => {
      const node = document.getElementById(id)
      if (!node) throw new Error(`no #${id}`)
      return Number.parseFloat(getComputedStyle(node).fontSize)
    }
    return { action: size("action"), reason: size("reason") }
  })
  expect(sizes.action).toBeGreaterThan(sizes.reason)

  // No keyboard, no key bar: there is nothing on this screen to type into.
  expect(await page.locator("#kbd").isVisible()).toBe(false)
  expect(await page.locator(".keys").isVisible()).toBe(false)
  expect(await page.locator("#hint").textContent()).toBe(APPROVAL_HINT)

  for (const id of ["#deny", "#approve"]) {
    const box = await page.locator(id).boundingBox()
    if (!box) throw new Error(`${id} has no bounding box`)
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX)
    expect(box.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX)
  }

  // Peers, down to the pixel: the accent marks the action the interface wants,
  // and an approval has none. Only the gesture differs.
  const paint = await page.evaluate(() => {
    const of = (id: string) => {
      const node = document.getElementById(id)
      if (!node) throw new Error(`no #${id}`)
      const style = getComputedStyle(node)
      return {
        background: style.backgroundColor,
        color: style.color,
        border: style.border,
        fontWeight: style.fontWeight,
      }
    }
    return { deny: of("deny"), approve: of("approve") }
  })
  expect(paint.deny).toEqual(paint.approve)
  expect(consoleErrors).toEqual([])
})

test("deny is one tap and says so on the way out", async () => {
  await showApproval()

  await page.locator("#deny").click()
  expect(await agent.next()).toEqual({ type: "deny" })

  await waitForOverlay(page)
  expect(await page.locator("#overlay-title").textContent()).toBe("Denied")
  expect(await page.locator("#overlay-note").textContent()).toBe(
    "The agent has been told not to do it. You can close this tab.",
  )
  await page.waitForTimeout(300)
  expect(countOf("deny")).toBe(1)
  expect(consoleErrors).toEqual([])
})

test("approve takes the hold, and a short press only explains", async () => {
  await showApproval()

  // The inversion of takeover mode: here the irreversible answer is yes, so
  // yes is the one that costs a hold.
  await pressAndHold("#approve", 300)
  await page.waitForTimeout(400)
  expect(countOf("approve")).toBe(0)
  expect(await page.locator("#overlay").isHidden()).toBe(true)
  expect(await page.locator("#hint").textContent()).toBe(APPROVAL_HOLD_HINT)

  await pressAndHold("#approve", 900)
  expect(await agent.next()).toEqual({ type: "approve" })
  await waitForOverlay(page)
  await page.waitForTimeout(400)
  expect(countOf("approve")).toBe(1)
  expect(await page.locator("#overlay-title").textContent()).toBe("Approved")
  expect(consoleErrors).toEqual([])
})

test("the screenshot zooms but nothing the human touches reaches the page", async () => {
  await showApproval()
  await showFrame()

  const box = await page.locator("#view").boundingBox()
  if (!box) throw new Error("canvas has no bounding box")
  const centre = { x: box.width / 2, y: box.height / 2 }

  await page.locator("#view").click({ position: centre })
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(300)
  // Approval injects no input at all — not a tap, not a scroll, not a key.
  expect(agent.received).toEqual([])

  // It is still a screenshot of a page nobody can read at 29%, so the zoom
  // gestures stay: a double tap magnifies it.
  await page.locator("#view").dblclick({ position: centre })
  await page.waitForTimeout(300)
  expect((await zoomTransform(page)).scale).toBeGreaterThan(1.5)
  expect(agent.received).toEqual([])
  expect(consoleErrors).toEqual([])
})

test("an approval ending shows the matching terminal overlay", async () => {
  await showApproval()

  agent.send({ type: "ended", outcome: "approved" })

  await waitForOverlay(page)
  expect(await page.locator("#overlay-title").textContent()).toBe("Approved")
  expect(await page.locator("#overlay-note").textContent()).toBe(
    "The agent has your approval and is continuing. You can close this tab.",
  )
  expect(consoleErrors).toEqual([])
})

test("an approval answered while the socket is closing still reaches the agent", async () => {
  await showApproval(true)

  // The gap this closes: `send` queues the answer because the socket is not
  // open, `finish` marks the page done, and the socket's own close handler
  // then used to stop reconnecting — with the answer still in the queue. The
  // human saw "Denied" and the agent waited out its timeout.
  const state = await answerWhileClosing("deny")
  expect(state).toBe(WebSocket.CLOSING)

  await waitForOverlay(page)
  expect(await page.locator("#overlay-title").textContent()).toBe("Denied")
  expect(await agent.next()).toEqual({ type: "deny" })
  expect(consoleErrors).toEqual([])
}, 20000)

test("a hand back given while the socket is closing still reaches the agent", async () => {
  // The same hole, on the mode that has had it since 0.3.0.
  await reopenFixture("takeover", true)
  await showFrame()

  const state = await answerWhileClosing("handback")
  expect(state).toBe(WebSocket.CLOSING)

  await waitForOverlay(page)
  expect(await agent.next()).toEqual({ type: "handback" })
  expect(consoleErrors).toEqual([])
}, 20000)

test("one finger pans the approval screenshot and still sends nothing", async () => {
  await showApproval()
  await showFrame()

  // At fit there is nowhere to pan to, so zoom in first.
  const box = await page.locator("#view").boundingBox()
  if (!box) throw new Error("canvas has no bounding box")
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.dblclick(centre.x, centre.y)
  await page.waitForTimeout(300)
  const before = await zoomTransform(page)
  expect(before.scale).toBeGreaterThan(1.5)

  // The one gesture that was re-purposed rather than disabled: in a takeover
  // this drag scrolls the remote page, and here it may only move the picture.
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.down()
  await page.mouse.move(centre.x + 60, centre.y + 60, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(200)

  const after = await zoomTransform(page)
  expect(after.tx !== before.tx || after.ty !== before.ty).toBe(true)
  expect(agent.received).toEqual([])
  expect(consoleErrors).toEqual([])
})

/** The FLUSH_DEADLINE_MS the page uses, restated so a change to one is a red test. */
const FLUSH_DEADLINE_MS = 30_000

/** How many WebSockets the page has opened since it loaded (captureSockets). */
function socketCount(target: Page): Promise<number> {
  return target.evaluate(() => window.handraiseSockets?.length ?? 0)
}

test("the reconnect loop gives up flushing once its deadline passes", async () => {
  // A finished page with a queued answer keeps reconnecting to deliver it. The
  // backoff caps the wait between attempts, not their number, so against a
  // relay the agent has already timed out and killed, the tab used to retry a
  // dead host every 8s forever. The deadline caps the attempts.
  //
  // Deterministic, not a 30s wait: the page's clock is frozen, so every
  // reconnect timer fires only when this test fast-forwards it, and the socket
  // count is the attempt count.
  await reopenFixture("takeover", true, true)
  await showFrame()

  // Kill the relay so every reconnect from here on fails, then wait for the
  // page to notice its own socket drop (a network event, real even under the
  // fake clock).
  agent.close()
  relay.process.kill("SIGKILL")
  await page.waitForFunction(() => {
    const dot = document.getElementById("dot")
    return dot ? dot.className.includes("waiting") : false
  })

  // Answer while the socket is down: the message queues, and finish() starts
  // the flush deadline. One socket has been opened so far — the initial one,
  // now dead — and no reconnect has fired because its timer is frozen.
  await page.locator("#handback").click()
  await waitForOverlay(page)
  const baseline = await socketCount(page)
  expect(baseline).toBe(1)

  // Well within the deadline: advance past the first backoff so a reconnect
  // actually fires. It is the attempt that would flush the answer against a
  // relay that had come back — proof the loop is still trying.
  await page.clock.fastForward(2_000)
  await page.waitForTimeout(150)
  const during = await socketCount(page)
  expect(during).toBeGreaterThan(baseline)

  // Cross the deadline. The pending reconnect timer still fires, but connect()
  // and onclose now see `finished && !stillSending()` and stop.
  await page.clock.fastForward(FLUSH_DEADLINE_MS)
  await page.waitForTimeout(150)
  const atStop = await socketCount(page)

  // Keep advancing: a dead host is no longer retried. The socket count is
  // frozen — the loop has actually stopped, not merely slowed.
  await page.clock.fastForward(60_000)
  await page.waitForTimeout(200)
  const after = await socketCount(page)
  expect(after).toBe(atStop)

  // The only console noise here is the browser's own "connection refused" for
  // each reconnect against the relay this test deliberately killed — the page
  // handles it (onerror closes the socket). Anything else is a real error.
  const unexpected = consoleErrors.filter(
    (line) => !line.includes("net::ERR_CONNECTION_REFUSED"),
  )
  expect(unexpected).toEqual([])
}, 20000)

// --- QR passthrough: the button, the sheet, and what it refuses to open ----

const QR_LINK = "https://verify.example.com/device?token=abc123"

/**
 * Wait for the result sheet to be on screen (or gone).
 *
 * When it is coming in, wait for the card to have finished rising as well: it
 * starts a `translateY(100%)` below the fold, so between the `hidden` flip and
 * the end of the transition its contents are outside the viewport and
 * `elementFromPoint` over them answers null.
 */
async function waitForSheet(visible: boolean): Promise<void> {
  await page.waitForFunction((want: boolean) => {
    const sheet = document.getElementById("sheet")
    if (!sheet || !sheet.hidden !== want) return false
    if (!want) return true
    const card = document.getElementById("sheet-card")
    return card ? card.getBoundingClientRect().bottom <= innerHeight + 1 : false
  }, visible)
}

/** The text of every link card in the sheet, in order. */
function sheetTexts(): Promise<string[]> {
  return page
    .locator("#sheet-links .link-text")
    .allTextContents()
    .then((texts) => texts.map((text) => text.trim()))
}

test("the scan button is offered in a takeover and not in an approval", async () => {
  await showFrame()
  expect(await page.locator("#key-qr").isVisible()).toBe(true)
  expect(await page.locator("#key-qr").isEnabled()).toBe(true)

  // The whole input bar is gone in an approval: the human is answering a
  // question about one screenshot, and there is no live page to scan.
  await reopenFixture("approval")
  agent.send({ type: "frame", data: frameData, meta: META })
  await page.waitForTimeout(150)
  expect(await page.locator("#key-qr").isVisible()).toBe(false)

  // The page will not even put it on the wire: `scanqr` is not in an approval's
  // vocabulary. (The relay refuses it too — relay.test.ts "approval mode drops
  // every takeover message the human sends" — because a hidden control is not
  // a restriction.)
  await page.evaluate(() => {
    document.getElementById("key-qr")?.click()
  })
  await page.waitForTimeout(200)
  expect(agent.received.some((message) => message.type === "scanqr")).toBe(
    false,
  )
  expect(consoleErrors).toEqual([])
})

test("pressing scan asks the agent once and waits for the answer", async () => {
  await showFrame()

  await page.locator("#key-qr").click()
  await page.waitForFunction(() => {
    const button = document.getElementById("key-qr")
    return button instanceof HTMLButtonElement && button.disabled
  })
  const scans = agent.received.filter((message) => message.type === "scanqr")
  expect(scans).toHaveLength(1)
  expect(await page.locator("#hint").textContent()).toBe("Reading the page…")

  // A second press while the first is in flight must not reach the agent: the
  // core would drop it anyway, and a dropped scan is an answer that never comes.
  await page.locator("#key-qr").click({ force: true })
  await page.waitForTimeout(100)
  expect(
    agent.received.filter((message) => message.type === "scanqr"),
  ).toHaveLength(1)

  agent.send({
    type: "links",
    links: [{ text: QR_LINK, kind: "url" }],
    source: "qr",
  })
  await waitForSheet(true)
  expect(await page.locator("#key-qr").isEnabled()).toBe(true)
  expect(consoleErrors).toEqual([])
})

test("the sheet shows the link and opens it in a new tab, never in this one", async () => {
  await showFrame()
  agent.send({
    type: "links",
    links: [{ text: QR_LINK, kind: "url" }],
    source: "qr",
  })
  await waitForSheet(true)

  expect(await sheetTexts()).toEqual([QR_LINK])
  const open = page.locator("#sheet-links a.link-action")
  expect(await open.isVisible()).toBe(true)
  expect(await open.getAttribute("href")).toBe(QR_LINK)
  // This tab is holding a live handoff. The opened site must not get a handle
  // on it, and must not be told the handoff URL it came from.
  expect(await open.getAttribute("target")).toBe("_blank")
  expect(await open.getAttribute("rel")).toBe("noopener noreferrer")

  // Copy is offered whatever the link is, and the sheet is dismissible.
  expect(
    await page.locator("#sheet-links button.link-action").textContent(),
  ).toBe("Copy")
  await page.locator("#sheet-close").click()
  await waitForSheet(false)
  expect(consoleErrors).toEqual([])
})

test("a scan that found nothing says so rather than showing an empty sheet", async () => {
  await showFrame()
  await page.locator("#key-qr").click()
  agent.send({ type: "links", links: [], source: "qr" })
  await waitForSheet(true)

  expect(await page.locator("#sheet-title").textContent()).toBe(
    "No QR code found",
  )
  expect(await sheetTexts()).toEqual([])
  expect(await page.locator("#sheet-links .empty").textContent()).toContain(
    "Nothing on this screen decoded",
  )
  // And the button is usable again, or the human cannot try after scrolling.
  expect(await page.locator("#key-qr").isEnabled()).toBe(true)
  expect(consoleErrors).toEqual([])
})

test("a payload the page may not open gets no anchor, whatever the agent called it", async () => {
  await showFrame()
  // Every one of these arrives labelled `kind: "url"`, which is the lie the
  // page has to survive: the handoff URL is a bearer credential and the socket
  // behind it is reachable from any HTTP client, so this side applies the whole
  // rule again instead of trusting the label. The list is the core's own, so
  // the two locks cannot drift into checking different things.
  agent.send({
    type: "links",
    links: NEVER_OPENABLE.map((text) => ({ text, kind: "url" as const })),
    source: "qr",
  })
  await waitForSheet(true)

  expect(await sheetTexts()).toEqual([...NEVER_OPENABLE])
  // No anchor at all — not a disabled one, and not one with a neutered href.
  expect(await page.locator("#sheet-links a").count()).toBe(0)
  expect(await page.locator("#sheet-links button.link-action").count()).toBe(
    NEVER_OPENABLE.length,
  )
  expect(
    await page.locator("#sheet-links .link-note").first().textContent(),
  ).toContain("Not a link this page will open")
  expect(consoleErrors).toEqual([])
})

test("an openable link is shown as the address it actually opens", async () => {
  await showFrame()
  // The first character is a Cyrillic a. The eye reads apple.com and the
  // browser goes to xn--pple-43d.com, so showing the payload beside an anchor
  // that resolves it shows the human one address and opens another. (A payload
  // carrying a bidi override never gets this far — it is refused outright, and
  // `NEVER_OPENABLE` covers that.)
  const homograph = "https://аpple.com/verify?token=abc"
  const resolved = new URL(homograph).href
  expect(resolved).not.toBe(homograph)
  expect(resolved).toContain("xn--pple-43d.com")

  agent.send({
    type: "links",
    links: [{ text: homograph, kind: "url" }],
    source: "qr",
  })
  await waitForSheet(true)

  // Shown, anchored and copied: one string, and it is the resolved one.
  expect(await sheetTexts()).toEqual([resolved])
  expect(
    await page.locator("#sheet-links a.link-action").getAttribute("href"),
  ).toBe(resolved)
  expect(
    await page.locator("#sheet-links .link-note").first().textContent(),
  ).toContain("wrote this address differently")
  expect(consoleErrors).toEqual([])
})

test("a dialer string and an authenticator secret are named, not opened", async () => {
  await showFrame()
  // "Not a link" says nothing useful about either of these, and both are
  // things a human should hand to an app deliberately rather than in one tap
  // from a page nobody vetted.
  agent.send({
    type: "links",
    links: [
      { text: "tel:*21*1234567890%23", kind: "url" },
      {
        text: "otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP",
        kind: "url",
      },
    ],
    source: "qr",
  })
  await waitForSheet(true)

  expect(await page.locator("#sheet-links a").count()).toBe(0)
  const notes = await page.locator("#sheet-links .link-note").allTextContents()
  expect(notes[0]).toContain("Phone number")
  expect(notes[1]).toContain("Authenticator secret")
  expect(consoleErrors).toEqual([])
})

test("the host of an openable link is the loud part of it", async () => {
  await showFrame()
  agent.send({
    type: "links",
    links: [{ text: QR_LINK, kind: "url" }],
    source: "qr",
  })
  await waitForSheet(true)

  // The one question a human answers before tapping Open is whose site this
  // is, and on a 390px screen the host is otherwise a few characters lost in
  // a token.
  const host = page.locator("#sheet-links .link-host")
  expect(await host.textContent()).toBe("verify.example.com")
  const weights = await page.evaluate(() => {
    const loud = document.querySelector("#sheet-links .link-host")
    const rest = document.querySelector("#sheet-links .link-text > span")
    if (!loud || !rest) return null
    return {
      loud: getComputedStyle(loud).fontWeight,
      quiet: getComputedStyle(rest).color,
      loudColour: getComputedStyle(loud).color,
    }
  })
  expect(Number(weights?.loud)).toBeGreaterThanOrEqual(600)
  expect(weights?.quiet).not.toBe(weights?.loudColour)
  expect(consoleErrors).toEqual([])
})

test("an ordinary link is shown verbatim, with no note about it", async () => {
  await showFrame()
  agent.send({
    type: "links",
    links: [{ text: QR_LINK, kind: "url" }],
    source: "qr",
  })
  await waitForSheet(true)

  expect(await sheetTexts()).toEqual([QR_LINK])
  expect(await page.locator("#sheet-links .link-note").count()).toBe(0)
  expect(consoleErrors).toEqual([])
})

test("normalising a link is not the same as changing it", async () => {
  await showFrame()
  // Both of these come back from the URL parser as a different string — a
  // trailing slash appears, a capital is lowered — and neither is a deception.
  // A bare domain is one of the commonest shapes a QR code has, and a warning
  // that fires on it is a warning the human learns to tap past, which is
  // exactly when the homograph case needs it to land.
  agent.send({
    type: "links",
    links: [
      { text: "https://example.com", kind: "url" },
      { text: "HTTPS://Example.COM/Path", kind: "url" },
    ],
    source: "qr",
  })
  await waitForSheet(true)

  expect(await sheetTexts()).toEqual([
    "https://example.com/",
    "https://example.com/Path",
  ])
  expect(await page.locator("#sheet-links .link-note").count()).toBe(0)
  expect(await page.locator("#sheet-links a.link-action").count()).toBe(2)
  expect(consoleErrors).toEqual([])
})

test("the result sheet stays reachable after the handoff ends", async () => {
  await showFrame()
  agent.send({
    type: "links",
    links: [{ text: QR_LINK, kind: "url" }],
    source: "qr",
  })
  await waitForSheet(true)

  // The feature's own happy path: the human reads the link and the handoff ends
  // before they tap Open — they hand back, or it times out. The ending overlay
  // is opaque and covers the whole screen, so if it wins the stacking order the
  // link is gone, with the button disabled and no way to scan again.
  agent.send({ type: "ended", outcome: "resolved" })
  await waitForOverlay(page)

  const onTop = await page.evaluate(() => {
    const anchor = document.querySelector("#sheet-links a.link-action")
    if (!anchor) return "no anchor"
    const box = anchor.getBoundingClientRect()
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    )
    return hit?.closest("#sheet") ? "sheet" : (hit?.id ?? hit?.tagName ?? "?")
  })
  expect(onTop).toBe("sheet")
  expect(consoleErrors).toEqual([])
})

test("a malformed links message neither throws nor wedges the button", async () => {
  await showFrame()
  await page.locator("#key-qr").click()
  await page.waitForFunction(() => {
    const button = document.getElementById("key-qr")
    return button instanceof HTMLButtonElement && button.disabled
  })

  // A null, a number and an object with no text. This used to throw out of the
  // message handler, which skipped the code that releases the button — leaving
  // it dead for the full twelve-second deadline, with no sheet and no reason.
  // Sent as bytes rather than as a typed message: the protocol has no way to
  // describe this, and casting one into shape would be the same lie the page
  // is being tested against.
  agent.sendRaw(
    '{"type":"links","links":[null,5,{"kind":"url"}],"source":"qr"}',
  )
  await waitForSheet(true)

  expect(await sheetTexts()).toEqual([])
  expect(await page.locator("#sheet-title").textContent()).toBe(
    "No QR code found",
  )
  expect(await page.locator("#key-qr").isEnabled()).toBe(true)
  expect(consoleErrors).toEqual([])
})

test("a QR payload reaches the sheet as text, never as markup", async () => {
  await showFrame()
  const payload = '<img src=x onerror="window.__handraisePwned = 1">'
  agent.send({
    type: "links",
    links: [{ text: payload, kind: "text" }],
    source: "qr",
  })
  await waitForSheet(true)

  expect(await sheetTexts()).toEqual([payload])
  expect(await page.locator("#sheet-links img").count()).toBe(0)
  expect(consoleErrors).toEqual([])
})

test("two codes are both listed, and the sheet says there are two", async () => {
  await showFrame()
  agent.send({
    type: "links",
    links: [
      { text: QR_LINK, kind: "url" },
      { text: "WIFI:S:GuestNet;T:WPA;P:hunter2;;", kind: "text" },
    ],
    source: "qr",
  })
  await waitForSheet(true)

  expect(await page.locator("#sheet-title").textContent()).toBe(
    "2 codes on the page",
  )
  expect(await sheetTexts()).toEqual([
    QR_LINK,
    "WIFI:S:GuestNet;T:WPA;P:hunter2;;",
  ])
  expect(await page.locator("#sheet-links a").count()).toBe(1)
  expect(consoleErrors).toEqual([])
})

test("a scan the agent never answers releases the button and says why", async () => {
  await reopenFixture("takeover", false, true)
  await showFrame()
  await page.locator("#key-qr").click()
  await page.waitForFunction(() => {
    const button = document.getElementById("key-qr")
    return button instanceof HTMLButtonElement && button.disabled
  })

  // The agent drops a scan that came too soon, or has gone away entirely.
  // Without a deadline the button would stay dead for the rest of the session.
  await page.clock.fastForward(12_000)
  await page.waitForFunction(() => {
    const button = document.getElementById("key-qr")
    return button instanceof HTMLButtonElement && !button.disabled
  })
  expect(await page.locator("#hint").textContent()).toBe(
    "The agent didn't answer — try again",
  )
  expect(await page.locator("#sheet").isHidden()).toBe(true)
  expect(consoleErrors).toEqual([])
})
