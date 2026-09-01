/**
 * The forward channel: CDP screencast frames out of the remote page and down
 * to the phone.
 *
 * The design comes from spikes/s2-report.md. Two facts do all the work:
 *
 * 1. `Page.screencastFrameAck` is mandatory *and* it is the only flow control
 *    the API has. Chromium allows a couple of unacknowledged frames and then
 *    stops sending entirely (measured: 3 frames in 8.3 s without acks, versus
 *    199 with). So the ack is deliberately sent **after** the frame has been
 *    written to the relay socket: Chromium then paces itself to whatever the
 *    downstream link carries, with no queue growth and no stale frames.
 * 2. The frame is scaled to `maxWidth`; the metadata is not. `deviceWidth`
 *    still reports the CSS viewport. The phone needs both numbers to map a tap
 *    back, and the JPEG's true size is only available from the JPEG itself.
 */
import type { CDPSession } from "playwright-core"

import type { FrameMeta } from "../relay/protocol"

/** JPEG quality and pixel ceiling for the cast. */
export interface ScreencastProfile {
  quality: number
  maxWidth: number
  maxHeight: number
}

/**
 * Legible for form filling at ~12 KB/frame; measured 79 KB/s while a human
 * types and 23 KB/s while they read. The cheap alternative is quality 40 at
 * 480 px, which is 3.5x cheaper under continuous motion.
 */
export const DEFAULT_PROFILE: ScreencastProfile = {
  quality: 60,
  maxWidth: 800,
  maxHeight: 1400,
}

/** The subset of `Page.screencastFrame` this module reads. */
export interface ScreencastFrame {
  data: string
  sessionId: number
  metadata: {
    deviceWidth: number
    deviceHeight: number
    pageScaleFactor: number
  }
}

/**
 * The slice of Playwright's `CDPSession` this module uses. A real `CDPSession`
 * satisfies it; so does a fake, which is how the pump is tested without a
 * browser. `send` keeps the protocol's own typing.
 */
export interface CdpScreencast {
  send: CDPSession["send"]
  on(
    event: "Page.screencastFrame",
    listener: (frame: ScreencastFrame) => void,
  ): void
  off(
    event: "Page.screencastFrame",
    listener: (frame: ScreencastFrame) => void,
  ): void
}

export interface FramePump {
  /** Metadata of the newest frame, or `null` before the first one arrives. */
  lastMeta(): FrameMeta | null
  /** Frames handed to the relay since the cast started. */
  frameCount(): number
  /** Stop the cast and detach the listener. Best effort; never throws. */
  stop(): Promise<void>
}

/** Pixel dimensions of a decoded image. */
export interface PixelSize {
  width: number
  height: number
}

/**
 * Read the pixel size out of a JPEG's SOFn marker.
 *
 * Returns `null` for anything that is not a parseable JPEG, so the caller can
 * fall back rather than ship a frame with coordinates that lie.
 */
export function jpegSize(bytes: Uint8Array): PixelSize | null {
  if ((bytes[0] ?? 0) !== 0xff || (bytes[1] ?? 0) !== 0xd8) return null
  const u16 = (at: number): number =>
    ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)

  let index = 2
  while (index < bytes.length - 9) {
    if ((bytes[index] ?? 0) !== 0xff) {
      index += 1
      continue
    }
    const marker = bytes[index + 1] ?? 0
    // Standalone markers (padding, RSTn) carry no length field.
    if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9)) {
      index += 2
      continue
    }
    const length = u16(index + 2)
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    if (isStartOfFrame) {
      return { height: u16(index + 5), width: u16(index + 7) }
    }
    if (length < 2) return null
    index += 2 + length
  }
  return null
}

/**
 * What Chromium would produce if the SOF marker cannot be read: the viewport,
 * scaled down by whichever ceiling binds. Aspect ratio is preserved, so one
 * factor covers both axes.
 */
function estimateJpegSize(
  metadata: ScreencastFrame["metadata"],
  profile: ScreencastProfile,
): PixelSize {
  const scale = Math.min(
    1,
    profile.maxWidth / metadata.deviceWidth,
    profile.maxHeight / metadata.deviceHeight,
  )
  const usable = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    width: Math.round(metadata.deviceWidth * usable),
    height: Math.round(metadata.deviceHeight * usable),
  }
}

/**
 * Start the cast and pump every frame through `send`.
 *
 * `send` is awaited before the frame is acknowledged — that is the throttle.
 * If it rejects, the frame is dropped and the ack still goes out, because a
 * missing ack stops the stream permanently and a dropped frame costs 80 ms.
 */
export async function startFramePump(
  cdp: CdpScreencast,
  profile: ScreencastProfile,
  send: (data: string, meta: FrameMeta) => Promise<void>,
): Promise<FramePump> {
  let meta: FrameMeta | null = null
  let frames = 0
  let stopped = false
  // Newest-frame-wins: at most one frame waits behind the one in flight. A
  // human that stops reading makes the relay drop frames downstream, but the
  // ack still gates Chromium here, so without this a burst could still queue
  // stale frames. A superseded frame is acked (so Chromium keeps flowing) but
  // never sent, so the phone only ever gets the freshest image.
  let inFlight = false
  let pending: ScreencastFrame | null = null

  // The JPEG size only changes when the viewport does, so parse it once per
  // viewport instead of base64-decoding thirteen frames a second.
  let cachedFor = ""
  let cachedSize = { width: 0, height: 0 }

  const sizeOf = (frame: ScreencastFrame): PixelSize => {
    const key = `${frame.metadata.deviceWidth}x${frame.metadata.deviceHeight}`
    if (key === cachedFor) return cachedSize
    const parsed =
      jpegSize(Buffer.from(frame.data, "base64")) ??
      estimateJpegSize(frame.metadata, profile)
    cachedFor = key
    cachedSize = parsed
    return parsed
  }

  const ack = (sessionId: number): Promise<void> =>
    cdp
      .send("Page.screencastFrameAck", { sessionId })
      .then(() => undefined)
      .catch(() => undefined)

  const processFrame = async (frame: ScreencastFrame): Promise<void> => {
    const size = sizeOf(frame)
    const current: FrameMeta = {
      deviceWidth: frame.metadata.deviceWidth,
      deviceHeight: frame.metadata.deviceHeight,
      jpegWidth: size.width,
      jpegHeight: size.height,
      pageScaleFactor: frame.metadata.pageScaleFactor,
    }
    meta = current
    try {
      await send(frame.data, current)
      frames += 1
    } catch {
      // A frame the relay refused is worthless; the next one is 80 ms away.
    }
    // The ack is the throttle: sent only after the frame reached the relay, so
    // Chromium paces itself to the downstream link. Never skip it — a missing
    // ack stops the cast entirely.
    await ack(frame.sessionId)
  }

  const drain = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    while (pending && !stopped) {
      const frame = pending
      pending = null
      await processFrame(frame)
    }
    inFlight = false
  }

  const onFrame = (frame: ScreencastFrame): void => {
    if (stopped) return
    // A frame still waiting is now stale; ack it so Chromium keeps sending, and
    // replace it with the newer one rather than growing a backlog.
    if (pending) void ack(pending.sessionId)
    pending = frame
    void drain()
  }

  cdp.on("Page.screencastFrame", onFrame)
  await cdp.send("Page.enable")
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: profile.quality,
    maxWidth: profile.maxWidth,
    maxHeight: profile.maxHeight,
    everyNthFrame: 1,
  })

  return {
    lastMeta: () => meta,
    frameCount: () => frames,
    async stop() {
      stopped = true
      cdp.off("Page.screencastFrame", onFrame)
      await cdp.send("Page.stopScreencast").catch(() => undefined)
    },
  }
}
