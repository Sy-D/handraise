/**
 * Spike S2 run 4 — two facts the pump implementation depends on:
 *  1. What pixel size does maxWidth actually produce, and what does the frame
 *     metadata report? (needed to map viewer clicks back to page coordinates)
 *  2. Does the screencast survive a cross-origin navigation, or must it be
 *     restarted on every page load?
 *
 * Run: bun --env-file=.env spikes/s2/screencast4.ts
 */

import { writeFileSync } from "node:fs"
import { Solari } from "@solarisdk/browser"

type Meta = { deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number; pageScaleFactor: number; offsetTop: number; timestamp?: number }
type Frame = { data: string; metadata: Meta; sessionId: number }
type CdpSession = {
	send: (m: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>>
	on: (e: string, h: (p: never) => void) => void
}

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a)

/** Read width/height out of a JPEG's SOFn marker. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
	let i = 2
	while (i < buf.length - 9) {
		if (buf[i] !== 0xff) {
			i += 1
			continue
		}
		const marker = buf[i + 1] ?? 0
		const len = buf.readUInt16BE(i + 2)
		// SOF0..SOF15 except DHT(c4) DAC(cc) RSTn
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
		}
		i += 2 + len
	}
	return null
}

async function main() {
	const apiKey = process.env.SOLARI_API_KEY
	if (!apiKey) throw new Error("SOLARI_API_KEY missing")
	const solari = new Solari({ apiKey })
	let browser: Awaited<ReturnType<typeof solari.launch>> | undefined
	const out: Record<string, unknown> = {}
	try {
		browser = await solari.launch({ stealth: true })
		const context = browser.contexts()[0] ?? (await browser.newContext())
		// biome-ignore lint/suspicious/noExplicitAny: patchright Page surface, spike only
		const page: any = context.pages()[0] ?? (await context.newPage())
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.goto("https://github.com/login", { waitUntil: "domcontentloaded", timeout: 45_000 })
		const cdp: CdpSession = await (page.context() as { newCDPSession: (p: unknown) => Promise<CdpSession> }).newCDPSession(page)
		await cdp.send("Page.enable")

		let count = 0
		let afterNav = 0
		let navAt = 0
		const seen: { width: number; height: number; meta: Meta }[] = []
		let sample: Buffer | null = null

		cdp.on("Page.screencastFrame", ((f: Frame) => {
			count += 1
			if (navAt && Date.now() > navAt) afterNav += 1
			const buf = Buffer.from(f.data, "base64")
			if (!sample) sample = buf
			const dim = jpegSize(buf)
			if (dim && !seen.some((s) => s.width === dim.width && s.height === dim.height)) seen.push({ ...dim, meta: f.metadata })
			cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
		}) as (p: never) => void)

		// 1) pixel size at maxWidth 800 on a 1280x800 viewport
		await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 800, maxHeight: 1400, everyNthFrame: 1 })
		await page.click("#login_field").catch(() => {})
		await page.keyboard.type("abc", { delay: 120 }).catch(() => {})
		await new Promise((r) => setTimeout(r, 2500))
		out.dimensionsAtMaxWidth800 = JSON.parse(JSON.stringify(seen))
		out.framesBeforeNav = count

		// 2) survive a cross-origin navigation WITHOUT restarting the cast
		navAt = Date.now()
		log("navigating (cast still running)…")
		await page.goto("https://en.wikipedia.org/wiki/Web_browser", { waitUntil: "domcontentloaded", timeout: 45_000 })
		await page.evaluate("window.scrollTo(0, 600)").catch(() => {})
		await new Promise((r) => setTimeout(r, 3000))
		await page.evaluate("window.scrollTo(0, 1200)").catch(() => {})
		await new Promise((r) => setTimeout(r, 2000))
		out.framesAfterNavWithoutRestart = afterNav
		out.castSurvivesNavigation = afterNav > 0
		out.allDistinctDimensions = JSON.parse(JSON.stringify(seen))

		await cdp.send("Page.stopScreencast")
		if (sample) writeFileSync(new URL("./sample-frame.jpg", import.meta.url), sample)
		out.viewport = { width: 1280, height: 800 }
	} finally {
		await browser?.close().catch(() => {})
		await solari.close().catch(() => {})
	}
	writeFileSync(new URL("./results-run4.json", import.meta.url), JSON.stringify(out, null, 2))
	console.log(JSON.stringify(out, null, 2))
}

await main()
