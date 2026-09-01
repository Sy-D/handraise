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
 * Render a QR code for `url` as terminal text.
 *
 * `small: true` uses half-block characters, which fits an 80-column terminal
 * and still scans on a phone. Returns `null` rather than throwing: a terminal
 * that cannot draw this is not a reason to fail a handoff.
 */
export function handoffQr(
  url: string,
  logger: Logger = quietLogger,
): string | null {
  try {
    let drawn: string | null = null
    qrcodeTerminal.generate(url, { small: true }, (code) => {
      drawn = code
    })
    return drawn
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
