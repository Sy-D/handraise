/**
 * The decode, on a thread that is not the agent's.
 *
 * A PNG decode plus up to three `jsQR` passes is pure synchronous CPU, and on
 * a 3840x2160 screenshot it is seconds of it (docs/measurements/05-qr.md). On
 * the agent's own loop that stalls everything handraise promises to keep
 * working while a human is looking at the page: the frame pump, the handback
 * the human is about to send, the timeout, the browser's disconnect. So the
 * work happens here instead, and the loop stays free to answer.
 *
 * The protocol is one message each way and nothing else. In: the PNG bytes,
 * transferred rather than copied. Out: `{ links }` or `{ error }` — never a
 * throw, because a worker that dies takes its answer with it and the caller's
 * deadline is what has to notice.
 *
 * This file is a build entry of its own (`dist/qr-worker.js`), because a
 * worker is loaded by URL at runtime and cannot be bundled into the caller.
 */
import { parentPort } from "node:worker_threads"

import { type ScannedLink, scanQrLinks } from "./qr-scan"

/** What the worker sends back. Exactly one of the two fields is present. */
export interface QrWorkerResult {
  links?: ScannedLink[]
  error?: string
}

if (parentPort) {
  const port = parentPort
  port.on("message", (png: Uint8Array) => {
    try {
      port.postMessage({ links: scanQrLinks(Buffer.from(png)) })
    } catch (error) {
      // Every refusal the decoder makes is a message, not a crash: a hostile
      // PNG must not be able to take the worker down and cost the next scan
      // its startup.
      port.postMessage({ error: String(error) })
    }
  })
}
