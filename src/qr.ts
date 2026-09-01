/**
 * The QR code is the whole onboarding story: the agent is stuck in a terminal
 * on a laptop, and the person who can unstick it has a phone in their pocket.
 * Printing a scannable code costs one dependency and removes the step where
 * somebody retypes a 90-character preview URL with a token in it.
 */
// Namespace import, not `import { generate }`. qrcode-terminal's `generate`
// reads its error-correction level off `this`, so a destructured reference
// throws "bad rs block @ typeNumber:1/errorCorrectLevel:undefined" — which
// this module used to swallow into a log line, printing no QR code at all.
// Typechecked, linted, silently broken; caught by running it.
import * as qrcodeTerminal from "qrcode-terminal"
import { type Logger, quietLogger } from "./logger"

/**
 * The four glyphs qrcode-terminal's `small` mode draws, ordered so that the
 * index of a glyph *is* the pair of modules it stands for: bit 1 the upper
 * module, bit 0 the lower one, set where the glyph is filled.
 *
 * Note the polarity: a filled glyph is a *light* QR module. Terminal text is
 * light on dark, so the library draws the light modules and leaves the dark
 * ones as background. Every matrix in this file keeps that convention — `true`
 * means "the terminal puts ink here" — so the quiet zone is filled, not blank.
 */
const HALF_BLOCKS = " ▄▀█"

/**
 * The sixteen quadrant glyphs, indexed by the four modules they draw:
 * top-left 8, top-right 4, bottom-left 2, bottom-right 1.
 */
const QUADRANT_BLOCKS = " ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█"

/** Outside the symbol is quiet zone, and quiet zone is light — so, filled. */
const QUIET_ZONE = true

/**
 * A QR symbol plus its border, row-major, `true` where the terminal draws ink.
 */
interface ModuleMatrix {
  readonly width: number
  readonly height: number
  readonly lit: readonly boolean[]
}

/** Draw `url` with qrcode-terminal, in the half-block form we then re-pack. */
function drawHalfBlocks(url: string): string {
  // `generate` hands the string to a callback rather than returning it. It is
  // synchronous, so collecting into an array is enough — and unlike a `let`
  // it leaves the result typed as a string.
  const drawn: string[] = []
  qrcodeTerminal.generate(url, { small: true }, (code) => {
    drawn.push(code)
  })
  const output = drawn.join("")
  if (output.length === 0) throw new Error("qrcode-terminal drew nothing")
  return output
}

/** The two modules a half-block glyph stands for, upper first. */
function halfBlockModules(glyph: string): readonly [boolean, boolean] {
  const bits = HALF_BLOCKS.indexOf(glyph)
  if (bits < 0) {
    throw new Error(`not a half-block glyph: ${JSON.stringify(glyph)}`)
  }
  return [(bits & 2) !== 0, (bits & 1) !== 0]
}

/**
 * Recover the module matrix from the half-block drawing.
 *
 * Going through the rendered text rather than qrcode-terminal's internals is
 * the deliberate choice: the library exports `generate` and nothing else, so
 * reaching into its vendored QRCode class would bind us to a private shape.
 * The half-block encoding, in contrast, is lossless — each of its four glyphs
 * names exactly one of the four states of a vertical module pair — so the
 * matrix comes back bit for bit, using only the published API.
 */
function modulesFromHalfBlocks(drawn: string): ModuleMatrix {
  const rows: boolean[][] = []
  for (const line of drawn.split("\n")) {
    if (line.length === 0) continue
    const upper: boolean[] = []
    const lower: boolean[] = []
    for (const glyph of line) {
      const [top, bottom] = halfBlockModules(glyph)
      upper.push(top)
      lower.push(bottom)
    }
    rows.push(upper, lower)
  }
  const width = rows[0]?.length ?? 0
  if (rows.some((row) => row.length !== width)) {
    throw new Error("qrcode-terminal drew a ragged symbol")
  }
  return { width, height: rows.length, lit: rows.flat() }
}

/** One module, with everything past the edge counting as quiet zone. */
function litAt(matrix: ModuleMatrix, x: number, y: number): boolean {
  if (x >= matrix.width || y >= matrix.height) return QUIET_ZONE
  return matrix.lit[y * matrix.width + x] === true
}

/** One output line: two module rows, two modules per character. */
function quadrantLine(matrix: ModuleMatrix, y: number): string {
  let line = ""
  for (let x = 0; x < matrix.width; x += 2) {
    const bits =
      (litAt(matrix, x, y) ? 8 : 0) |
      (litAt(matrix, x + 1, y) ? 4 : 0) |
      (litAt(matrix, x, y + 1) ? 2 : 0) |
      (litAt(matrix, x + 1, y + 1) ? 1 : 0)
    line += QUADRANT_BLOCKS.charAt(bits)
  }
  return line
}

/**
 * Re-pack the matrix at 2×2 modules per character.
 *
 * An odd width or height would leave a half-empty character at the edge; the
 * missing modules come back from `litAt` as quiet zone, which is what a border
 * should be anyway.
 */
function quadrantsFromModules(matrix: ModuleMatrix): string {
  const lines: string[] = []
  for (let y = 0; y < matrix.height; y += 2) {
    lines.push(quadrantLine(matrix, y))
  }
  return lines.join("\n")
}

/**
 * Render a QR code for `url` as terminal text.
 *
 * Quadrant blocks carry 2×2 modules per character, so a handoff URL — around
 * 300 characters, most of it an unshortenable token — comes out roughly 32×32
 * instead of the 32×63 that half blocks need. 63 columns wraps on a narrow
 * terminal, and a wrapped QR code is not a QR code.
 *
 * Returns `null` rather than throwing: a terminal that cannot draw this is not
 * a reason to fail a handoff.
 */
export function handoffQr(
  url: string,
  logger: Logger = quietLogger,
): string | null {
  try {
    return quadrantsFromModules(modulesFromHalfBlocks(drawHalfBlocks(url)))
  } catch (error) {
    logger.warn("qr_render_failed", { error: String(error) })
    return null
  }
}

/**
 * Print the handoff URL, the reason, and a scannable code, to stdout.
 *
 * These `console.log` lines are the terminal UX a person reads to scan the
 * code — not observability. The tokenised URL is deliberately not sent through
 * the structured logger, which would both destroy the QR rendering and log a
 * bearer credential.
 */
export function printHandoffQr(
  url: string,
  reason: string,
  logger: Logger = quietLogger,
): void {
  console.log(`\nhandraise: ${reason}`)
  const code = handoffQr(url, logger)
  if (code) console.log(code)
  // The QR is the primary path; the raw URL comes after it, as the fallback
  // for a terminal that can't render the code or a human without a camera.
  console.log(`handraise: or open ${url}\n`)
}
