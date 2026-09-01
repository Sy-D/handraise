/**
 * Spike S4b — The rolling idle window `timeoutMs` lives on SANDBOXES/DESKTOPS,
 * not on browser sessions. This measures it directly with a short window.
 *
 * Modes:
 *   idle      — create with timeoutMs, then nothing. State is polled from the
 *               OUTSIDE via sandboxes.get() (control plane, not the session).
 *   keepalive — same window, but a cheap in-session exec every KEEPALIVE_MS.
 *   probe     — same window, but ONLY the outside sandboxes.get() poll runs.
 *               Compared against `idle` this shows whether a control-plane read
 *               counts as activity.
 *
 * Run: bun --env-file=.env spikes/s4/sandbox-idle.ts <mode> <durationSec>
 */

import { appendFileSync } from "node:fs"
import { SolariClient } from "@solarisdk/sdk"

type Mode = "idle" | "keepalive" | "probe" | "ws" | "resume"

const MODE = (process.argv[2] ?? "idle") as Mode
const DURATION_SEC = Number(process.argv[3] ?? 600)
const TIMEOUT_MS = 60_000
const POLL_MS = 15_000
const KEEPALIVE_MS = 30_000
const LOG = `${import.meta.dir}/log-sandbox-${MODE}.jsonl`

const t0 = Date.now()
const rel = () => Math.round((Date.now() - t0) / 100) / 10

function log(event: string, data: Record<string, unknown> = {}): void {
	const line = JSON.stringify({ t: rel(), iso: new Date().toISOString(), mode: MODE, event, ...data })
	appendFileSync(LOG, `${line}\n`)
	console.log(line)
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

async function main(): Promise<void> {
	const apiKey = process.env.SOLARI_API_KEY
	if (!apiKey) throw new Error("SOLARI_API_KEY missing")

	const pt = new SolariClient({ apiKey })
	let sandbox: Awaited<ReturnType<typeof pt.sandboxes.create>> | undefined

	try {
		log("creating", { timeoutMs: TIMEOUT_MS, durationSec: DURATION_SEC })
		sandbox = await pt.sandboxes.create({ template: "base", timeoutMs: TIMEOUT_MS })
		log("created", { id: sandbox.id, expiresAt: sandbox.expiresAt })
		if (MODE === "keepalive" || MODE === "ws") {
			await sandbox.connect()
			log("connected", { connected: sandbox.connected })
		}

		if (MODE === "resume") {
			// Let it auto-pause (no touches at all), then try to bring it back.
			const waitMs = TIMEOUT_MS * 2
			log("sleeping-past-idle-window", { waitMs })
			await new Promise((r) => setTimeout(r, waitMs))
			const paused = await pt.sandboxes.get(sandbox.id)
			log("view-after-window", { state: paused.state, expiresAt: paused.expiresAt, seconds: rel() })
			const t = Date.now()
			try {
				await sandbox.resume()
				log("resume-ok", { ms: Date.now() - t, seconds: rel() })
				const r = await sandbox.commands.run("echo", { args: ["resumed"] })
				log("post-resume-exec", { exitCode: r.exitCode, stdout: (r.stdout ?? "").trim() })
				const v = await pt.sandboxes.get(sandbox.id)
				log("view-after-resume", { state: v.state, expiresAt: v.expiresAt })
			} catch (e) {
				log("resume-error", { ms: Date.now() - t, ...describeError(e) })
			}
			await sandbox.kill().catch(() => {})
			log("done", { seconds: rel() })
			return
		}

		const deadline = Date.now() + DURATION_SEC * 1000
		let lastKeepalive = Date.now()
		let dead = false

		while (Date.now() < deadline && !dead) {
			await new Promise((r) => setTimeout(r, POLL_MS))

			if (MODE === "ws") {
				// Local-only signal: is the control WebSocket still open? No bytes sent.
				log("ws-poll", { connected: sandbox.connected })
			}

			if (MODE === "keepalive" || MODE === "probe") {
				try {
					const view = await pt.sandboxes.get(sandbox.id)
					log("view", { state: view.state, expiresAt: view.expiresAt })
					if (view.state !== "running") {
						log("DEAD-per-control-plane", { state: view.state, atSeconds: rel() })
						dead = true
					}
				} catch (e) {
					log("get-error", { atSeconds: rel(), ...describeError(e) })
					dead = true
				}
			}

			if (MODE === "keepalive" && Date.now() - lastKeepalive >= KEEPALIVE_MS) {
				lastKeepalive = Date.now()
				try {
					const r = await sandbox.commands.run("true")
					log("keepalive-ok", { exitCode: r.exitCode })
				} catch (e) {
					log("keepalive-error", describeError(e))
				}
			}
		}

		// `idle` mode never touched the control plane during the window; check now.
		try {
			const view = await pt.sandboxes.get(sandbox.id)
			log("final-view", { state: view.state, expiresAt: view.expiresAt, seconds: rel() })
		} catch (e) {
			log("final-get-error", { seconds: rel(), ...describeError(e) })
		}
		try {
			await sandbox.connect()
			const r = await sandbox.commands.run("echo", { args: ["alive"] })
			log("final-exec-ok", { exitCode: r.exitCode, stdout: (r.stdout ?? "").trim(), seconds: rel() })
		} catch (e) {
			log("final-exec-error", { seconds: rel(), ...describeError(e) })
		}
	} catch (e) {
		log("FATAL", describeError(e))
	} finally {
		await sandbox?.kill().catch((e: unknown) => log("kill-error", describeError(e)))
		log("done", { seconds: rel() })
	}
}

await main()
