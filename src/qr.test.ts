/**
 * A regression test for a bug that every other gate passed.
 *
 * `import { generate } from "qrcode-terminal"` typechecks, lints and prints
 * nothing but an error, because the library reads its error-correction level
 * off `this`. The first version of qr.ts shipped exactly that and swallowed
 * the throw into a log line. Nothing but running it finds this.
 *
 * The rest of the file guards the quadrant packing that replaced the library's
 * half-block output. Nobody can hold a phone up to CI, so correctness is
 * checked the only way it can be: decode the printed characters back into a
 * module matrix and compare it, bit for bit, with the matrix the library drew.
 * Same modules, fewer columns, or the test fails.
 *
 *   bun test src/
 */
import { expect, test } from "bun:test"
import * as qrcodeTerminal from "qrcode-terminal"

import { handoffQr } from "./qr"

/** The real shape of a handoff URL: long, with a JWT in the query. */
const URL_WITH_TOKEN =
  "https://b18c04858a5a5108c23c-3000.preview.getsolari.com/?pt_token=eyJzYW5kYm94SWQiOiJaR1Z6YTNSdmNDMXdiMjlzTFdrdE1HWmtPV1ZrTjJSak1ETmhOemxrWWpJIiwicG9ydCI6MzAwMH0"

/** A URL the length the token really makes them, for the size assertions. */
const URL_300 = `${URL_WITH_TOKEN}${"e".repeat(300 - URL_WITH_TOKEN.length)}`

/**
 * A module matrix, row-major, `true` where the terminal draws ink.
 *
 * These decoders are written out again here rather than imported from qr.ts on
 * purpose. A roundtrip through the module's own encoder and its own decoder
 * would agree with itself no matter how wrong both were.
 */
interface Matrix {
  readonly width: number
  readonly height: number
  readonly lit: readonly boolean[]
}

function fromRows(rows: readonly (readonly boolean[])[]): Matrix {
  const width = rows[0]?.length ?? 0
  expect(rows.every((row) => row.length === width)).toBe(true)
  return { width, height: rows.length, lit: rows.flat() }
}

/** " ▄▀█" → two vertical modules each, upper module first. */
function decodeHalfBlocks(drawn: string): Matrix {
  const rows: boolean[][] = []
  for (const line of drawn.split("\n")) {
    if (line.length === 0) continue
    const upper: boolean[] = []
    const lower: boolean[] = []
    for (const glyph of line) {
      const bits = " ▄▀█".indexOf(glyph)
      expect(bits).toBeGreaterThanOrEqual(0)
      upper.push((bits & 2) !== 0)
      lower.push((bits & 1) !== 0)
    }
    rows.push(upper, lower)
  }
  return fromRows(rows)
}

/** " ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█" → four modules each, in reading order. */
function decodeQuadrants(drawn: string): Matrix {
  const rows: boolean[][] = []
  for (const line of drawn.split("\n")) {
    if (line.length === 0) continue
    const upper: boolean[] = []
    const lower: boolean[] = []
    for (const glyph of line) {
      const bits = " ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█".indexOf(glyph)
      expect(bits).toBeGreaterThanOrEqual(0)
      upper.push((bits & 8) !== 0, (bits & 4) !== 0)
      lower.push((bits & 2) !== 0, (bits & 1) !== 0)
    }
    rows.push(upper, lower)
  }
  return fromRows(rows)
}

function litAt(matrix: Matrix, x: number, y: number): boolean {
  return matrix.lit[y * matrix.width + x] === true
}

/**
 * Where `candidate` stops being `reference` plus quiet zone, or `null`.
 *
 * The candidate may be wider or taller — packing two modules into one
 * character rounds the edges up — but every extra module has to be quiet zone,
 * which in this polarity means lit.
 */
function firstMismatch(reference: Matrix, candidate: Matrix): string | null {
  if (candidate.width < reference.width) return "candidate is narrower"
  if (candidate.height < reference.height) return "candidate is shorter"
  for (let y = 0; y < candidate.height; y++) {
    for (let x = 0; x < candidate.width; x++) {
      const inside = x < reference.width && y < reference.height
      const want = inside ? litAt(reference, x, y) : true
      if (litAt(candidate, x, y) !== want) {
        return `module ${x},${y}: expected ${want}${inside ? "" : " (quiet zone)"}`
      }
    }
  }
  return null
}

function halfBlockDrawing(url: string): string {
  const drawn: string[] = []
  qrcodeTerminal.generate(url, { small: true }, (code) => {
    drawn.push(code)
  })
  return drawn.join("")
}

function lines(code: string | null): string[] {
  return (code ?? "").split("\n").filter((line) => line.length > 0)
}

test("a handoff URL becomes a drawable QR code", () => {
  const code = handoffQr(URL_WITH_TOKEN)
  expect(code).not.toBeNull()

  // A code for a URL this long needs a large symbol; quadrant rows quarter it.
  expect(lines(code).length).toBeGreaterThan(20)
  // The block characters are the picture. Without them there is no code.
  expect(code).toContain("█")
  expect(code).toContain("▄")
})

test("every row of the code is the same width, so the symbol is square", () => {
  const widths = new Set(lines(handoffQr(URL_WITH_TOKEN)).map((l) => l.length))
  expect(widths.size).toBe(1)
})

test("the quadrant packing carries the library's modules unchanged", () => {
  const drawn = decodeHalfBlocks(halfBlockDrawing(URL_300))
  const packed = decodeQuadrants(handoffQr(URL_300) ?? "")

  expect(firstMismatch(drawn, packed)).toBeNull()
  // Half the columns, half the rows, all the same modules.
  expect(packed.width).toBe(drawn.width + (drawn.width % 2))
  expect(packed.height).toBe(drawn.height + (drawn.height % 2))
})

test("the roundtrip comparison notices a single flipped module", () => {
  const drawn = decodeHalfBlocks(halfBlockDrawing(URL_300))
  const packed = decodeQuadrants(handoffQr(URL_300) ?? "")

  const flipped = [...packed.lit]
  const index = 10 * packed.width + 10
  flipped[index] = !flipped[index]

  expect(firstMismatch(drawn, { ...packed, lit: flipped })).toBe(
    `module 10,10: expected ${litAt(drawn, 10, 10)}`,
  )
})

test("a 300-character URL fits a narrow terminal", () => {
  const printed = lines(handoffQr(URL_300))
  const width = printed[0]?.length ?? 0

  expect(width).toBeLessThanOrEqual(40)
  expect(printed.length).toBeLessThanOrEqual(40)
  // Terminal cells are taller than wide, so a square character count is the
  // shape to hold; drifting apart means the packing lost or gained a row.
  expect(Math.abs(width - printed.length)).toBeLessThanOrEqual(2)
})

test("the code keeps a quiet zone on every side", () => {
  const packed = decodeQuadrants(handoffQr(URL_300) ?? "")
  const edges: boolean[] = []
  // Module row 0 is the unlit top half of the library's border character, so
  // the quiet zone starts one module in — as it does in the half-block output.
  for (let x = 0; x < packed.width; x++) {
    edges.push(litAt(packed, x, 1), litAt(packed, x, packed.height - 1))
  }
  for (let y = 1; y < packed.height; y++) {
    edges.push(litAt(packed, 0, y), litAt(packed, packed.width - 1, y))
  }
  expect(edges.every(Boolean)).toBe(true)
})

test("input too long for any QR symbol logs and returns null, never throws", () => {
  const warnings: string[] = []
  const code = handoffQr("x".repeat(4000), {
    debug: () => {},
    info: () => {},
    warn: (event) => {
      warnings.push(event)
    },
    error: () => {},
  })

  expect(code).toBeNull()
  expect(warnings).toEqual(["qr_render_failed"])
})
