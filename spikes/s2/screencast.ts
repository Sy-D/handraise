/**
 * Spike S2 — Does CDP Page.startScreencast work on a Solari cloud browser
 * through the Playwright-compatible SDK connection?
 *
 * Run: bun --env-file=.env spikes/s2/screencast.ts
 */

import { Solari } from "@solarisdk/browser"

type ScreencastFrameMetadata = {
	offsetTop: number
	pageScaleFactor: number
	deviceWidth: number
	deviceHeight: number
	scrollOffsetX: number
	scrollOffsetY: number
	timestamp?: number
}

type ScreencastFrame = {
	data: string
	metadata: ScreencastFrameMetadata
	sessionId: number
}

type Profile = {
	name: string
	format: "jpeg"
	quality: number
	maxWidth: number
	maxHeight: number
	everyNthFrame: number
}

type Measurement = {
	profile: Profile
	durationMs: number
	frames: number
	fps: number
	totalKb: number
	kbPerSecond: number
	meanKb: number
	medianKb: number
	maxKb: number
	minKb: number
	ackErrors: number
	firstFrameMs: number | null
	maxGapMs: number
	firstMetadata: ScreencastFrameMetadata | null
}

const TARGET_URL = "https://github.com/login"

const PROFILES: Profile[] = [
	{ name: "desktop q60 800x1400", format: "jpeg", quality: 60, maxWidth: 800, maxHeight: 1400, everyNthFrame: 1 },
	{ name: "mobile q40 480x1000", format: "jpeg", quality: 40, maxWidth: 480, maxHeight: 1000, everyNthFrame: 1 },
]

const MEASURE_MS = 15_000

function kb(bytes: number): number {
	return Math.round((bytes / 1024) * 100) / 100
}

function log(...args: unknown[]): void {
	console.log(`[${new Date().toISOString()}]`, ...args)
}

async function main(): Promise<void> {
	const apiKey = process.env.SOLARI_API_KEY
	if (!apiKey) throw new Error("SOLARI_API_KEY missing")

	const solari = new Solari({ apiKey })
	const started = Date.now()
	const results: Measurement[] = []
	let browser: Awaited<ReturnType<typeof solari.launch>> | undefined

	try {
		log("launching…")
		browser = await solari.launch({ stealth: true })
		log("launched", { id: browser.id, version: browser.version(), expiresAt: browser.expiresAt })

		const context = browser.contexts()[0] ?? (await browser.newContext())
		const page = context.pages()[0] ?? (await context.newPage())

		await page.setViewportSize({ width: 1280, height: 800 }).catch((e: unknown) => log("setViewportSize failed", e))
		log("goto", TARGET_URL)
		await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45_000 })
		log("loaded, title:", await page.title())

		// --- CDP path probe -------------------------------------------------
		const ctx = page.context() as unknown as {
			newCDPSession?: (p: unknown) => Promise<CdpSession>
		}
		log("typeof context.newCDPSession =", typeof ctx.newCDPSession)
		if (typeof ctx.newCDPSession !== "function") {
			throw new Error("context.newCDPSession is not available on this SDK connection")
		}
		const cdp = await ctx.newCDPSession(page)
		log("CDP session created via page.context().newCDPSession(page)")

		const version = await cdp.send("Browser.getVersion")
		log("Browser.getVersion =", version)

		for (const profile of PROFILES) {
			results.push(await measure(cdp, page, profile))
		}
	} finally {
		log("closing browser…")
		await browser?.close().catch((e: unknown) => log("browser.close failed", e))
		await solari.close().catch((e: unknown) => log("solari.close failed", e))
		log("closed. total wall clock", Math.round((Date.now() - started) / 1000), "s")
	}

	console.log("\n=== RESULTS ===")
	console.log(JSON.stringify(results, null, 2))
}

type CdpSession = {
	send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
	on: (event: string, handler: (payload: never) => void) => void
	off: (event: string, handler: (payload: never) => void) => void
}

type PageLike = {
	mouse: { wheel: (dx: number, dy: number) => Promise<void> }
	evaluate: (fn: string) => Promise<unknown>
}

async function measure(cdp: CdpSession, page: unknown, profile: Profile): Promise<Measurement> {
	const p = page as PageLike
	const sizes: number[] = []
	let ackErrors = 0
	let firstFrameAt: number | null = null
	let lastFrameAt: number | null = null
	let maxGapMs = 0
	let firstMetadata: ScreencastFrameMetadata | null = null

	const onFrame = (frame: ScreencastFrame): void => {
		const now = Date.now()
		if (firstFrameAt === null) {
			firstFrameAt = now
			firstMetadata = frame.metadata
		}
		if (lastFrameAt !== null) maxGapMs = Math.max(maxGapMs, now - lastFrameAt)
		lastFrameAt = now
		sizes.push(Buffer.from(frame.data, "base64").length)
		// MUST ack, otherwise Chromium stops sending after a couple of frames.
		cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {
			ackErrors += 1
		})
	}

	cdp.on("Page.screencastFrame", onFrame as (payload: never) => void)

	log(`--- profile: ${profile.name} ---`)
	await cdp.send("Page.enable")
	const t0 = Date.now()
	await cdp.send("Page.startScreencast", {
		format: profile.format,
		quality: profile.quality,
		maxWidth: profile.maxWidth,
		maxHeight: profile.maxHeight,
		everyNthFrame: profile.everyNthFrame,
	})
	log("startScreencast ok")

	// Keep the page visually busy so frames keep flowing.
	const deadline = t0 + MEASURE_MS
	let down = true
	while (Date.now() < deadline) {
		await p.mouse.wheel(0, down ? 220 : -220).catch(() => {})
		down = !down || Math.random() > 0.35
		await new Promise((r) => setTimeout(r, 120))
	}
	const durationMs = Date.now() - t0

	await cdp.send("Page.stopScreencast")
	cdp.off("Page.screencastFrame", onFrame as (payload: never) => void)
	// Drain late frames.
	await new Promise((r) => setTimeout(r, 300))

	const total = sizes.reduce((a, b) => a + b, 0)
	const sorted = [...sizes].sort((a, b) => a - b)
	const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0

	const m: Measurement = {
		profile,
		durationMs,
		frames: sizes.length,
		fps: Math.round((sizes.length / (durationMs / 1000)) * 100) / 100,
		totalKb: kb(total),
		kbPerSecond: Math.round((total / 1024 / (durationMs / 1000)) * 100) / 100,
		meanKb: sizes.length ? kb(total / sizes.length) : 0,
		medianKb: kb(median ?? 0),
		maxKb: sizes.length ? kb(Math.max(...sizes)) : 0,
		minKb: sizes.length ? kb(Math.min(...sizes)) : 0,
		ackErrors,
		firstFrameMs: firstFrameAt === null ? null : firstFrameAt - t0,
		maxGapMs,
		firstMetadata,
	}
	log("result", m)
	return m
}

await main()
