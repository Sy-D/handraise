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

import type { FrameMeta, RelayMessage } from "../src/relay/protocol"

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
  const waiters: ((message: RelayMessage) => void)[] = []

  socket.on("message", (raw: Buffer) => {
    const message = parseMessage(raw.toString("utf8"))
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

test("hand back sends handback and shows the handed-back overlay", async () => {
  await showFrame()

  await page.locator("#handback").click()
  expect(await agent.next()).toEqual({ type: "handback" })

  await waitForOverlay(page)
  expect(await page.locator("#overlay-title").textContent()).toBe("Handed back")
  expect(consoleErrors).toEqual([])
})

test("abort sends abort and shows the aborted overlay", async () => {
  await showFrame()

  await page.locator("#abort").click()
  expect(await agent.next()).toEqual({ type: "abort" })

  await waitForOverlay(page)
  expect(await page.locator("#overlay-title").textContent()).toBe("Aborted")
  expect(consoleErrors).toEqual([])
})

test("an ended message shows the matching terminal overlay", async () => {
  await showFrame()

  agent.send({ type: "ended", outcome: "disconnected" })

  await waitForOverlay(page)
  expect(await page.locator("#overlay-title").textContent()).toBe(
    "Session lost",
  )
  expect(await page.locator("#overlay-note").textContent()).toBe(
    "The browser session died. The agent knows.",
  )
  expect(consoleErrors).toEqual([])
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
