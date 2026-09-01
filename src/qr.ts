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

/**
 * Render a QR code for `url` as terminal text.
 *
 * `small: true` uses half-block characters, which fits an 80-column terminal
 * and still scans on a phone. Returns `null` rather than throwing: a terminal
 * that cannot draw this is not a reason to fail a handoff.
 */
export function handoffQr(url: string): string | null {
  try {
    let drawn: string | null = null
    qrcodeTerminal.generate(url, { small: true }, (code) => {
      drawn = code
    })
    return drawn
  } catch (error) {
    console.error("handraise: could not draw the QR code", error)
    return null
  }
}

/** Print the handoff URL, the reason, and a scannable code, to stdout. */
export function printHandoffQr(url: string, reason: string): void {
  console.log(`\nhandraise: ${reason}`)
  console.log(`handraise: open ${url}\n`)
  const code = handoffQr(url)
  if (code) console.log(code)
}
