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

import type {
  FocusRect,
  FrameMeta,
  HumanToAgent,
  RelayMessage,
} from "../src/relay/protocol"

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
  next(): Promise<RelayMessage>
  /** Every message this socket has seen, in order. `next()` never consumes it,
   *  so a test can assert that something was sent *exactly once*. */
  received: RelayMessage[]
  close(): void
}

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

/** Start the real guest server on an OS-assigned port; read the port from its log. */
function startRelay(): Promise<Relay> {
  const child = spawn(process.execPath, [SERVER_PATH, "0", AGENT_KEY], {
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

beforeEach(async () => {
  relay = await startRelay()
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
  await page.goto(`http://127.0.0.1:${relay.port}/`)
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

/**
 * Where the ring must end up, computed here the long way round so a mistake in
 * the page's own maths cannot cancel out: page CSS px → frame px (the JPEG
 * scaling Chromium left out of the metadata) → canvas px (this page's
 * letterbox). Viewport-relative, like every Playwright bounding box.
 */
function expectedRing(canvas: Box, frame: Box): Box {
  const kx =
    ((META.jpegWidth / META.deviceWidth) * META.pageScaleFactor * frame.w) /
    FRAME_W
  const ky =
    ((META.jpegHeight / META.deviceHeight) * META.pageScaleFactor * frame.h) /
    FRAME_H
  return {
    x: canvas.x + frame.x + FOCUS_RECT.x * kx,
    y: canvas.y + frame.y + FOCUS_RECT.y * ky,
    w: FOCUS_RECT.width * kx,
    h: FOCUS_RECT.height * ky,
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

const KEY_IDS = ["#key-back", "#key-tab", "#key-enter", "#key-clear"]

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

test("the key bar stays on one line on a narrow phone", async () => {
  await page.setViewportSize({ width: 320, height: 568 })
  await showFrame()

  const field = await page.locator("#kbd").boundingBox()
  const keys = await page.locator(".keys").boundingBox()
  if (!field || !keys) throw new Error("the input bar has no bounding box")

  // Same row, keys to the right of the field, and every tap target usable.
  expect(Math.abs(field.y - keys.y)).toBeLessThanOrEqual(6)
  expect(keys.x).toBeGreaterThan(field.x + field.width - 1)
  expect(field.width).toBeGreaterThan(60)
  for (const id of ["#key-back", "#key-clear", "#key-tab", "#key-enter"]) {
    const key = await page.locator(id).boundingBox()
    if (!key) throw new Error(`${id} has no bounding box`)
    expect(key.height).toBeGreaterThanOrEqual(44)
  }
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

  const canvas = await page.locator("#view").boundingBox()
  if (!canvas) throw new Error("canvas has no bounding box")
  const want = expectedRing(
    { x: canvas.x, y: canvas.y, w: canvas.width, h: canvas.height },
    letterbox(canvas.width, canvas.height),
  )

  agent.send({ type: "focus", rect: FOCUS_RECT, label: "Password" })
  await waitForRing(page, true)
  // Longer than the ring's 120 ms move transition, so the box read below is
  // the one it settled on and not a frame somewhere along the way.
  await page.waitForTimeout(200)

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
