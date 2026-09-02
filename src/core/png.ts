/**
 * Just enough PNG to hand a screenshot to a QR decoder.
 *
 * `jsQR` wants what a canvas gives a browser: four bytes per pixel, row-major,
 * RGBA. Node has no canvas and no image decoder — but it does have zlib, and a
 * PNG is a zlib stream of filtered scanlines. That is the whole of this file:
 * about a hundred lines instead of a native dependency that has to build on
 * every platform a handraise user runs an agent on.
 *
 * It decodes the subset that is actually produced here, and refuses the rest
 * loudly rather than guessing:
 *
 *   - 8 bits per channel, non-interlaced. Chromium's `Page.captureScreenshot`
 *     emits colour type 2 (RGB) for a screenshot and 6 (RGBA) when the page has
 *     transparency; measured, docs/measurements/05-qr.md.
 *   - No palette (colour type 3) and no 16-bit depth. Nothing in this repo
 *     produces either, and a decoder path with no input is a decoder path
 *     nobody has ever run.
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

/**
 * The largest image this will decode, in pixels.
 *
 * 64 megapixels is roughly an 8000x8000 screenshot: far past any viewport, and
 * far short of what a dishonest IHDR could ask a decoder to allocate. It is
 * checked before anything is inflated, because the header is the only part of
 * a PNG that is cheap to believe.
 */
export const MAX_PIXELS = 64_000_000

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
}

function fail(what: string): never {
  throw new Error(`handraise: ${what}`)
}

/** IHDR is mandatory and always the first chunk, so it is read by position. */
function readHeader(bytes: Buffer): PngHeader {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    fail("the screenshot is not a PNG")
  }
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    fail("the PNG does not start with IHDR")
  }
  const depth = bytes[24]
  const colourType = bytes[25]
  const interlace = bytes[28]
  const channels =
    colourType === undefined ? undefined : CHANNELS.get(colourType)
  if (depth !== 8 || interlace !== 0 || channels === undefined) {
    fail(
      `unsupported PNG (colour type ${colourType}, ${depth} bits, interlace ${interlace})`,
    )
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  // Before anything is allocated or inflated: a header may claim four billion
  // pixels each way, and every allocation below is sized from these two numbers.
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) {
    fail(`the PNG claims ${width}x${height}, past the ${MAX_PIXELS}-pixel cap`)
  }
  return { width, height, channels }
}

/** The image data, which a PNG may split over any number of IDAT chunks. */
function collectImageData(bytes: Buffer): Buffer {
  const parts: Buffer[] = []
  let offset = 8
  while (offset + CHUNK_OVERHEAD <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii")
    if (type === "IEND") break
    if (type === "IDAT") {
      parts.push(bytes.subarray(offset + 8, offset + 8 + length))
    }
    offset += length + CHUNK_OVERHEAD
  }
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
  if (raw.length < (stride + 1) * header.height) {
    fail("the PNG's image data is shorter than its dimensions claim")
  }
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
 * The inflate is bounded by the header, which is the whole point of doing it
 * in that order. A PNG's IHDR says exactly how many bytes its image data
 * decompresses to — one filter byte plus one scanline per row — so a stream
 * that inflates past that is not a large picture, it is a zip bomb. Measured
 * without the bound: 815 KB of IDAT claiming an 8x8 image allocated 873 MB and
 * then decoded happily, because the first 200 bytes were a valid 8x8 image.
 * `scanPageForLinks` only ever feeds this Chromium's own screenshot, but
 * `scanQrLinks` is exported and documented as taking a PNG from anywhere.
 */
export function decodePng(bytes: Buffer): RgbaImage {
  const header = readHeader(bytes)
  const raw = inflateSync(collectImageData(bytes), {
    maxOutputLength: (header.width * header.channels + 1) * header.height,
  })
  return {
    data: toRgba(unfilter(raw, header), header),
    width: header.width,
    height: header.height,
  }
}
