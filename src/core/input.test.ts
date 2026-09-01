/**
 * The coordinate maths is pure, so it is tested as maths. The CDP dispatch is
 * tested by recording what would go on the wire — the exact event shapes were
 * verified against a live browser in spikes/s3-report.md, and this file exists
 * to stop them drifting.
 *
 *   bun test src/core/
 */
import { expect, test } from "bun:test"

import type { FrameMeta, HumanToAgent } from "../relay/protocol"
import {
  type CdpChannel,
  createInputTarget,
  frameDeltaToPage,
  frameToPage,
  viewportCentre,
} from "./input"

/** A 1280x800 viewport cast at maxWidth 800: scale 0.625 on both axes. */
const META: FrameMeta = {
  deviceWidth: 1280,
  deviceHeight: 800,
  jpegWidth: 800,
  jpegHeight: 500,
  pageScaleFactor: 1,
}

/** The Input.* parameters handraise sends, as far as this file asserts on them. */
interface CdpParams {
  type?: string
  key?: string
  code?: string
  text?: string
  unmodifiedText?: string
  windowsVirtualKeyCode?: number
  nativeVirtualKeyCode?: number
  x?: number
  y?: number
  button?: string
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
}

interface CdpCall {
  method: string
  params: CdpParams
}

interface Recorder {
  cdp: CdpChannel
  calls: CdpCall[]
}

function recorder(delayFirstMs = 0): Recorder {
  const calls: CdpCall[] = []
  let first = true
  const cdp: CdpChannel = {
    send: async (method, params) => {
      const slow = first && delayFirstMs > 0
      first = false
      if (slow) await Bun.sleep(delayFirstMs)
      // SAFETY: this file only drives Input.* commands, whose parameters are
      // coordinates, key codes and flags — no nested object reaches here.
      calls.push({ method, params: { ...params } as CdpParams })
      // SAFETY: handraise never reads a CDP command result — every call site
      // awaits the round trip and discards the value — so no member of
      // CommandReturnValues is ever observed.
      return {} as never
    },
  }
  return { cdp, calls }
}

test("a tap in the middle of the frame lands in the middle of the viewport", () => {
  expect(frameToPage(400, 250, META)).toEqual({ x: 640, y: 400 })
})

test("the frame is scaled and the metadata is not", () => {
  // The trap from spikes/s2-report.md: deviceWidth still says 1280 while the
  // JPEG is 800 wide. Dividing by the ratio of the two is the whole mapping.
  expect(frameToPage(800, 500, META)).toEqual({ x: 1280, y: 800 })
  expect(frameToPage(0, 0, META)).toEqual({ x: 0, y: 0 })
})

test("pinch zoom divides the mapped point", () => {
  const zoomed: FrameMeta = { ...META, pageScaleFactor: 2 }
  expect(frameToPage(400, 250, zoomed)).toEqual({ x: 320, y: 200 })
})

test("degenerate metadata maps 1:1 instead of producing Infinity", () => {
  const broken: FrameMeta = {
    deviceWidth: 0,
    deviceHeight: 0,
    jpegWidth: 800,
    jpegHeight: 500,
    pageScaleFactor: 0,
  }
  expect(frameToPage(120, 60, broken)).toEqual({ x: 120, y: 60 })
})

test("a scroll delta is scaled but never flipped", () => {
  // 43 frame pixels is what the mobile UI sends for a 20 px finger drag.
  expect(frameDeltaToPage(43, META)).toBeCloseTo(68.8, 6)
  expect(frameDeltaToPage(-43, META)).toBeCloseTo(-68.8, 6)
})

test("the default scroll anchor is the middle of the viewport", () => {
  expect(viewportCentre(META)).toEqual({ x: 640, y: 400 })
})

test("a tap becomes hover, press and release at the mapped point", async () => {
  const { cdp, calls } = recorder()
  await createInputTarget(cdp).apply({ type: "tap", fx: 400, fy: 250 }, META)

  expect(calls.map((call) => call.params.type)).toEqual([
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
  ])
  for (const call of calls) {
    expect(call.method).toBe("Input.dispatchMouseEvent")
    expect(call.params.x).toBe(640)
    expect(call.params.y).toBe(400)
  }
  expect(calls[1]?.params.clickCount).toBe(1)
  expect(calls[1]?.params.button).toBe("left")
})

test("a character is typed as keyDown with text, never as insertText", async () => {
  const { cdp, calls } = recorder()
  await createInputTarget(cdp).apply({ type: "char", ch: "7" }, META)

  expect(calls.map((call) => call.method)).toEqual([
    "Input.dispatchKeyEvent",
    "Input.dispatchKeyEvent",
  ])
  expect(calls[0]?.params).toMatchObject({
    type: "keyDown",
    key: "7",
    text: "7",
    unmodifiedText: "7",
    windowsVirtualKeyCode: 55,
  })
  expect(calls[1]?.params.type).toBe("keyUp")
  // insertText fires no keydown, which breaks split OTP boxes (S3 trap 2).
  expect(calls.some((call) => call.method === "Input.insertText")).toBe(false)
})

test("Enter carries text so that Blink fires keypress and submits the form", async () => {
  const { cdp, calls } = recorder()
  await createInputTarget(cdp).apply({ type: "key", key: "Enter" }, META)

  // Without `text`, this is a rawKeyDown: the page sees keydown, no keypress,
  // and the form is never submitted. That failure is invisible in a log.
  expect(calls[0]?.params).toMatchObject({
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
  })
  expect(calls[1]?.params.type).toBe("keyUp")
})

test("Backspace and Tab are rawKeyDown with no text", async () => {
  const { cdp, calls } = recorder()
  const target = createInputTarget(cdp)
  await target.apply({ type: "key", key: "Backspace" }, META)
  await target.apply({ type: "key", key: "Tab" }, META)

  expect(calls[0]?.params).toMatchObject({
    type: "rawKeyDown",
    key: "Backspace",
    windowsVirtualKeyCode: 8,
  })
  expect(calls[0]?.params.text).toBeUndefined()
  expect(calls[2]?.params).toMatchObject({
    type: "rawKeyDown",
    key: "Tab",
    windowsVirtualKeyCode: 9,
  })
  expect(calls[2]?.params.text).toBeUndefined()
})

test("a scroll before any tap is aimed at the viewport centre", async () => {
  const { cdp, calls } = recorder()
  await createInputTarget(cdp).apply({ type: "scroll", fdy: 43 }, META)

  expect(calls[0]?.params.type).toBe("mouseWheel")
  expect(calls[0]?.params.x).toBe(640)
  expect(calls[0]?.params.y).toBe(400)
  expect(calls[0]?.params.deltaY).toBeCloseTo(68.8, 6)
})

test("a scroll after a tap is aimed at the tap", async () => {
  const { cdp, calls } = recorder()
  const target = createInputTarget(cdp)
  await target.apply({ type: "tap", fx: 100, fy: 100 }, META)
  await target.apply({ type: "scroll", fdy: -10 }, META)

  const wheel = calls.at(-1)
  expect(wheel?.params.type).toBe("mouseWheel")
  expect(wheel?.params.x).toBe(160)
  expect(wheel?.params.y).toBe(160)
  expect(target.anchor(META)).toEqual({ x: 160, y: 160 })
})

test("handback and abort dispatch no input at all", async () => {
  const { cdp, calls } = recorder()
  const target = createInputTarget(cdp)
  await target.apply({ type: "handback" }, META)
  await target.apply({ type: "abort" }, META)
  expect(calls).toEqual([])
})

test("applied counts real inputs, never dropped or lifecycle messages", async () => {
  const { cdp } = recorder()
  const target = createInputTarget(cdp)
  await target.apply({ type: "tap", fx: 400, fy: 250 }, META)
  await target.apply({ type: "char", ch: "7" }, META)
  await target.apply({ type: "key", key: "Enter" }, META)
  await target.apply({ type: "scroll", fdy: 43 }, META)
  // None of these reach the page, so none may be counted.
  await target.apply({ type: "char", ch: "too long" }, META)
  await target.apply(untrusted('{"type":"key","key":"F1"}'), META)
  await target.apply({ type: "handback" }, META)
  await target.apply({ type: "abort" }, META)

  expect(target.applied()).toBe(4)
})

/**
 * A message straight off the wire, before any narrowing. The relay forwards
 * bytes verbatim, so a hostile phone can send JSON the type system forbids; the
 * runtime guards under test are exactly what must reject it.
 */
function untrusted(json: string): HumanToAgent {
  // SAFETY: this is the trust boundary — JSON.parse yields the raw shape and the
  // module's own runtime checks decide whether to act on it.
  return JSON.parse(json) as HumanToAgent
}

test("a key outside the table is dropped, never dispatched", async () => {
  const { cdp, calls } = recorder()
  const target = createInputTarget(cdp)
  // "constructor" would otherwise index a prototype member of KEY_TABLE.
  await target.apply(untrusted('{"type":"key","key":"constructor"}'), META)
  await target.apply(untrusted('{"type":"key","key":"F1"}'), META)
  expect(calls).toEqual([])
})

test("a char that is not exactly one code unit is dropped", async () => {
  const { cdp, calls } = recorder()
  const target = createInputTarget(cdp)
  await target.apply({ type: "char", ch: "" }, META)
  await target.apply({ type: "char", ch: "abc" }, META)
  await target.apply({ type: "char", ch: "x".repeat(100_000) }, META)
  expect(calls).toEqual([])
  // A single character still gets through: keyDown + keyUp.
  await target.apply({ type: "char", ch: "7" }, META)
  expect(calls.length).toBe(2)
})

test("the input queue drops messages past its depth cap", async () => {
  // Hold the first dispatch so the whole flood queues behind it synchronously.
  const { cdp, calls } = recorder(50)
  const target = createInputTarget(cdp)
  const inflight: Promise<void>[] = []
  for (let i = 0; i < 400; i++) {
    inflight.push(target.apply({ type: "char", ch: "1" }, META))
  }
  await Promise.all(inflight)
  // Exactly 256 admitted, each dispatched as keyDown + keyUp; 144 dropped.
  expect(calls.length).toBe(256 * 2)
})

test("drain resolves only after queued input has been dispatched", async () => {
  const { cdp, calls } = recorder(30)
  const target = createInputTarget(cdp)
  void target.apply({ type: "char", ch: "1" }, META)
  void target.apply({ type: "char", ch: "2" }, META)
  await target.drain()
  expect(calls.length).toBe(4)
})

test("two keystrokes in flight at once stay in order", async () => {
  // A human typing a 6-digit code sends characters faster than a round trip
  // to us-west takes. Interleaved key events would produce "17" from "71".
  const { cdp, calls } = recorder(40)
  const target = createInputTarget(cdp)
  const first = target.apply({ type: "char", ch: "7" }, META)
  const second = target.apply({ type: "char", ch: "1" }, META)
  await Promise.all([first, second])

  expect(calls.map((call) => `${call.params.type}:${call.params.key}`)).toEqual(
    ["keyDown:7", "keyUp:7", "keyDown:1", "keyUp:1"],
  )
})
