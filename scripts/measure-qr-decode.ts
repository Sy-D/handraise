/**
 * Measurement 05: reading a QR code off the page an agent is stuck on.
 *
 *   bun --env-file=.env scripts/measure-qr-decode.ts
 *   bun --env-file=.env scripts/measure-qr-decode.ts --recaptcha
 *   bun scripts/measure-qr-decode.ts --local     # part B only, no API key
 *
 * Answers the questions plan 04 asked before the feature was built:
 *
 *   A, on a real Solari cloud browser:
 *     1. Is `BarcodeDetector` available? If it were, the decode could happen
 *        inside Chromium and cost no dependency.
 *     2. What does a full-resolution `page.screenshot()` plus a decode cost,
 *        over ten runs?
 *     Also writes the unit tests' fixture — a real screenshot from a real
 *     cloud browser — to src/core/fixtures/qr-page.png.
 *
 *   B, on local Chromium, because it needs no cloud and is deterministic:
 *     3. Would the live cast frame do instead of a screenshot? The frame is
 *        produced by this repo's own `startFramePump` at `DEFAULT_PROFILE`,
 *        and decoded through Chromium's own JPEG decoder — not an
 *        approximation of one — at three symbol sizes.
 *
 * Results: docs/measurements/05-qr.md.
 */

import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Solari } from "@solarisdk/browser"
import { chromium, type Page } from "playwright-core"
import QRCode from "qrcode"

import { decodePng } from "../src/core/png"
import { scanImage, scanQrLinks } from "../src/core/qr-scan"
import { DEFAULT_PROFILE, startFramePump } from "../src/core/screencast"

const RUNS = 10
const VIEWPORT = { width: 1280, height: 800 }
/** The sizes a device-change prompt draws its code at, in CSS pixels. */
const SYMBOL_SIZES = [420, 260, 180, 150, 120, 100]
const FIXTURE = fileURLToPath(
  new URL("../src/core/fixtures/qr-page.png", import.meta.url),
)

/** A payload the length of a real device-handoff link, so the symbol is dense. */
const PAYLOAD = `https://verify.example.com/device?token=${"a1b2c3d4".repeat(20)}`

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** One wide JSON line per measurement, the way the e2e and the relay log. */
type LogDetail = Record<string, string | number | boolean | undefined>

function log(event: string, detail: LogDetail): void {
  console.log(JSON.stringify({ event, ...detail }))
}

/** The page both parts measure: a heading, a sentence, and one QR code. */
async function drawPage(page: Page, cssWidth: number): Promise<void> {
  const image = await QRCode.toDataURL(PAYLOAD, { scale: 6, margin: 2 })
  await page.setContent(
    `<body style="margin:0;font:16px system-ui;background:#fff">
       <h1>Confirm on another device</h1>
       <p>Scan this code with the phone you registered.</p>
       <img id="code" src="${image}" style="width:${cssWidth}px" alt="code">
     </body>`,
  )
}

/** What the symbol actually measures on the page, so the numbers can be read. */
function symbolWidth(page: Page): Promise<number> {
  return page.evaluate(
    () => document.getElementById("code")?.getBoundingClientRect().width ?? 0,
  )
}

/**
 * Hand a JPEG back to Chromium and take the pixels out as a PNG.
 *
 * The point is that Chromium decodes its own JPEG: a downscale written here
 * would be an approximation of the cast frame, and this is the frame.
 */
async function jpegToPng(page: Page, base64: string): Promise<Buffer> {
  const png = await page.evaluate(async (data: string) => {
    const image = new Image()
    image.src = `data:image/jpeg;base64,${data}`
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext("2d")
    if (!context) throw new Error("no 2d context")
    context.drawImage(image, 0, 0)
    return canvas.toDataURL("image/png")
  }, base64)
  return Buffer.from(png.replace(/^data:image\/png;base64,/, ""), "base64")
}

/** One live cast frame at the profile the handoff actually uses. */
async function castFrame(page: Page): Promise<{ data: string; width: number }> {
  const cdp = await page.context().newCDPSession(page)
  let resolve: (frame: { data: string; width: number }) => void = () =>
    undefined
  const first = new Promise<{ data: string; width: number }>((done) => {
    resolve = done
  })
  const pump = await startFramePump(
    cdp,
    DEFAULT_PROFILE,
    async (data, meta) => {
      resolve({ data, width: meta.jpegWidth })
    },
  )
  const frame = await first
  await pump.stop()
  await cdp.detach().catch(() => undefined)
  return frame
}

// --------------------------------------------------------------- part A ----

if (!process.argv.includes("--local")) {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY missing — use --env-file=.env")
  const solari = new Solari({ apiKey })
  try {
    const browser = await solari.launch({ stealth: true })
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const opened = context.pages()[0] ?? (await context.newPage())
    await opened.setViewportSize(VIEWPORT)

    log(
      "barcode_detector",
      await opened.evaluate(() => ({
        present: "BarcodeDetector" in window,
        ua: navigator.userAgent,
      })),
    )

    // SAFETY: `@solarisdk/browser` returns patchright-core's Page, whose
    // runtime surface is the one used here (setContent, evaluate, screenshot);
    // the two declarations differ only in optional-property variance. The same
    // assertion the e2e makes.
    const page = opened as Page
    await drawPage(page, 420)

    const shotMs: number[] = []
    const decodeMs: number[] = []
    let decoded = ""
    let bytes = 0
    for (let run = 0; run < RUNS; run++) {
      const shotAt = Date.now()
      const shot = await page.screenshot({ type: "png" })
      shotMs.push(Date.now() - shotAt)
      bytes = shot.length
      const decodeAt = Date.now()
      decoded = scanQrLinks(shot)[0]?.text ?? ""
      decodeMs.push(Date.now() - decodeAt)
      if (run === 0) writeFileSync(FIXTURE, shot)
    }
    log("full_resolution", {
      ok: decoded === PAYLOAD,
      symbolPx: await symbolWidth(page),
      bytes,
      shotP50: median(shotMs),
      decodeP50: median(decodeMs),
      totalP50: median(shotMs) + median(decodeMs),
      shot: shotMs.join(","),
      decode: decodeMs.join(","),
    })

    if (process.argv.includes("--recaptcha")) {
      await page.goto("https://www.google.com/recaptcha/api2/demo", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      })
      await new Promise((done) => setTimeout(done, 4_000))
      const shot = await page.screenshot({ type: "png", fullPage: true })
      const links = scanQrLinks(shot)
      log("recaptcha_demo", {
        url: page.url(),
        codes: links.length,
        first: links[0]?.text.slice(0, 120) ?? "",
      })
    }

    await browser.close()
  } finally {
    await solari.close().catch(() => undefined)
  }
}

// --------------------------------------------------------------- part B ----

const local = await chromium.launch({ headless: true })
try {
  const page = await local.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  })
  for (const size of SYMBOL_SIZES) {
    await drawPage(page, size)
    const symbolPx = await symbolWidth(page)

    const shot = await page.screenshot({ type: "png" })
    const fromScreenshot = scanImage(decodePng(shot))[0] === PAYLOAD

    const frame = await castFrame(page)
    const fromCast =
      scanImage(decodePng(await jpegToPng(page, frame.data)))[0] === PAYLOAD

    log("cast_versus_screenshot", {
      symbolPx,
      screenshot: `${VIEWPORT.width}px`,
      fromScreenshot,
      cast: `${frame.width}px jpeg q${DEFAULT_PROFILE.quality}`,
      fromCast,
      castBytes: Buffer.from(frame.data, "base64").length,
    })
  }
} finally {
  await local.close()
}
