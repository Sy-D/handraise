/**
 * The QR rendering, which is the only part of handraise a human reads off a
 * terminal before anything else has happened.
 *
 * There is no camera in CI, so these tests pin the two properties that make a
 * printed code scannable at all: the glyphs are the half-block set (whose
 * modules stay square on a terminal's tall character cells), and the symbol is
 * square in module space rather than stretched.
 */
import { expect, test } from "bun:test"
import { noopLogger } from "./logger"
import { handoffQr, printHandoffQr } from "./qr"

/** A realistic handoff URL: preview subdomain plus a token-sized tail. */
const URL = `https://aabbccddeeff00112233-3000.preview.getsolari.com/?pt_token=${"x".repeat(362)}`

/** The four glyphs qrcode-terminal's `small` mode draws, plus the newline. */
const HALF_BLOCKS = new Set([" ", "▄", "▀", "█"])

function lines(code: string): string[] {
  return code.split("\n").filter((line) => line.length > 0)
}

test("renders a realistic handoff URL as half blocks only", () => {
  const code = handoffQr(URL, noopLogger)
  expect(code).not.toBeNull()
  const glyphs = new Set([...(code ?? "").replace(/\n/g, "")])
  for (const glyph of glyphs) expect(HALF_BLOCKS.has(glyph)).toBe(true)
})

test("the symbol is square in modules — 1 module per column, 2 per row", () => {
  const code = handoffQr(URL, noopLogger)
  const rows = lines(code ?? "")
  const width = Math.max(...rows.map((line) => [...line].length))
  // Each row of characters carries two module rows, so module height is 2×.
  const moduleHeight = rows.length * 2
  expect(Math.abs(moduleHeight - width)).toBeLessThanOrEqual(2)
})

test("fits a standard 80-column terminal", () => {
  const rows = lines(handoffQr(URL, noopLogger) ?? "")
  const width = Math.max(...rows.map((line) => [...line].length))
  expect(width).toBeLessThanOrEqual(80)
})

test("every row is the same width — a ragged symbol would not scan", () => {
  const rows = lines(handoffQr(URL, noopLogger) ?? "")
  const widths = new Set(rows.map((line) => [...line].length))
  expect(widths.size).toBe(1)
})

test("returns null instead of throwing when the payload cannot be encoded", () => {
  // Far past QR's capacity at any version: the library throws, and handoffQr
  // must swallow that rather than take a handoff down with it.
  expect(handoffQr("x".repeat(10_000), noopLogger)).toBeNull()
})

test("a terminal too narrow for the code gets the link, not a wrapped QR", () => {
  const printed: string[] = []
  const realLog = console.log
  console.log = (text: string) => {
    printed.push(String(text))
  }
  try {
    printHandoffQr(URL, "needs a human", noopLogger, 40)
  } finally {
    console.log = realLog
  }
  const joined = printed.join("\n")
  // No QR glyphs at all — a wrapped symbol is worse than none.
  expect(joined).not.toContain("\u2580")
  expect(joined).not.toContain("\u2584")
  expect(joined).toContain("widen it to scan")
  expect(joined).toContain(URL)
})

test("a wide enough terminal gets the code itself", () => {
  const printed: string[] = []
  const realLog = console.log
  console.log = (text: string) => {
    printed.push(String(text))
  }
  try {
    printHandoffQr(URL, "needs a human", noopLogger, 120)
  } finally {
    console.log = realLog
  }
  const joined = printed.join("\n")
  expect(joined).toContain("\u2588")
  expect(joined).toContain(URL)
})
