/**
 * The one frame an approval sends.
 *
 * Approval mode asks a question about a moment, not about a session: the human
 * decides on what the page looked like when the agent stopped. So there is no
 * screencast, no ack loop and no CDP session here — a single JPEG, taken the
 * way Playwright takes any screenshot.
 *
 * It is deliberately not scaled to the screencast's 800px profile. One frame
 * costs what a tenth of a second of cast costs, and the human is reading an
 * amount and a payee off it, so the pixels are worth more than the bytes.
 */
import type { Page } from "playwright-core"

import type { FrameMeta } from "../relay/protocol"
import { jpegSize } from "./screencast"

/**
 * Same quality as the live cast (docs/measurements/02-cdp-screencast.md).
 * Legible for reading a form back, and small enough for a chat message: a
 * 1280x800 viewport lands well inside a megabyte.
 */
export const APPROVAL_QUALITY = 60

/** The viewport assumed when the page cannot report one (a headless default). */
const FALLBACK_VIEWPORT = { width: 1280, height: 800 }

export interface ApprovalFrame {
  /** Base64 JPEG, in the same shape a screencast frame arrives in. */
  data: string
  meta: FrameMeta
}

/**
 * Take the screenshot the human decides on.
 *
 * The metadata is filled the same way the pump fills it, so the phone's
 * letterbox and zoom maths cannot tell the two kinds of frame apart:
 * `deviceWidth`/`deviceHeight` are the page's CSS viewport and the jpeg size
 * is read out of the JPEG itself.
 */
export async function captureApprovalFrame(page: Page): Promise<ApprovalFrame> {
  const shot = await page.screenshot({
    type: "jpeg",
    quality: APPROVAL_QUALITY,
  })
  const viewport = page.viewportSize() ?? FALLBACK_VIEWPORT
  const size = jpegSize(shot) ?? {
    width: viewport.width,
    height: viewport.height,
  }
  return {
    data: shot.toString("base64"),
    meta: {
      deviceWidth: viewport.width,
      deviceHeight: viewport.height,
      jpegWidth: size.width,
      jpegHeight: size.height,
      pageScaleFactor: 1,
    },
  }
}
