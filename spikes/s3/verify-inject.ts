/**
 * S3 v3 — proves spikes/s3/inject.ts works end-to-end on a live Solari browser,
 * including the frameToViewport coordinate math against a real screencast frame
 * that is deliberately downscaled (maxWidth 640) and a scrolled page.
 *
 * Run: bun --env-file=.env spikes/s3/verify-inject.ts
 */

import { Solari } from "@solarisdk/browser"
import { click, frameToViewport, insertText, Mod, pressKey, scroll, type ScreencastMetadata } from "./inject"

const results: Record<string, unknown> = {}
const log = (k: string, v: unknown) => {
	results[k] = v
	console.log(`[S3v3] ${k}:`, JSON.stringify(v))
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><body style="margin:0;font-family:system-ui">
<div style="height:900px;background:#eee">spacer (forces scroll)</div>
<button id="target" style="width:300px;height:90px;font-size:24px;margin-left:150px">TARGET</button>
<input id="inp" style="display:block;margin:30px 0 0 150px;width:400px;height:50px;font-size:22px">
<div style="height:900px"></div>
<div style="position:fixed;right:8px;bottom:8px;background:#000;color:#0f0;padding:6px;font:14px monospace">
  hit:<span id="hit">-</span> val:<span id="val">-</span> keys:<span id="keys">-</span>
</div>
<script>
 document.getElementById('target').addEventListener('click', e => {
   document.getElementById('hit').textContent = 'YES@' + Math.round(e.clientX) + ',' + Math.round(e.clientY);
 });
 const i = document.getElementById('inp');
 i.addEventListener('input', () => { document.getElementById('val').textContent = i.value; });
 i.addEventListener('keydown', e => {
   const k = document.getElementById('keys');
   k.textContent = (k.textContent === '-' ? '' : k.textContent + ',') + e.key + (e.ctrlKey ? '^' : '');
 });
</script></body>`

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY ?? "" })

async function main() {
	const browser = await solari.launch()
	try {
		const page = await browser.newPage()
		await page.setContent(PAGE)
		const cdp = await page.context().newCDPSession(page)
		const read = () =>
			page.evaluate(() => ({
				hit: document.getElementById("hit")?.textContent,
				val: document.getElementById("val")?.textContent,
				keys: document.getElementById("keys")?.textContent,
				inp: (document.getElementById("inp") as HTMLInputElement)?.value,
				scrollY: window.scrollY,
			}))

		// scroll the page so the target is on screen and scrollOffsetY != 0
		await scroll(cdp, { x: 640, y: 360 }, { y: 800 })
		await sleep(500)
		log("after scroll", await read())

		// grab one DOWNSCALED screencast frame (maxWidth 640 => k = 0.5)
		const frame = await new Promise<{ meta: ScreencastMetadata; w: number; h: number }>((res, rej) => {
			const t = setTimeout(() => rej(new Error("no frame")), 15_000)
			cdp.on("Page.screencastFrame", async (p: unknown) => {
				const q = p as { data: string; sessionId: number; metadata: ScreencastMetadata }
				clearTimeout(t)
				await cdp.send("Page.screencastFrameAck", { sessionId: q.sessionId }).catch(() => {})
				const b = Buffer.from(q.data, "base64")
				let w = -1
				let h = -1
				let i = 2
				while (i < b.length - 9) {
					if (b[i] !== 0xff) {
						i++
						continue
					}
					const m = b[i + 1] as number
					if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
						h = b.readUInt16BE(i + 5)
						w = b.readUInt16BE(i + 7)
						break
					}
					i += 2 + b.readUInt16BE(i + 2)
				}
				res({ meta: q.metadata, w, h })
			})
			cdp
				.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 640, maxHeight: 640, everyNthFrame: 1 })
				.catch(rej)
		})
		await cdp.send("Page.stopScreencast").catch(() => {})
		log("downscaled frame", { meta: frame.meta, imageW: frame.w, imageH: frame.h })

		// where is the target, in CSS viewport coords? (ground truth)
		const box = await page.locator("#target").boundingBox()
		if (!box) throw new Error("no box")
		const truth = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
		log("ground truth viewport coords", truth)

		// simulate the phone: the frame is shown in a 360x203 <img>.
		const display = { width: 360, height: (360 * frame.h) / frame.w }
		const kImg = frame.w / frame.meta.deviceWidth
		const tapInDisplay = {
			x: (truth.x * kImg * display.width) / frame.w,
			y: ((truth.y * kImg + frame.meta.offsetTop * kImg) * display.height) / frame.h,
		}
		const mapped = frameToViewport(tapInDisplay, display, { width: frame.w, height: frame.h }, frame.meta)
		log("phone tap -> mapped viewport coords", { display, tapInDisplay, mapped, truth })

		await click(cdp, mapped)
		await sleep(300)
		const afterClick = await read()
		log("after click via mapped coords", afterClick)

		// text + keys through the module
		const ibox = await page.locator("#inp").boundingBox()
		if (!ibox) throw new Error("no ibox")
		await click(cdp, { x: ibox.x + ibox.width / 2, y: ibox.y + ibox.height / 2 })
		await insertText(cdp, "123456")
		await pressKey(cdp, "Backspace")
		await pressKey(cdp, "a", Mod.Ctrl) // must NOT type "a"
		await pressKey(cdp, "Enter")
		await sleep(300)
		const final = await read()
		log("FINAL", final)

		const mapErrPx = Math.hypot(mapped.x - truth.x, mapped.y - truth.y)
		log("VERDICT", {
			coordMappingErrorPx: Number(mapErrPx.toFixed(3)),
			clickLanded: afterClick.hit?.startsWith("YES") ?? false,
			insertTextFiredNoKeydown: final.keys === "Backspace,a^,Enter",
			ctrlADidNotType: final.inp === "12345",
			value: final.inp,
			keys: final.keys,
		})
		console.log("\n=== S3v3 RAW ===")
		console.log(JSON.stringify(results, null, 2))
	} finally {
		await browser.close().catch(() => {})
		await solari.close().catch(() => {})
	}
}

main().catch((e) => {
	console.error("[S3v3] FATAL", e)
	process.exit(1)
})
