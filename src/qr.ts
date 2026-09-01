/**
 * The QR code is the whole onboarding story: the agent is stuck in a terminal
 * on a laptop, and the person who can unstick it has a phone in their pocket.
 * Printing a scannable code costs one dependency and removes the step where
 * somebody retypes a 300-character preview URL with a token in it.
 *
 * On the size of it. A handoff URL is around 300 characters — most of that is
 * Solari's `pt_token`, which cannot be shortened — so the symbol lands at about
 * 63×63 modules and the error-correction level is already the lowest one. That
 * leaves only how many modules fit in a character cell, and terminal cells are
 * roughly twice as tall as they are wide:
 *
 *   half blocks (1 module wide, 2 tall per cell) → 63×32 cells, square on screen
 *   quadrants   (2 module wide, 2 tall per cell) → 32×32 cells, 1:2 stretched
 *
 * Quadrants halve the width, but they also halve each module's width while
 * leaving its height, so the symbol renders as a tall rectangle. That is worse
 * to look at and worse to scan, so half blocks it is: 63 columns still fits the
 * standard 80-column terminal, and the modules stay square.
 */
// Namespace import, not `import { generate }`. qrcode-terminal's `generate`
// reads its error-correction level off `this`, so a destructured reference
// throws "bad rs block @ typeNumber:1/errorCorrectLevel:undefined" — which
// this module used to swallow into a log line, printing no QR code at all.
// Typechecked, linted, silently broken; caught by running it.
import * as qrcodeTerminal from "qrcode-terminal"
import { type Logger, quietLogger } from "./logger"

/**
 * Render a QR code for `url` as terminal text.
 *
 * `small: true` is qrcode-terminal's half-block mode. Returns `null` rather
 * than throwing: a terminal that cannot draw this is not a reason to fail a
 * handoff.
 */
export function handoffQr(
  url: string,
  logger: Logger = quietLogger,
): string | null {
  try {
    // `generate` hands the string to a callback rather than returning it. It
    // is synchronous, so collecting into an array is enough — and unlike a
    // `let` it leaves the result typed as a string.
    const drawn: string[] = []
    qrcodeTerminal.generate(url, { small: true }, (code) => {
      drawn.push(code)
    })
    const output = drawn.join("")
    if (output.length === 0) throw new Error("qrcode-terminal drew nothing")
    return output
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
