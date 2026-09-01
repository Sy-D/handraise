/**
 * Spike S2 run 3 — the scenarios that matter for a HITL handoff:
 *  A  typing  — keystrokes in the GitHub login form (what a takeover really looks like)
 *  E  idle    — nothing happens (cost of holding an open viewer)
 *  F  motion with everyNthFrame: 2 (does throttling halve the bitrate?)
 *
 * Writes spikes/s2/results-run3.json so nothing is lost to stdout truncation.
 * Run: bun --env-file=.env spikes/s2/screencast3.ts
 */

import { writeFileSync } from "node:fs"
import { Solari } from "@solarisdk/browser"

type Meta = { deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number; pageScaleFactor: number; offsetTop: number; timestamp?: number }
type Frame = { data: string; metadata: Meta; sessionId: number }
type CdpSession = {
	send: (m: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>>
	on: (e: string, h: (p: never) => void) => void
	off: (e: string, h: (p: never) => void) => void
}
type Cast = { format: "jpeg"; quality: number; maxWidth: number; maxHeight: number; everyNthFrame: number }

const DESKTOP: Cast = { format: "jpeg", quality: 60, maxWidth: 800, maxHeight: 1400, everyNthFrame: 1 }
const kb = (b: number) => Math.round((b / 1024) * 100) / 100
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a)

async function run(cdp: CdpSession, scenario: string, cast: Cast, ms: number, drive: (d: number) => Promise<void>) {
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
		cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
	}
	cdp.on("Page.screencastFrame", onFrame as (p: never) => void)
	log(`--- ${scenario} ---`)
	const t0 = Date.now()
	await cdp.send("Page.startScreencast", cast as unknown as Record<string, unknown>)
	await drive(t0 + ms)
	const durationMs = Date.now() - t0
	await cdp.send("Page.stopScreencast")
	cdp.off("Page.screencastFrame", onFrame as (p: never) => void)
	await new Promise((r) => setTimeout(r, 400))
	const total = sizes.reduce((a, b) => a + b, 0)
	const pick = (arr: number[], q: number) => {
		const s = [...arr].sort((a, b) => a - b)
		return s.length ? (s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0) : 0
	}
	const r = {
		scenario,
		cast,
		durationMs,
		frames: sizes.length,
		fps: Math.round((sizes.length / (durationMs / 1000)) * 100) / 100,
		kbPerSecond: Math.round((total / 1024 / (durationMs / 1000)) * 100) / 100,
		meanKb: sizes.length ? kb(total / sizes.length) : 0,
		medianKb: kb(pick(sizes, 0.5)),
		p95Kb: kb(pick(sizes, 0.95)),
		maxKb: sizes.length ? kb(Math.max(...sizes)) : 0,
		minKb: sizes.length ? kb(Math.min(...sizes)) : 0,
		firstFrameMs: first === null ? null : first - t0,
		maxGapMs: gaps.length ? Math.max(...gaps) : 0,
		medianGapMs: pick(gaps, 0.5),
		lagMsMedian: lags.length ? Math.round(pick(lags, 0.5)) : null,
		distinctSizes: new Set(sizes).size,
		sampleMeta: meta,
	}
	log("=>", JSON.stringify(r))
	return r
}

async function main() {
	const apiKey = process.env.SOLARI_API_KEY
	if (!apiKey) throw new Error("SOLARI_API_KEY missing")
	const solari = new Solari({ apiKey })
	const results: unknown[] = []
	let browser: Awaited<ReturnType<typeof solari.launch>> | undefined
	try {
		browser = await solari.launch({ stealth: true })
		log("launched", browser.id, browser.version())
		const context = browser.contexts()[0] ?? (await browser.newContext())
		// biome-ignore lint/suspicious/noExplicitAny: patchright Page surface, spike only
		const page: any = context.pages()[0] ?? (await context.newPage())
		await page.setViewportSize({ width: 1280, height: 800 })
		await page.goto("https://github.com/login", { waitUntil: "domcontentloaded", timeout: 45_000 })
		const cdp: CdpSession = await (page.context() as { newCDPSession: (p: unknown) => Promise<CdpSession> }).newCDPSession(page)
		await cdp.send("Page.enable")

		results.push(
			await run(cdp, "A typing (github login form) q60/800", DESKTOP, 12_000, async (deadline) => {
				await page.click("#login_field").catch(() => {})
				while (Date.now() < deadline) {
					await page.keyboard.type("solari", { delay: 90 }).catch(() => {})
					await page.keyboard.press("Backspace").catch(() => {})
					await new Promise((r) => setTimeout(r, 60))
				}
			}),
		)

		results.push(
			await run(cdp, "E idle (nothing happens) q60/800", DESKTOP, 8_000, async (deadline) => {
				while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
			}),
		)

		await page.goto("https://en.wikipedia.org/wiki/Web_browser", { waitUntil: "domcontentloaded", timeout: 45_000 })
		const motion = async (deadline: number) => {
			await page.evaluate(`
				window.__stop && window.__stop();
				let y = 0, dir = 6, running = true;
				window.__stop = () => { running = false };
				const step = () => { if (!running) return; y += dir; if (y > 4000 || y < 0) dir = -dir; window.scrollTo(0, y); requestAnimationFrame(step) };
				requestAnimationFrame(step);
			`)
			while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
			await page.evaluate("window.__stop && window.__stop()")
		}
		results.push(await run(cdp, "F motion everyNthFrame=2 q60/800", { ...DESKTOP, everyNthFrame: 2 }, 10_000, motion))
	} finally {
		await browser?.close().catch((e: unknown) => log("close err", e))
		await solari.close().catch((e: unknown) => log("solari.close err", e))
		log("closed")
	}
	writeFileSync(new URL("./results-run3.json", import.meta.url), JSON.stringify(results, null, 2))
	log("wrote results-run3.json")
}

await main()
