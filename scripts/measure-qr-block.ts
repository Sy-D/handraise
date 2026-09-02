/**
 * Measurement 05 §7: what a scan costs the agent's event loop.
 *
 *   bun scripts/measure-qr-block.ts
 *   node --experimental-strip-types scripts/measure-qr-block.ts
 *
 * No API key and no browser: the input is a synthetic 3840x2160 screenshot,
 * which is the largest thing a scan can be asked to decode in practice (a 4K
 * viewport, or a 1920x1080 one at device scale 2). What is measured is not how
 * long the decode takes — that is in §2 — but how long the loop cannot answer
 * anything while it happens, before and after the work moved to a worker.
 *
 * The probe is a 5 ms interval that records how late each tick is. The largest
 * gap is the answer: it is how long a handback, a timeout or a screencast
 * frame would have waited.
 */
import { deflateSync } from "node:zlib"

import { createQrScanner, scanQrLinks } from "../src/core/qr-scan"

const WIDTH = 3840
const HEIGHT = 2160
const TICK_MS = 5

/** A white RGB PNG of the given size: no code in it, so the whole ladder runs. */
function blankPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1), 0xff)
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, "ascii")
    return Buffer.concat([head, body, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** Run `work`, and report the longest the 5 ms heartbeat was kept waiting. */
async function longestStall(work: () => Promise<void>): Promise<{
  wallMs: number
  stallMs: number
  ticks: number
}> {
  let last = Date.now()
  let stall = 0
  let ticks = 0
  const beat = setInterval(() => {
    const now = Date.now()
    stall = Math.max(stall, now - last - TICK_MS)
    last = now
    ticks += 1
  }, TICK_MS)
  const started = Date.now()
  await work()
  // The last gap counts too, and on the blocking path it is the only one:
  // an interval that never got to run recorded nothing at all.
  const wallMs = Date.now() - started
  stall = Math.max(stall, Date.now() - last - TICK_MS)
  clearInterval(beat)
  return { wallMs, stallMs: stall, ticks }
}

const png = blankPng(WIDTH, HEIGHT)
console.log(
  JSON.stringify({
    event: "input",
    size: `${WIDTH}x${HEIGHT}`,
    megapixels: Number(((WIDTH * HEIGHT) / 1e6).toFixed(1)),
    pngBytes: png.length,
  }),
)

// Before: the decode on the agent's own loop, which is what shipped first.
const onLoop = await longestStall(async () => {
  scanQrLinks(png)
})
console.log(JSON.stringify({ event: "main_thread", ...onLoop }))

// After: the same decode, on the worker.
const scanner = createQrScanner()
// The first scan pays the worker's startup; report it separately, because a
// handoff pays it once and every scan after this one does not.
const firstOnWorker = await longestStall(async () => {
  await scanner.scan(png)
})
console.log(JSON.stringify({ event: "worker_first", ...firstOnWorker }))
const onWorker = await longestStall(async () => {
  await scanner.scan(png)
})
console.log(JSON.stringify({ event: "worker_warm", ...onWorker }))
await scanner.close()
