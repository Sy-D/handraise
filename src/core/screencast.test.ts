/**
 * The pump's contract in three properties: the frame goes out with metadata
 * the phone can map a tap against, the ack goes out *after* the frame (that is
 * the flow control), and the ack goes out even when the frame did not.
 *
 *   bun test src/core/
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import type { FrameMeta } from "../relay/protocol"
import {
  type CdpScreencast,
  DEFAULT_PROFILE,
  jpegSize,
  type ScreencastFrame,
  startFramePump,
} from "./screencast"

/** A real 800x500 q60 screencast frame of the GitHub login page (spike S2). */
const SAMPLE_JPEG = fileURLToPath(
  new URL("../../spikes/s2/sample-frame.jpg", import.meta.url),
)

/** The Page.* parameters the pump sends. */
interface CdpParams {
  format?: string
  quality?: number
  maxWidth?: number
  maxHeight?: number
  everyNthFrame?: number
  sessionId?: number
}

interface CdpCall {
  method: string
  params: CdpParams
}

interface FakeCdp {
  cdp: CdpScreencast
  calls: CdpCall[]
  /** Everything that happened, in order: command names plus whatever a test adds. */
  log: string[]
  emit(frame: ScreencastFrame): void
  listeners(): number
}

function fakeCdp(): FakeCdp {
  const calls: CdpCall[] = []
  const log: string[] = []
  const handlers = new Set<(frame: ScreencastFrame) => void>()
  return {
    calls,
    log,
    emit(frame) {
      for (const handler of handlers) handler(frame)
    },
    listeners: () => handlers.size,
    cdp: {
      send: async (method, params) => {
        // SAFETY: the pump only sends Page.enable, Page.startScreencast,
        // Page.screencastFrameAck and Page.stopScreencast, whose parameters
        // are flat numbers and strings.
        calls.push({ method, params: { ...params } as CdpParams })
        log.push(method)
        // SAFETY: the pump awaits every command and discards its value, so no
        // member of CommandReturnValues is ever read.
        return {} as never
      },
      on: (_event, listener) => {
        handlers.add(listener)
      },
      off: (_event, listener) => {
        handlers.delete(listener)
      },
    },
  }
}

function frameOf(data: string): ScreencastFrame {
  return {
    data,
    sessionId: 7,
    metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1 },
  }
}

test("the JPEG's true size is read from the JPEG, not from the request", () => {
  const bytes = readFileSync(SAMPLE_JPEG)
  expect(jpegSize(bytes)).toEqual({ width: 800, height: 500 })
})

test("jpegSize refuses anything that is not a JPEG", () => {
  expect(jpegSize(Buffer.from("not an image at all, really"))).toBeNull()
  expect(jpegSize(new Uint8Array([0xff, 0xd8]))).toBeNull()
  expect(jpegSize(new Uint8Array(0))).toBeNull()
})

test("starting the pump enables Page and requests the profile", async () => {
  const fake = fakeCdp()
  const pump = await startFramePump(fake.cdp, DEFAULT_PROFILE, () =>
    Promise.resolve(),
  )

  expect(fake.calls.map((call) => call.method)).toEqual([
    "Page.enable",
    "Page.startScreencast",
  ])
  expect(fake.calls[1]?.params).toMatchObject({
    format: "jpeg",
    quality: 60,
    maxWidth: 800,
    maxHeight: 1400,
    everyNthFrame: 1,
  })
  expect(pump.lastMeta()).toBeNull()
  await pump.stop()
})

test("a frame reaches the relay with metadata the phone can map against", async () => {
  const fake = fakeCdp()
  const jpeg = readFileSync(SAMPLE_JPEG).toString("base64")
  const seen: { data: string; meta: FrameMeta }[] = []
  const pump = await startFramePump(fake.cdp, DEFAULT_PROFILE, (data, meta) => {
    seen.push({ data, meta })
    return Promise.resolve()
  })

  fake.emit(frameOf(jpeg))
  await Bun.sleep(5)

  expect(seen).toHaveLength(1)
  expect(seen[0]?.data).toBe(jpeg)
  expect(seen[0]?.meta).toEqual({
    deviceWidth: 1280,
    deviceHeight: 800,
    jpegWidth: 800,
    jpegHeight: 500,
    pageScaleFactor: 1,
  })
  expect(pump.lastMeta()).toEqual(seen[0]?.meta ?? null)
  expect(pump.frameCount()).toBe(1)
  await pump.stop()
})

test("the ack is sent after the frame is written, which is the flow control", async () => {
  // Without this ordering Chromium never throttles and the relay buffers; with
  // the ack missing entirely the cast stops after about three frames.
  const fake = fakeCdp()
  const pump = await startFramePump(fake.cdp, DEFAULT_PROFILE, async () => {
    await Bun.sleep(20)
    fake.log.push("frame written to the relay")
  })

  fake.emit(frameOf("Zmxlc2gtd291bmQ="))
  await Bun.sleep(60)

  expect(fake.log).toEqual([
    "Page.enable",
    "Page.startScreencast",
    "frame written to the relay",
    "Page.screencastFrameAck",
  ])
  await pump.stop()
})

test("a frame the relay refuses is still acknowledged", async () => {
  const fake = fakeCdp()
  const pump = await startFramePump(fake.cdp, DEFAULT_PROFILE, () =>
    Promise.reject(new Error("socket is down")),
  )

  fake.emit(frameOf("Zmxlc2gtd291bmQ="))
  await Bun.sleep(10)

  const ack = fake.calls.find((c) => c.method === "Page.screencastFrameAck")
  expect(ack?.params.sessionId).toBe(7)
  // The frame was dropped, but the stream stays alive.
  expect(pump.frameCount()).toBe(0)
  await pump.stop()
})

test("an unreadable frame falls back to the profile's scaling", async () => {
  const fake = fakeCdp()
  const pump = await startFramePump(fake.cdp, DEFAULT_PROFILE, () =>
    Promise.resolve(),
  )

  fake.emit(frameOf(Buffer.from("this is not a jpeg").toString("base64")))
  await Bun.sleep(5)

  // 1280x800 clamped to maxWidth 800 is 800x500 — the same answer the JPEG
  // would have given, derived instead of read.
  expect(pump.lastMeta()).toEqual({
    deviceWidth: 1280,
    deviceHeight: 800,
    jpegWidth: 800,
    jpegHeight: 500,
    pageScaleFactor: 1,
  })
  await pump.stop()
})

test("a superseded frame is acked but never sent, so only the newest is shown", async () => {
  const fake = fakeCdp()
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const seen: string[] = []
  const pump = await startFramePump(fake.cdp, DEFAULT_PROFILE, async (data) => {
    seen.push(data)
    // Hold the first frame in flight so the next two queue behind it.
    if (seen.length === 1) await gate
  })

  fake.emit(frameOf("AAAA")) // enters flight, blocks on the gate
  await Bun.sleep(5)
  fake.emit(frameOf("BBBB")) // becomes the pending frame
  fake.emit(frameOf("CCCC")) // supersedes BBBB: acked, never sent
  await Bun.sleep(5)
  release()
  await Bun.sleep(20)

  // The stale middle frame was dropped; the phone jumps to the freshest one.
  expect(seen).toEqual(["AAAA", "CCCC"])
  // Every emitted frame is still acked, or Chromium would stop the cast.
  const acks = fake.calls.filter((c) => c.method === "Page.screencastFrameAck")
  expect(acks.length).toBe(3)
  await pump.stop()
})

test("stopping detaches the listener and ignores frames still in flight", async () => {
  const fake = fakeCdp()
  let delivered = 0
  const pump = await startFramePump(fake.cdp, DEFAULT_PROFILE, () => {
    delivered += 1
    return Promise.resolve()
  })
  expect(fake.listeners()).toBe(1)

  await pump.stop()
  fake.emit(frameOf("Zmxlc2gtd291bmQ="))
  await Bun.sleep(5)

  expect(delivered).toBe(0)
  expect(fake.listeners()).toBe(0)
  expect(fake.calls.some((c) => c.method === "Page.stopScreencast")).toBe(true)
})
