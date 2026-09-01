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
 *   half blocks (1 module wide, 2 tall per cell) → 75×38 cells, square on screen
 *   quadrants   (2 module wide, 2 tall per cell) → 38×38 cells, 1:2 stretched
 *
 * Quadrants halve the width, but they also halve each module's width while
 * leaving its height, so the symbol renders as a tall rectangle — worse to look
 * at and a distortion a scanner has to undo. Half blocks keep modules square.
 *
 * Why it is not small like Expo's. A measured handoff URL is 427 characters,
 * 362 of them Solari's `pt_token`; Expo prints `exp://<lan-ip>:8081`, about 22
 * characters and no auth at all. Module count follows payload, so 75 columns is
 * the floor here, not a rendering choice. What that costs is real: 75 columns
 * does not fit every terminal, and a wrapped QR code is not a QR code — hence
 * the width check in `printHandoffQr`.
 */
// Default import, and neither `import { generate }` nor `import * as`:
// destructuring loses the `this` the library reads its error level off, and a
// namespace import of this CJS module is `{ default: exports }` under Node's
// ESM interop — `.generate` was undefined in the BUILT dist while every
// bun-driven test passed. Caught by running the shipped artifact under node;
// the dist smoke in CI now pins this path.
import qrcodeTerminal from "qrcode-terminal"
import { type Logger, quietLogger } from "./logger"

/** Assumed width when stdout is not a TTY (a pipe, a CI log, a test). */
const DEFAULT_COLUMNS = 80

/** Widest line of a rendered code, in characters. */
function qrWidth(code: string): number {
  return Math.max(...code.split("\n").map((line) => [...line].length))
}

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
  columns: number = process.stdout.columns ?? DEFAULT_COLUMNS,
): void {
  console.log(`\nhandraise: ${reason}`)
  const code = handoffQr(url, logger)
  if (code && qrWidth(code) <= columns) {
    console.log(code)
  } else if (code) {
    // Printing it anyway would wrap it, and a wrapped QR code is not a QR
    // code — it just looks like one. Say why, and leave the link.
    console.log(
      `handraise: terminal is ${columns} columns, the QR needs ${qrWidth(code)} — widen it to scan, or use the link:`,
    )
  }
  // The QR is the primary path; the raw URL comes after it, as the fallback
  // for a terminal that can't render the code or a human without a camera.
  console.log(`handraise: or open ${url}\n`)
}
