/**
 * Reading the QR codes off the page the agent is stuck on.
 *
 * The case this exists for is a device-change check: reCAPTCHA, a WhatsApp Web
 * login, an authenticator enrolment, a payment code. The site draws a QR code
 * and says "scan this with your phone" — and the human handraise put in front
 * of it *is* on a phone, looking at the code through their own screen. A phone
 * cannot scan itself. Today that needs a second device.
 *
 * So the agent reads the code instead and sends the human the link.
 *
 * Three decisions, all argued in docs/adr/0008-qr-passthrough.md:
 *
 *   - It decodes in the agent process, from a fresh full-resolution
 *     `page.screenshot()`. Not from the cast frame, which is scaled to 800px
 *     and JPEG-compressed until a dense symbol is mush; and not in the remote
 *     page, whose JavaScript belongs to whoever the agent got stuck on.
 *   - Only on request. A scan is a screenshot plus a decode, so scanning every
 *     frame would cost that on a stream that already paces itself to a phone.
 *   - It classifies, it never opens. The agent process fetches nothing; the
 *     phone offers an "Open" button, and only for the schemes below.
 */
import jsQR, { type QRCode } from "jsqr"
import type { Page } from "playwright-core"

import { decodePng, type RgbaImage } from "./png"

/**
 * Whether the phone may offer to open this, or only to copy it.
 *
 * A QR code is an arbitrary string from a page the agent did not choose. Most
 * of them are links, and the useful ones are; the rest are a wifi credential, a
 * vCard, a plain sentence — worth showing, never worth handing to a browser.
 */
export type LinkKind = "url" | "text"

export interface ScannedLink {
  /** What the code carried, trimmed and capped. Shown as text either way. */
  text: string
  kind: LinkKind
}

/**
 * The schemes a phone is offered an "Open" button for.
 *
 * An allowlist and not a blocklist, because the interesting half of this list
 * is the half nobody thinks of: `javascript:` and `data:` are the two everyone
 * remembers, and `intent:`, `file:`, `content:` and whatever a phone browser
 * ships next year are the ones that would have got through a blocklist. The
 * four here are the ones a device-change QR actually uses.
 *
 * The phone checks this again before it builds the anchor. Two locks on one
 * door on purpose: the agent's `kind` travels over a socket the human's link
 * can reach, so it is a hint the page must not have to trust.
 */
export const OPENABLE_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "tel:",
  "mailto:",
  "otpauth:",
])

/**
 * A QR code holds up to 4296 characters. Past a couple of thousand it is not a
 * link any more, and the phone has to render it as one line of text.
 */
export const MAX_LINK_CHARS = 2048

/**
 * How many codes one scan reports.
 *
 * Pages that show a QR code show one. Two is what makes "there is more than
 * one here" sayable instead of silently picking; past that the sheet is a list
 * nobody reads on a phone, and the human can scroll the page and scan again.
 */
export const MAX_CODES = 2

/** Cap on the screenshot itself: a page that cannot paint must not hang a scan. */
const SCREENSHOT_TIMEOUT_MS = 5_000

/**
 * Whitespace, and everything below and around it in the code space.
 *
 * A link never needs any of it, and a payload that carries it is one trying to
 * look like something else: the URL parser silently drops a tab or a newline,
 * so what it validated and what the phone would show are two different
 * strings.
 */
function hasUnsafeCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

function isOpenable(text: string): boolean {
  if (text.length === 0 || hasUnsafeCharacter(text)) return false
  try {
    const url = new URL(text)
    // Credentials in the authority are the oldest way to make a link read as
    // one host and go to another: everything before the `@` is a username, and
    // a phone screen is exactly where that fits in the visible part. No
    // device-change link has ever needed them.
    if (url.username !== "" || url.password !== "") return false
    return OPENABLE_SCHEMES.has(url.protocol)
  } catch {
    // Not a URL at all: a wifi credential, a vCard, a sentence.
    return false
  }
}

/** Decide what one code's payload is, and what the phone may do with it. */
export function classifyLink(payload: string): ScannedLink {
  const text = payload.trim().slice(0, MAX_LINK_CHARS)
  return { text, kind: isOpenable(text) ? "url" : "text" }
}

/**
 * Paint over a symbol that has already been read.
 *
 * `jsQR` returns the first code it finds and has no way to ask for the next
 * one, so the only way to know whether the page holds a second is to remove the
 * first and look again. White, because that is the quiet zone every QR code is
 * already surrounded by.
 */
function maskOut(image: RgbaImage, location: QRCode["location"]): void {
  const xs = [
    location.topLeftCorner.x,
    location.topRightCorner.x,
    location.bottomLeftCorner.x,
    location.bottomRightCorner.x,
  ]
  const ys = [
    location.topLeftCorner.y,
    location.topRightCorner.y,
    location.bottomLeftCorner.y,
    location.bottomRightCorner.y,
  ]
  const left = Math.max(0, Math.floor(Math.min(...xs)) - 1)
  const right = Math.min(image.width - 1, Math.ceil(Math.max(...xs)) + 1)
  const top = Math.max(0, Math.floor(Math.min(...ys)) - 1)
  const bottom = Math.min(image.height - 1, Math.ceil(Math.max(...ys)) + 1)
  for (let y = top; y <= bottom; y++) {
    const row = y * image.width
    for (let x = left; x <= right; x++) {
      image.data.fill(255, (row + x) * 4, (row + x) * 4 + 4)
    }
  }
}

/** Read up to `MAX_CODES` payloads, painting each out before looking again. */
function readRepeatedly(image: RgbaImage): string[] {
  const found: string[] = []
  for (let pass = 0; pass < MAX_CODES; pass++) {
    const code = jsQR(image.data, image.width, image.height)
    if (!code) break
    // A payload seen twice is the same code found again, not a second one.
    if (code.data.length > 0 && !found.includes(code.data))
      found.push(code.data)
    maskOut(image, code.location)
  }
  return found
}

/**
 * How much bigger the second look is. Two is enough and three costs 4x the
 * pixels for nothing (both decode the fixture; measured in docs/measurements/05-qr.md).
 */
const MAGNIFY = 2

/**
 * Look again, twice the size.
 *
 * Nearest-neighbour, so not one new pixel of information — and that is the
 * point. `jsQR` binarizes in fixed 8x8 blocks, and a page that draws its code
 * at a size the browser has to resample lands a module boundary in the middle
 * of a block. A symbol that is perfectly sharp to the eye then fails to be
 * *located* while a tight crop of the same pixels decodes: the failure is the
 * block grid, not the image. Doubling it puts about ten pixels under each
 * module and the blocks line up again.
 *
 * Found the hard way. `src/core/fixtures/qr-centred.png` is the screenshot that
 * failed the first live run of the e2e, kept exactly as it came off the browser.
 */
function magnify(image: RgbaImage, factor: number): RgbaImage {
  const width = image.width * factor
  const height = image.height * factor
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / factor) * image.width
    for (let x = 0; x < width; x++) {
      const from = (row + Math.floor(x / factor)) * 4
      data.set(image.data.subarray(from, from + 4), (y * width + x) * 4)
    }
  }
  return { data, width, height }
}

/** Each tile's share of a dimension. Four of them, anchored at the corners. */
const TILE_SHARE = 0.6

function cropTile(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4
    data.set(image.data.subarray(from, from + width * 4), row * width * 4)
  }
  return { data, width, height }
}

/**
 * The fallback, and it is not a nicety.
 *
 * `jsQR` locates a symbol by its three finder patterns, and two symbols on one
 * screen put six of them in front of it: on a 1280x800 page with two 260px
 * codes it finds *neither*, where each quarter on its own decodes cleanly
 * (docs/measurements/05-qr.md). So when the whole image comes back empty, look
 * again at four overlapping corners. It costs a second decode only on the pass
 * that already failed, and it is what makes "two codes on the page" a result
 * rather than "no QR code found" on a page that visibly has two.
 */
function readTiles(image: RgbaImage): string[] {
  const width = Math.floor(image.width * TILE_SHARE)
  const height = Math.floor(image.height * TILE_SHARE)
  if (width < 1 || height < 1) return []
  const found: string[] = []
  for (const x of [0, image.width - width]) {
    for (const y of [0, image.height - height]) {
      if (found.length >= MAX_CODES) return found
      const tile = cropTile(image, x, y, width, height)
      const code = jsQR(tile.data, tile.width, tile.height)
      if (code && code.data.length > 0 && !found.includes(code.data)) {
        found.push(code.data)
      }
    }
  }
  return found
}

/**
 * Every QR payload in an image, in the order they are found.
 *
 * Three looks, each one earning its place, and the second and third only run
 * when the one before found nothing:
 *
 *   1. the image as it came, which is the answer almost every time;
 *   2. the image at 2x, for a symbol the page drew at a resampled size — the
 *      failure that is invisible to the eye (see `magnify`);
 *   3. four overlapping corners, for two codes on one screen, which defeat the
 *      locator outright (see `readTiles`).
 *
 * The image is modified in place — each symbol is painted out before the next
 * pass — so pass a decode that is not needed afterwards.
 */
export function scanImage(image: RgbaImage): string[] {
  const whole = readRepeatedly(image)
  if (whole.length > 0) return whole
  const bigger = readRepeatedly(magnify(image, MAGNIFY))
  if (bigger.length > 0) return bigger
  return readTiles(image)
}

/** Read the QR codes in a PNG screenshot and say what the phone may do with each. */
export function scanQrLinks(screenshot: Buffer): ScannedLink[] {
  return scanImage(decodePng(screenshot)).map(classifyLink)
}

/**
 * Take a fresh screenshot of the page and read its QR codes.
 *
 * A new screenshot rather than the newest cast frame: the cast is scaled to
 * 800px wide and encoded at JPEG quality 60, a profile chosen for reading a
 * login form and one that destroys a dense symbol's modules. PNG rather than JPEG for
 * the same reason — the decoder wants edges, not a small file.
 */
export async function scanPageForLinks(page: Page): Promise<ScannedLink[]> {
  const shot = await page.screenshot({
    type: "png",
    timeout: SCREENSHOT_TIMEOUT_MS,
  })
  return scanQrLinks(shot)
}
