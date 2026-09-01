/**
 * Spike S3 — CDP input injection on a Solari cloud browser.
 *
 * Question: can we inject mouse clicks, text and special keys via raw CDP
 * (Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText /
 * Input.dispatchTouchEvent) as the return channel for a human on a phone?
 *
 * Verification is done by reading page state back, never by "no error thrown".
 *
 * Run: bun --env-file=.env spikes/s3/input-injection.ts
 */

import { Solari } from "@solarisdk/browser"

type Result = Record<string, unknown>
const results: Result = {}
const log = (label: string, value: unknown) => {
	results[label] = value
	console.log(`[S3] ${label}:`, JSON.stringify(value))
}

const TEST_PAGE = `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;font-family:system-ui;font-size:20px">
  <div id="out" style="padding:20px">nothing yet</div>
  <button id="btn"
     style="position:absolute;left:40px;top:120px;width:260px;height:80px;font-size:24px">
    Click me
  </button>
  <input id="inp"
     style="position:absolute;left:40px;top:240px;width:400px;height:60px;font-size:24px"
     value="">
  <div id="touchout" style="position:absolute;left:40px;top:340px">no touch</div>
  <div id="touchtarget"
     style="position:absolute;left:40px;top:400px;width:260px;height:80px;background:#cde">
    touch target
  </div>
  <div id="keylog" style="position:absolute;left:40px;top:500px">keys:</div>
  <script>
    window.__clicks = [];
    window.__keys = [];
    document.getElementById('btn').addEventListener('click', (e) => {
      window.__clicks.push({ x: e.clientX, y: e.clientY, trusted: e.isTrusted, detail: e.detail });
      document.getElementById('out').textContent = 'BUTTON_CLICKED';
    });
    document.getElementById('inp').addEventListener('keydown', (e) => {
      window.__keys.push({ key: e.key, code: e.code, keyCode: e.keyCode, trusted: e.isTrusted });
      document.getElementById('keylog').textContent = 'keys: ' + window.__keys.map(k => k.key).join(',');
    });
    window.__touch = [];
    const t = document.getElementById('touchtarget');
    t.addEventListener('touchstart', (e) => {
      window.__touch.push({ type: 'touchstart', n: e.touches.length, trusted: e.isTrusted });
      document.getElementById('touchout').textContent = 'TOUCH_START';
    });
    t.addEventListener('touchend', (e) => {
      window.__touch.push({ type: 'touchend', trusted: e.isTrusted });
      document.getElementById('touchout').textContent = 'TOUCH_END';
    });
    t.addEventListener('click', (e) => {
      window.__touch.push({ type: 'click-on-touchtarget', trusted: e.isTrusted });
    });
  </script>
</body>
</html>`

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY ?? "" })

async function main() {
	const browser = await solari.launch()
	try {
		const page = await browser.newPage()
		await page.setContent(TEST_PAGE)

		const cdp = await page.context().newCDPSession(page)

		// ---------------------------------------------------------------
		// 0. Viewport / DPR baseline for the coordinate formula
		// ---------------------------------------------------------------
		const viewportSize = page.viewportSize()
		const metrics = await page.evaluate(() => ({
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			devicePixelRatio: window.devicePixelRatio,
			outerWidth: window.outerWidth,
			outerHeight: window.outerHeight,
			scrollX: window.scrollX,
			scrollY: window.scrollY,
			maxTouchPoints: navigator.maxTouchPoints,
			ua: navigator.userAgent,
		}))
		log("viewportSize (playwright)", viewportSize)
		log("window metrics", metrics)

		let layoutMetrics: unknown = null
		try {
			layoutMetrics = await cdp.send("Page.getLayoutMetrics")
			log("Page.getLayoutMetrics", layoutMetrics)
		} catch (err) {
			log("Page.getLayoutMetrics ERROR", String(err))
		}

		// ---------------------------------------------------------------
		// 1. Screencast frame metadata (what a phone UI would actually get)
		// ---------------------------------------------------------------
		try {
			const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("no screencastFrame in 10s")), 10_000)
				cdp.on("Page.screencastFrame", async (p: any) => {
					clearTimeout(timer)
					try {
						await cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId })
					} catch {
						/* ignore */
					}
					// decode PNG/JPEG header to learn the real pixel size of the frame
					const buf = Buffer.from(p.data, "base64")
					let frameW = -1
					let frameH = -1
					if (buf[0] === 0x89 && buf[1] === 0x50) {
						frameW = buf.readUInt32BE(16)
						frameH = buf.readUInt32BE(20)
					} else if (buf[0] === 0xff && buf[1] === 0xd8) {
						// minimal JPEG SOF scan
						let i = 2
						while (i < buf.length - 9) {
							if (buf[i] !== 0xff) {
								i++
								continue
							}
							const marker = buf[i + 1]
							if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
								frameH = buf.readUInt16BE(i + 5)
								frameW = buf.readUInt16BE(i + 7)
								break
							}
							i += 2 + buf.readUInt16BE(i + 2)
						}
					}
					resolve({
						metadata: p.metadata,
						base64Bytes: p.data.length,
						decodedBytes: buf.length,
						frameW,
						frameH,
					})
				})
				cdp
					.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 })
					.catch(reject)
			})
			log("screencast frame", frame)
			await cdp.send("Page.stopScreencast").catch(() => {})
		} catch (err) {
			log("screencast ERROR", String(err))
		}

		// ---------------------------------------------------------------
		// 2. MOUSE — Input.dispatchMouseEvent
		// ---------------------------------------------------------------
		const btnBox = await page.locator("#btn").boundingBox()
		log("btn boundingBox", btnBox)
		if (!btnBox) throw new Error("no bounding box for #btn")

		const bx = btnBox.x + btnBox.width / 2
		const by = btnBox.y + btnBox.height / 2

		try {
			await cdp.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: bx,
				y: by,
				button: "none",
				buttons: 0,
				clickCount: 0,
			})
			await cdp.send("Input.dispatchMouseEvent", {
				type: "mousePressed",
				x: bx,
				y: by,
				button: "left",
				buttons: 1,
				clickCount: 1,
			})
			await cdp.send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: bx,
				y: by,
				button: "left",
				buttons: 0,
				clickCount: 1,
			})
			log("mouse dispatch", "sent")
		} catch (err) {
			log("mouse dispatch ERROR", String(err))
		}

		const afterClick = await page.evaluate(() => ({
			out: document.getElementById("out")?.textContent?.trim(),
			clicks: (window as any).__clicks,
		}))
		log("MOUSE VERIFY", afterClick)
		const mouseOk = afterClick.out === "BUTTON_CLICKED"
		log("MOUSE=", mouseOk ? "yes" : "no")
		// did the click land where we aimed? -> coordinate space check
		log("coord space check", {
			sent: { x: bx, y: by },
			received: afterClick.clicks?.[0] ?? null,
			dpr: metrics.devicePixelRatio,
		})

		// ---------------------------------------------------------------
		// 3. TEXT — click into input, then Input.insertText
		// ---------------------------------------------------------------
		const inpBox = await page.locator("#inp").boundingBox()
		log("inp boundingBox", inpBox)
		if (!inpBox) throw new Error("no bounding box for #inp")
		const ix = inpBox.x + inpBox.width / 2
		const iy = inpBox.y + inpBox.height / 2

		await cdp.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: ix,
			y: iy,
			button: "left",
			buttons: 1,
			clickCount: 1,
		})
		await cdp.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: ix,
			y: iy,
			button: "left",
			buttons: 0,
			clickCount: 1,
		})

		const focusAfterClick = await page.evaluate(() => document.activeElement?.id ?? null)
		log("focus after click into input", focusAfterClick)

		try {
			await cdp.send("Input.insertText", { text: "hello from phone" })
			log("insertText", "sent")
		} catch (err) {
			log("insertText ERROR", String(err))
		}

		const afterText = await page.evaluate(() => ({
			value: (document.getElementById("inp") as HTMLInputElement)?.value,
			active: document.activeElement?.id ?? null,
		}))
		log("TEXT VERIFY", afterText)
		const textOk = afterText.value === "hello from phone"
		log("TEXT=", textOk ? "yes" : "no")

		// ---------------------------------------------------------------
		// 4. KEYS — Backspace + Enter via Input.dispatchKeyEvent
		// ---------------------------------------------------------------
		try {
			await cdp.send("Input.dispatchKeyEvent", {
				type: "rawKeyDown",
				key: "Backspace",
				code: "Backspace",
				windowsVirtualKeyCode: 8,
				nativeVirtualKeyCode: 8,
			})
			await cdp.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "Backspace",
				code: "Backspace",
				windowsVirtualKeyCode: 8,
				nativeVirtualKeyCode: 8,
			})
			log("Backspace dispatch", "sent")
		} catch (err) {
			log("Backspace dispatch ERROR", String(err))
		}

		const afterBackspace = await page.evaluate(
			() => (document.getElementById("inp") as HTMLInputElement)?.value,
		)
		log("after Backspace value", afterBackspace)

		try {
			await cdp.send("Input.dispatchKeyEvent", {
				type: "rawKeyDown",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				nativeVirtualKeyCode: 13,
				text: "\r",
				unmodifiedText: "\r",
			})
			await cdp.send("Input.dispatchKeyEvent", {
				type: "char",
				key: "Enter",
				text: "\r",
				unmodifiedText: "\r",
			})
			await cdp.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				nativeVirtualKeyCode: 13,
			})
			log("Enter dispatch", "sent")
		} catch (err) {
			log("Enter dispatch ERROR", String(err))
		}

		// also test a plain printable char via keyDown+text (alternative to insertText)
		try {
			await cdp.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "a",
				code: "KeyA",
				windowsVirtualKeyCode: 65,
				nativeVirtualKeyCode: 65,
				text: "a",
				unmodifiedText: "a",
			})
			await cdp.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "a",
				code: "KeyA",
				windowsVirtualKeyCode: 65,
				nativeVirtualKeyCode: 65,
			})
			log("printable-char-via-keyEvent", "sent")
		} catch (err) {
			log("printable-char-via-keyEvent ERROR", String(err))
		}

		const afterKeys = await page.evaluate(() => ({
			value: (document.getElementById("inp") as HTMLInputElement)?.value,
			keys: (window as any).__keys,
		}))
		log("KEYS VERIFY", afterKeys)
		const sawBackspace = afterKeys.keys?.some((k: any) => k.key === "Backspace")
		const sawEnter = afterKeys.keys?.some((k: any) => k.key === "Enter")
		const backspaceDeleted = afterBackspace === "hello from phon"
		const keysOk = Boolean(sawBackspace && sawEnter && backspaceDeleted)
		log("KEYS=", keysOk ? "yes" : "no")
		log("keys detail", { sawBackspace, sawEnter, backspaceDeleted, afterBackspace })

		// ---------------------------------------------------------------
		// 5. TOUCH — Input.dispatchTouchEvent
		// ---------------------------------------------------------------
		const tBox = await page.locator("#touchtarget").boundingBox()
		log("touchtarget boundingBox", tBox)
		let touchOk = false
		let touchNote = ""
		if (tBox) {
			const tx = tBox.x + tBox.width / 2
			const ty = tBox.y + tBox.height / 2
			try {
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [{ x: tx, y: ty, id: 1 }],
				})
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				})
				log("touch dispatch", "sent")
			} catch (err) {
				touchNote = String(err)
				log("touch dispatch ERROR", touchNote)
			}
			const afterTouch = await page.evaluate(() => ({
				out: document.getElementById("touchout")?.textContent?.trim(),
				touch: (window as any).__touch,
			}))
			log("TOUCH VERIFY", afterTouch)
			touchOk = Array.isArray(afterTouch.touch) && afterTouch.touch.length > 0
		}
		log("TOUCH=", touchOk ? "yes" : touchNote ? "no" : "no")

		// ---------------------------------------------------------------
		// 6. Real site smoke test — does injection work on a normal page too?
		// ---------------------------------------------------------------
		try {
			const page2 = await browser.newPage()
			await page2.goto("https://example.com", { waitUntil: "domcontentloaded" })
			const cdp2 = await page2.context().newCDPSession(page2)
			const linkBox = await page2.locator("a").first().boundingBox()
			log("example.com link box", linkBox)
			if (linkBox) {
				const lx = linkBox.x + linkBox.width / 2
				const ly = linkBox.y + linkBox.height / 2
				await cdp2.send("Input.dispatchMouseEvent", {
					type: "mousePressed",
					x: lx,
					y: ly,
					button: "left",
					buttons: 1,
					clickCount: 1,
				})
				await cdp2.send("Input.dispatchMouseEvent", {
					type: "mouseReleased",
					x: lx,
					y: ly,
					button: "left",
					buttons: 0,
					clickCount: 1,
				})
				await page2.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {})
				await page2.waitForTimeout(2000)
				log("example.com url after CDP click", page2.url())
			}
			await page2.close()
		} catch (err) {
			log("real site smoke ERROR", String(err))
		}

		console.log("\n=== S3 SUMMARY ===")
		console.log(
			JSON.stringify(
				{
					MOUSE: mouseOk ? "yes" : "no",
					TEXT: textOk ? "yes" : "no",
					KEYS: keysOk ? "yes" : "no",
					TOUCH: touchOk ? "yes" : "no",
				},
				null,
				2,
			),
		)
		console.log("\n=== S3 RAW ===")
		console.log(JSON.stringify(results, null, 2))
	} finally {
		await browser.close().catch(() => {})
		await solari.close().catch(() => {})
	}
}

main().catch((err) => {
	console.error("[S3] FATAL", err)
	process.exit(1)
})
