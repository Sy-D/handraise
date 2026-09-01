/**
 * A regression test for a bug that every other gate passed.
 *
 * `import { generate } from "qrcode-terminal"` typechecks, lints and prints
 * nothing but an error, because the library reads its error-correction level
 * off `this`. The first version of qr.ts shipped exactly that and swallowed
 * the throw into a log line. Nothing but running it finds this.
 *
 *   bun test src/
 */
import { expect, test } from "bun:test"

import { handoffQr } from "./qr"

/** The real shape of a handoff URL: long, with a JWT in the query. */
const URL_WITH_TOKEN =
  "https://b18c04858a5a5108c23c-3000.preview.getsolari.com/?pt_token=eyJzYW5kYm94SWQiOiJaR1Z6YTNSdmNDMXdiMjlzTFdrdE1HWmtPV1ZrTjJSak1ETmhOemxrWWpJIiwicG9ydCI6MzAwMH0"

test("a handoff URL becomes a drawable QR code", () => {
  const code = handoffQr(URL_WITH_TOKEN)
  expect(code).not.toBeNull()

  const lines = (code ?? "").split("\n")
  // A code for a URL this long needs a large symbol; half-block rows halve it.
  expect(lines.length).toBeGreaterThan(20)
  // The half-block characters are the picture. Without them there is no code.
  expect(code).toContain("█")
  expect(code).toContain("▄")
})

test("every row of the code is the same width, so the symbol is square", () => {
  const lines = (handoffQr(URL_WITH_TOKEN) ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
  const widths = new Set(lines.map((line) => [...line].length))
  expect(widths.size).toBe(1)
})
