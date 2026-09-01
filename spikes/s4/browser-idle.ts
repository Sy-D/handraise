/**
 * Spike S4 — Does a Solari BROWSER session survive a multi-minute human pause?
 *
 * Modes:
 *   idle       — launch, one goto, then ZERO remote traffic. Liveness is polled
 *                locally via browser.isConnected() (no bytes on the wire), so
 *                the probe itself cannot reset any server-side idle window.
 *   keepalive  — same, but page.evaluate("1") every KEEPALIVE_MS.
 *   screencast — same, but a CDP Page.startScreencast stays open (frames + acks)
 *                on an animated page. No other calls.
 *
 * Run: bun --env-file=.env spikes/s4/browser-idle.ts <mode> <durationSec>
 */

import { appendFileSync } from "node:fs"
import { Solari } from "@solarisdk/browser"

type Mode = "idle" | "keepalive" | "screencast"

const MODE = (process.argv[2] ?? "idle") as Mode
const DURATION_SEC = Number(process.argv[3] ?? 1500)
const POLL_MS = 5_000
const KEEPALIVE_MS = 25_000
const LABEL = process.argv[4] ?? ""
const LOG = `${import.meta.dir}/log-browser-${MODE}${LABEL ? `-${LABEL}` : ""}.jsonl`

const t0 = Date.now()
const rel = () => Math.round((Date.now() - t0) / 100) / 10

function log(event: string, data: Record<string, unknown> = {}): void {
	const line = JSON.stringify({ t: rel(), iso: new Date().toISOString(), mode: MODE, event, ...data })
	appendFileSync(LOG, `${line}\n`)
	console.log(line)
}

// A page that repaints forever, so the screencast has frames to push.
const ANIMATED =
	"data:text/html,<style>div{width:80px;height:80px;background:%23c33;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style><div></div><p>handraise s4</p>"

type CdpSession = {
	send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
	on: (event: string, handler: (payload: never) => void) => void
}

function describeError(e: unknown): Record<string, unknown> {
	if (e instanceof Error) {
		return {
			name: e.constructor.name,
			errName: e.name,
			message: e.message.split("\n").slice(0, 4).join(" | "),
			code: (e as { code?: unknown }).code,
			status: (e as { status?: unknown }).status,
		}
	}
	return { raw: String(e) }
}

async function controlPlaneProbe(solari: Solari, id: string, tag: string): Promise<void> {
	for (const path of [`/sessions/${id}`, "/sessions"]) {
		try {
			const res = await solari.request("GET", path)
			const body = await res.text().catch(() => "")
			log("control-plane", { tag, path, status: res.status, body: body.slice(0, 400) })
		} catch (e) {
			log("control-plane-error", { tag, path, ...describeError(e) })
		}
	}
}

async function main(): Promise<void> {
	const apiKey = process.env.SOLARI_API_KEY
	if (!apiKey) throw new Error("SOLARI_API_KEY missing")

	const solari = new Solari({ apiKey })
	let browser: Awaited<ReturnType<typeof solari.launch>> | undefined
	let disconnectedAt: number | null = null

	try {
		log("launching", { durationSec: DURATION_SEC })
		browser = await solari.launch()
		log("launched", { id: browser.id, version: browser.version(), expiresAt: browser.expiresAt })

		const raw = browser.raw as unknown as { on: (ev: string, cb: () => void) => void }
		raw.on("disconnected", () => {
			disconnectedAt = rel()
			log("browser-disconnected-event", {})
		})

		const context = browser.contexts()[0] ?? (await browser.newContext())
		const page = context.pages()[0] ?? (await context.newPage())
		page.on("close", () => log("page-close-event", {}))

		await page.goto(MODE === "screencast" ? ANIMATED : "https://example.com", {
			waitUntil: "domcontentloaded",
			timeout: 45_000,
		})
		log("loaded", { title: await page.title() })

		// One-time, BEFORE the idle window starts: does a status API exist at all?
		await controlPlaneProbe(solari, browser.id, "t0")

		let frames = 0
		let framesAtLastPoll = 0
		if (MODE === "screencast") {
			const ctx = page.context() as unknown as { newCDPSession: (p: unknown) => Promise<CdpSession> }
			const cdp = await ctx.newCDPSession(page)
			cdp.on("Page.screencastFrame", ((f: { sessionId: number }) => {
				frames += 1
				cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
			}) as (p: never) => void)
			await cdp.send("Page.enable")
			await cdp.send("Page.startScreencast", { format: "jpeg", quality: 40, maxWidth: 640, maxHeight: 480, everyNthFrame: 1 })
			log("screencast-started", {})
		}

		const deadline = Date.now() + DURATION_SEC * 1000
		let lastKeepalive = Date.now()

		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, POLL_MS))
			const connected = browser.isConnected()
			const extra: Record<string, unknown> = { connected, closed: page.isClosed() }
			if (MODE === "screencast") {
				extra.frames = frames
				extra.framesSinceLastPoll = frames - framesAtLastPoll
				framesAtLastPoll = frames
			}
			log("poll", extra)

			if (!connected || disconnectedAt !== null) {
				log("DEAD", { atSeconds: disconnectedAt ?? rel() })
				try {
					const title = await page.title()
					log("post-death-title-unexpectedly-ok", { title })
				} catch (e) {
					log("post-death-page.title-error", describeError(e))
				}
				try {
					await page.evaluate("1")
					log("post-death-evaluate-unexpectedly-ok", {})
				} catch (e) {
					log("post-death-page.evaluate-error", describeError(e))
				}
				await controlPlaneProbe(solari, browser.id, "after-death")
				break
			}

			if (MODE === "keepalive" && Date.now() - lastKeepalive >= KEEPALIVE_MS) {
				lastKeepalive = Date.now()
				const started = Date.now()
				try {
					const v = await page.evaluate("1")
					log("keepalive-ok", { result: v, ms: Date.now() - started })
				} catch (e) {
					log("keepalive-error", { ms: Date.now() - started, ...describeError(e) })
				}
			}
		}

		if (browser.isConnected()) {
			try {
				const title = await page.title()
				log("ALIVE-at-end", { title, seconds: rel() })
			} catch (e) {
				log("end-title-error", { seconds: rel(), ...describeError(e) })
			}
			await controlPlaneProbe(solari, browser.id, "at-end")
		}
	} catch (e) {
		log("FATAL", describeError(e))
	} finally {
		await browser?.close().catch((e: unknown) => log("close-error", describeError(e)))
		await solari.close().catch((e: unknown) => log("solari-close-error", describeError(e)))
		log("done", { seconds: rel() })
	}
}

await main()
