/**
 * Spike S2 run 2 — realistic load. Run 1 measured a static page (Chromium only
 * emits a screencast frame on repaint), so fps/KB were meaningless.
 *
 * Scenarios:
 *  A  typing   — GitHub login form, keystrokes only (realistic 2FA handoff)
 *  B  motion   — continuous rAF scroll on a long page (upper bound)
 *  C  mobile   — same motion at q40/480 (phone profile)
 *  D  no-ack   — control: does the stream really stall without screencastFrameAck?
 *
 * Run: bun --env-file=.env spikes/s2/screencast2.ts
 */

import { Solari } from "@solarisdk/browser"

type Meta = {
	offsetTop: number
	pageScaleFactor: number
	deviceWidth: number
	deviceHeight: number
	scrollOffsetX: number
	scrollOffsetY: number
	timestamp?: number
}
type Frame = { data: string; metadata: Meta; sessionId: number }
type CdpSession = {
	send: (m: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>>
	on: (e: string, h: (p: never) => void) => void
	off: (e: string, h: (p: never) => void) => void
}
type Cast = { format: "jpeg"; quality: number; maxWidth: number; maxHeight: number; everyNthFrame: number }

const DESKTOP: Cast = { format: "jpeg", quality: 60, maxWidth: 800, maxHeight: 1400, everyNthFrame: 1 }
const MOBILE: Cast = { format: "jpeg", quality: 40, maxWidth: 480, maxHeight: 1000, everyNthFrame: 1 }

const kb = (b: number) => Math.round((b / 1024) * 100) / 100
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a)

type Result = {
	scenario: string
	cast: Cast
	durationMs: number
	frames: number
	fps: number
	kbPerSecond: number
	meanKb: number
	medianKb: number
	p95Kb: number
	maxKb: number
	minKb: number
	firstFrameMs: number | null
	maxGapMs: number
	medianGapMs: number
	lagMsMedian: number | null
	distinctSizes: number
	sampleMeta: Meta | null
}

async function run(
	cdp: CdpSession,
	scenario: string,
	cast: Cast,
	ms: number,
	drive: (deadline: number) => Promise<void>,
	opts: { ack?: boolean } = {},
): Promise<Result> {
	const ack = opts.ack !== false
	const sizes: number[] = []
	const gaps: number[] = []
	const lags: number[] = []
	let first: number | null = null
	let last: number | null = null
	let meta: Meta | null = null

	const onFrame = (f: Frame) => {
		const now = Date.now()
		if (first === null) {
			first = now
			meta = f.metadata
		} else if (last !== null) gaps.push(now - last)
		last = now
		sizes.push(Buffer.from(f.data, "base64").length)
		if (typeof f.metadata.timestamp === "number") lags.push(now - f.metadata.timestamp * 1000)
		if (ack) cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
	}

	cdp.on("Page.screencastFrame", onFrame as (p: never) => void)
	log(`--- ${scenario} (ack=${ack}) ---`)
	const t0 = Date.now()
	await cdp.send("Page.startScreencast", cast as unknown as Record<string, unknown>)
	await drive(t0 + ms)
	const durationMs = Date.now() - t0
	await cdp.send("Page.stopScreencast")
	cdp.off("Page.screencastFrame", onFrame as (p: never) => void)
	await new Promise((r) => setTimeout(r, 400))

	const total = sizes.reduce((a, b) => a + b, 0)
	const s = [...sizes].sort((a, b) => a - b)
	const g = [...gaps].sort((a, b) => a - b)
	const l = [...lags].sort((a, b) => a - b)
	const pick = (arr: number[], q: number) => (arr.length ? (arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0) : 0)

	const r: Result = {
		scenario,
		cast,
		durationMs,
		frames: sizes.length,
		fps: Math.round((sizes.length / (durationMs / 1000)) * 100) / 100,
		kbPerSecond: Math.round((total / 1024 / (durationMs / 1000)) * 100) / 100,
		meanKb: sizes.length ? kb(total / sizes.length) : 0,
		medianKb: kb(pick(s, 0.5)),
		p95Kb: kb(pick(s, 0.95)),
		maxKb: sizes.length ? kb(Math.max(...sizes)) : 0,
		minKb: sizes.length ? kb(Math.min(...sizes)) : 0,
		firstFrameMs: first === null ? null : first - t0,
		maxGapMs: gaps.length ? Math.max(...gaps) : 0,
		medianGapMs: pick(g, 0.5),
		lagMsMedian: l.length ? Math.round(pick(l, 0.5)) : null,
		distinctSizes: new Set(sizes).size,
		sampleMeta: meta,
	}
	log("=>", JSON.stringify(r))
	return r
}

async function main(): Promise<void> {
	const apiKey = process.env.SOLARI_API_KEY
	if (!apiKey) throw new Error("SOLARI_API_KEY missing")
	const solari = new Solari({ apiKey })
	const results: Result[] = []
	let browser: Awaited<ReturnType<typeof solari.launch>> | undefined

	try {
		browser = await solari.launch({ stealth: true })
		log("launched", browser.id, browser.version())
		const context = browser.contexts()[0] ?? (await browser.newContext())
		// biome-ignore lint/suspicious/noExplicitAny: patchright Page surface, spike only
		const page: any = context.pages()[0] ?? (await context.newPage())
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.goto("https://github.com/login", { waitUntil: "domcontentloaded", timeout: 45_000 })
		log("loaded:", await page.title())

		const cdp: CdpSession = await (page.context() as { newCDPSession: (p: unknown) => Promise<CdpSession> }).newCDPSession(page)
		await cdp.send("Page.enable")

		// A — typing into the login form (realistic HITL handoff traffic)
		results.push(
			await run(cdp, "A typing (github login form)", DESKTOP, 12_000, async (deadline) => {
				await page.click("#login_field").catch(() => {})
				while (Date.now() < deadline) {
					await page.keyboard.type("solari", { delay: 90 }).catch(() => {})
					await page.keyboard.press("Backspace").catch(() => {})
					await new Promise((r) => setTimeout(r, 60))
				}
			}),
		)

		// B — continuous motion, desktop profile
		await page.goto("https://en.wikipedia.org/wiki/Web_browser", { waitUntil: "domcontentloaded", timeout: 45_000 })
		const startScroll = async () => {
			await page.evaluate(`
				window.__stop && window.__stop();
				let y = 0, dir = 6, running = true;
				window.__stop = () => { running = false };
				const step = () => { if (!running) return; y += dir; if (y > 4000 || y < 0) dir = -dir; window.scrollTo(0, y); requestAnimationFrame(step) };
				requestAnimationFrame(step);
			`)
		}
		const stopScroll = async () => {
			await page.evaluate("window.__stop && window.__stop()")
		}
		const motion = async (deadline: number) => {
			await startScroll()
			while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
			await stopScroll()
		}

		results.push(await run(cdp, "B motion (rAF scroll) desktop q60/800", DESKTOP, 15_000, motion))
		results.push(await run(cdp, "C motion (rAF scroll) mobile q40/480", MOBILE, 15_000, motion))

		// D — control: no ack
		results.push(await run(cdp, "D motion, NO ack (control)", DESKTOP, 8_000, motion, { ack: false }))
	} finally {
		await browser?.close().catch((e: unknown) => log("close err", e))
		await solari.close().catch((e: unknown) => log("solari.close err", e))
		log("closed")
	}

	console.log("\n=== RESULTS ===")
	console.log(JSON.stringify(results, null, 2))
}

await main()
