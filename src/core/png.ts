/**
 * Just enough PNG to hand a screenshot to a QR decoder.
 *
 * `jsQR` wants what a canvas gives a browser: four bytes per pixel, row-major,
 * RGBA. Node has no canvas and no image decoder — but it does have zlib, and a
 * PNG is a zlib stream of filtered scanlines. That is the whole of this file:
 * about two hundred lines instead of a native dependency that has to build on
 * every platform a handraise user runs an agent on.
 *
 * It decodes the subset that is actually produced here, and refuses the rest
 * loudly rather than guessing:
 *
 *   - 8 bits per channel, non-interlaced, deflate, filter method 0. Chromium's
 *     `Page.captureScreenshot` emits colour type 2 (RGB) for a screenshot and 6
 *     (RGBA) when the page has transparency; measured, docs/measurements/05-qr.md.
 *   - No palette (colour type 3) and no 16-bit depth. Nothing in this repo
 *     produces either, and a decoder path with no input is a decoder path
 *     nobody has ever run.
 *
 * **What it does not check: the CRCs.** Every chunk carries one and this reads
 * none of them, because the contract is "Chromium's own screenshot, over an
 * in-process CDP call" — there is no lossy channel between the encoder and
 * here for a CRC to catch. What it does check is every length and boundary,
 * which is the part an attacker controls: a file whose chunk lengths walk off
 * the end, whose image data decompresses to the wrong size, or whose header
 * claims a size nothing could have produced is rejected by name rather than
 * quietly turned into pixels for a security-sensitive classifier.
 */
import { inflateSync } from "node:zlib"

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Bytes per pixel by PNG colour type: grey, RGB, grey+alpha, RGBA. */
const CHANNELS = new Map<number, number>([
  [0, 1],
  [2, 3],
  [4, 2],
  [6, 4],
])

/** Length + type + CRC around every chunk's payload. */
const CHUNK_OVERHEAD = 12

/** IHDR's payload is exactly this long, always. */
const IHDR_LENGTH = 13

/**
 * The largest image this will decode.
 *
 * 8192 on a side, 24 megapixels in total. Both are checked before a byte is
 * decompressed, because the header is the only part of a PNG that is cheap to
 * believe and every allocation below is sized from it.
 *
 * The pixel cap is set by what the decoder can finish inside its own deadline,
 * not by what a screen could hold: 24 MP measured 1.2 s and the deadline is 6 s
 * (docs/measurements/05-qr.md §6). **A 4K viewport at device scale 2 is
 * 7680x4320 — 33.2 MP — and is refused**, which is a real limit and not an
 * oversight: it is four times the pixels of the 4K screenshot the scan is built
 * for, and no page draws a QR code that needs them. A caller who hits this
 * should scan at device scale 1.
 */
export const MAX_DIMENSION = 8192
export const MAX_PIXELS = 24_000_000

/**
 * The largest compressed image data this will inflate.
 *
 * A screenshot of a page is a few hundred kilobytes; 32 MB is two orders of
 * magnitude of headroom and still a bound. It exists so that a stream is
 * refused before `inflateSync` is asked to look at it, rather than after.
 */
export const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024

/** A decoded image in the one layout `jsQR` and `ImageData` agree on. */
export interface RgbaImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

interface PngHeader {
  width: number
  height: number
  channels: number
  /** Bytes the image data must decompress to: a filter byte plus a row, per row. */
  inflatedLength: number
}

function fail(what: string): never {
  throw new Error(`handraise: ${what}`)
}

/** IHDR is mandatory and always the first chunk, so it is read by position. */
function readHeader(bytes: Buffer): PngHeader {
  if (bytes.length < 8 + CHUNK_OVERHEAD + IHDR_LENGTH) {
    fail("the screenshot is not a PNG")
  }
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) {
    fail("the screenshot is not a PNG")
  }
  if (
    bytes.readUInt32BE(8) !== IHDR_LENGTH ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    fail("the PNG does not start with a 13-byte IHDR")
  }
  const depth = bytes[24]
  const colourType = bytes[25]
  const compression = bytes[26]
  const filterMethod = bytes[27]
  const interlace = bytes[28]
  const channels =
    colourType === undefined ? undefined : CHANNELS.get(colourType)
  if (
    depth !== 8 ||
    interlace !== 0 ||
    compression !== 0 ||
    filterMethod !== 0 ||
    channels === undefined
  ) {
    fail(
      `unsupported PNG (colour type ${colourType}, ${depth} bits, interlace ${interlace}, compression ${compression}, filter method ${filterMethod})`,
    )
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    fail(
      `the PNG claims ${width}x${height}, past the ${MAX_DIMENSION}px / ${MAX_PIXELS}-pixel cap`,
    )
  }
  return {
    width,
    height,
    channels,
    inflatedLength: (width * channels + 1) * height,
  }
}

/**
 * The image data, which a PNG may split over any number of IDAT chunks.
 *
 * The walk is the boundary check: every chunk's declared length has to fit in
 * what is left of the file, or the file is lying about its own shape. IEND is
 * required, so a truncated stream is a refusal rather than whatever the last
 * complete chunk happened to hold.
 */
function collectImageData(bytes: Buffer): Buffer {
  const parts: Buffer[] = []
  let total = 0
  let offset = 8
  let ended = false
  while (offset + CHUNK_OVERHEAD <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii")
    if (offset + CHUNK_OVERHEAD + length > bytes.length) {
      fail(`the PNG's ${type} chunk runs past the end of the file`)
    }
    if (type === "IEND") {
      ended = true
      break
    }
    if (type === "IDAT") {
      total += length
      if (total > MAX_COMPRESSED_BYTES) {
        fail(
          `the PNG carries more than ${MAX_COMPRESSED_BYTES} compressed bytes`,
        )
      }
      parts.push(bytes.subarray(offset + 8, offset + 8 + length))
    }
    offset += length + CHUNK_OVERHEAD
  }
  if (!ended) fail("the PNG has no IEND chunk")
  if (parts.length === 0) fail("the PNG carries no image data")
  return Buffer.concat(parts)
}

/** PNG's own predictor, from the spec's Filter type 4. */
function paeth(left: number, above: number, corner: number): number {
  const estimate = left + above - corner
  const dLeft = Math.abs(estimate - left)
  const dAbove = Math.abs(estimate - above)
  const dCorner = Math.abs(estimate - corner)
  if (dLeft <= dAbove && dLeft <= dCorner) return left
  return dAbove <= dCorner ? above : corner
}

/**
 * Undo one scanline's filter, in place.
 *
 * Every filter is a difference against the byte to the left, the byte above,
 * or both, so a row can only be reconstructed after the row above it. Writing
 * into a `Uint8Array` is what makes the arithmetic wrap at 256 the way the
 * spec's modulo does.
 */
function unfilterRow(
  row: Uint8Array,
  above: Uint8Array,
  filter: number,
  bpp: number,
): void {
  for (let i = 0; i < row.length; i++) {
    const value = row[i] ?? 0
    const left = i >= bpp ? (row[i - bpp] ?? 0) : 0
    const up = above[i] ?? 0
    const corner = i >= bpp ? (above[i - bpp] ?? 0) : 0
    if (filter === 1) row[i] = value + left
    else if (filter === 2) row[i] = value + up
    else if (filter === 3) row[i] = value + ((left + up) >> 1)
    else if (filter === 4) row[i] = value + paeth(left, up, corner)
  }
}

/** Filtered scanlines (one filter byte each) to raw samples. */
function unfilter(raw: Buffer, header: PngHeader): Uint8Array {
  const stride = header.width * header.channels
  const pixels = new Uint8Array(stride * header.height)
  const firstAbove = new Uint8Array(stride)
  let offset = 0
  for (let y = 0; y < header.height; y++) {
    const filter = raw[offset]
    offset += 1
    if (filter === undefined || filter > 4) fail(`unknown PNG filter ${filter}`)
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    row.set(raw.subarray(offset, offset + stride))
    offset += stride
    const above =
      y === 0 ? firstAbove : pixels.subarray((y - 1) * stride, y * stride)
    unfilterRow(row, above, filter, header.channels)
  }
  return pixels
}

/** Widen whatever channels the file has to the RGBA a decoder expects. */
function toRgba(pixels: Uint8Array, header: PngHeader): Uint8ClampedArray {
  if (header.channels === 4) return new Uint8ClampedArray(pixels)
  const count = header.width * header.height
  const rgba = new Uint8ClampedArray(count * 4)
  const grey = header.channels < 3
  for (let i = 0; i < count; i++) {
    const from = i * header.channels
    const to = i * 4
    const first = pixels[from] ?? 0
    rgba[to] = first
    rgba[to + 1] = grey ? first : (pixels[from + 1] ?? 0)
    rgba[to + 2] = grey ? first : (pixels[from + 2] ?? 0)
    rgba[to + 3] = header.channels === 2 ? (pixels[from + 1] ?? 255) : 255
  }
  return rgba
}

/**
 * Decode a PNG to RGBA. Throws with a readable message on anything else.
 *
 * The inflate is bounded by the header, and that is the whole point of doing
 * it in that order. A PNG's IHDR says exactly how many bytes its image data
 * decompresses to — one filter byte plus one scanline per row — so anything
 * else is not a picture: a stream that inflates past it is a zip bomb, and one
 * that stops short is a truncated or forged file. Measured without the bound:
 * 815 KB of IDAT claiming an 8x8 image allocated 873 MB and then decoded
 * happily, because the first 200 bytes were a valid 8x8 image.
 *
 * `scanPageForLinks` only ever feeds this Chromium's own screenshot, but
 * `scanQrLinks` is exported and documented as taking a PNG from anywhere.
 */
export function decodePng(bytes: Buffer): RgbaImage {
  const header = readHeader(bytes)
  const raw = inflateSync(collectImageData(bytes), {
    maxOutputLength: header.inflatedLength,
  })
  if (raw.length !== header.inflatedLength) {
    fail(
      `the PNG's image data decompressed to ${raw.length} bytes, not the ${header.inflatedLength} its header claims`,
    )
  }
  return {
    data: toRgba(unfilter(raw, header), header),
    width: header.width,
    height: header.height,
  }
}
