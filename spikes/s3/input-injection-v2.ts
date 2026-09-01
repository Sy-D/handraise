/**
 * Spike S3 v2 — CDP input injection on a Solari cloud browser.
 *
 * v1 finding: page.evaluate on a Solari browser runs in an ISOLATED world
 * (patchright stealth fork). `window.__foo` set by an inline page script is
 * NOT visible to page.evaluate. Only the DOM is shared.
 * => v2 reads every result back through the DOM (textContent / input.value).
 *
 * Run: bun --env-file=.env spikes/s3/input-injection-v2.ts
 */

import { Solari } from "@solarisdk/browser"

const results: Record<string, unknown> = {}
const log = (label: string, value: unknown) => {
	results[label] = value
	console.log(`[S3v2] ${label}:`, JSON.stringify(value))
}

const TEST_PAGE = `<!doctype html>
<html><body style="margin:0;font-family:system-ui;font-size:18px">
  <button id="btn" style="position:absolute;left:40px;top:120px;width:260px;height:80px;font-size:22px">Click me</button>
  <input id="inp" style="position:absolute;left:40px;top:240px;width:400px;height:50px;font-size:22px" value="">
  <div id="touchtarget" style="position:absolute;left:40px;top:400px;width:260px;height:80px;background:#cde">touch target</div>
  <div id="scrollbox" style="position:absolute;left:600px;top:120px;width:300px;height:200px;overflow:auto;border:1px solid #000">
    <div style="height:2000px">tall</div>
  </div>
  <div style="position:absolute;left:40px;top:520px;width:1100px">
    <div>clickLog: <span id="clickLog">-</span></div>
    <div>keyLog: <span id="keyLog">-</span></div>
    <div>touchLog: <span id="touchLog">-</span></div>
    <div>submitLog: <span id="submitLog">-</span></div>
    <div>selLog: <span id="selLog">-</span></div>
    <div>scrollLog: <span id="scrollLog">-</span></div>
    <div>worldProbe: <span id="worldProbe">-</span></div>
  </div>
  <script>
    const put = (id, s) => { document.getElementById(id).textContent = s; };
    const app = (id, s) => { const e = document.getElementById(id); e.textContent = (e.textContent === '-' ? '' : e.textContent + '|') + s; };

    window.__mainWorldMarker = 'MAIN_WORLD_ONLY';
    put('worldProbe', 'set-by-inline-script');

    document.getElementById('btn').addEventListener('click', (e) => {
      put('clickLog', 'CLICK x=' + Math.round(e.clientX) + ' y=' + Math.round(e.clientY)
        + ' trusted=' + e.isTrusted + ' detail=' + e.detail + ' btn=' + e.button);
    });

    const inp = document.getElementById('inp');
    inp.addEventListener('keydown', (e) => {
      app('keyLog', 'DOWN:' + e.key + '/' + e.code + '/' + e.keyCode
        + (e.ctrlKey ? '+ctrl' : '') + (e.shiftKey ? '+shift' : '')
        + (e.metaKey ? '+meta' : '') + '/t=' + e.isTrusted);
    });
    inp.addEventListener('keypress', (e) => { app('keyLog', 'PRESS:' + e.key); });
    inp.addEventListener('select', () => {
      put('selLog', 'sel ' + inp.selectionStart + '-' + inp.selectionEnd);
    });

    // Enter inside a form -> submit is the real-world 2FA case
    const form = document.createElement('form');
    form.style.display = 'none';
    document.body.appendChild(form);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') put('submitLog', 'ENTER_SEEN');
    });

    const t = document.getElementById('touchtarget');
    t.addEventListener('touchstart', (e) => {
      app('touchLog', 'START n=' + e.touches.length + ' x=' + Math.round(e.touches[0] ? e.touches[0].clientX : -1) + ' t=' + e.isTrusted);
    });
    t.addEventListener('touchend', (e) => { app('touchLog', 'END t=' + e.isTrusted); });
    t.addEventListener('click', (e) => { app('touchLog', 'COMPAT_CLICK t=' + e.isTrusted); });

    document.getElementById('scrollbox').addEventListener('scroll', (e) => {
      put('scrollLog', 'top=' + Math.round(e.target.scrollTop));
    });
  </script>
</body></html>`

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY ?? "" })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
	const browser = await solari.launch()
	try {
		const page = await browser.newPage()
		await page.setContent(TEST_PAGE)
		const cdp = await page.context().newCDPSession(page)

		const read = () =>
			page.evaluate(() => ({
				clickLog: document.getElementById("clickLog")?.textContent,
				keyLog: document.getElementById("keyLog")?.textContent,
				touchLog: document.getElementById("touchLog")?.textContent,
				submitLog: document.getElementById("submitLog")?.textContent,
				selLog: document.getElementById("selLog")?.textContent,
				scrollLog: document.getElementById("scrollLog")?.textContent,
				worldProbe: document.getElementById("worldProbe")?.textContent,
				value: (document.getElementById("inp") as HTMLInputElement)?.value,
				active: document.activeElement?.id ?? null,
			}))

		// ---- 0. isolated-world proof ------------------------------------
		const worldCheck = await page.evaluate(() => ({
			mainWorldMarker: (window as { __mainWorldMarker?: string }).__mainWorldMarker ?? "UNDEFINED",
			domReadable: document.getElementById("worldProbe")?.textContent,
		}))
		log("ISOLATED WORLD CHECK", worldCheck)

		// ---- 1. mouse ---------------------------------------------------
		const btn = await page.locator("#btn").boundingBox()
		if (!btn) throw new Error("no btn box")
		const bx = btn.x + btn.width / 2
		const by = btn.y + btn.height / 2
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bx, y: by, button: "none", buttons: 0 })
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
		log("mouse sent at", { x: bx, y: by })

		// ---- 2. focus input + insertText ---------------------------------
		const inp = await page.locator("#inp").boundingBox()
		if (!inp) throw new Error("no inp box")
		const ix = inp.x + inp.width / 2
		const iy = inp.y + inp.height / 2
		for (const type of ["mousePressed", "mouseReleased"] as const) {
			await cdp.send("Input.dispatchMouseEvent", {
				type,
				x: ix,
				y: iy,
				button: "left",
				buttons: type === "mousePressed" ? 1 : 0,
				clickCount: 1,
			})
		}
		await cdp.send("Input.insertText", { text: "hello from phone" })

		// ---- 3. keys ------------------------------------------------------
		const key = async (
			opts: { key: string; code: string; vk: number; text?: string; modifiers?: number },
		) => {
			await cdp.send("Input.dispatchKeyEvent", {
				type: opts.text ? "keyDown" : "rawKeyDown",
				key: opts.key,
				code: opts.code,
				windowsVirtualKeyCode: opts.vk,
				nativeVirtualKeyCode: opts.vk,
				modifiers: opts.modifiers ?? 0,
				...(opts.text ? { text: opts.text, unmodifiedText: opts.text } : {}),
			})
			await cdp.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: opts.key,
				code: opts.code,
				windowsVirtualKeyCode: opts.vk,
				nativeVirtualKeyCode: opts.vk,
				modifiers: opts.modifiers ?? 0,
			})
		}

		await key({ key: "Backspace", code: "Backspace", vk: 8 })
		const afterBackspace = (await read()).value
		log("value after Backspace", afterBackspace)

		await key({ key: "!", code: "Digit1", vk: 49, text: "!", modifiers: 8 /* Shift */ })
		const afterChar = (await read()).value
		log("value after printable keyEvent '!'", afterChar)

		await key({ key: "Enter", code: "Enter", vk: 13, text: "\r" })
		await key({ key: "ArrowLeft", code: "ArrowLeft", vk: 37 })
		await key({ key: "Tab", code: "Tab", vk: 9 })
		const afterTab = (await read()).active
		log("activeElement after Tab", afterTab)

		// refocus and try Ctrl+A (modifiers bitmask: 2 = Ctrl, 8 = Shift, 1 = Alt, 4 = Meta)
		for (const type of ["mousePressed", "mouseReleased"] as const) {
			await cdp.send("Input.dispatchMouseEvent", {
				type,
				x: ix,
				y: iy,
				button: "left",
				buttons: type === "mousePressed" ? 1 : 0,
				clickCount: 1,
			})
		}
		await key({ key: "a", code: "KeyA", vk: 65, modifiers: 2 })
		await sleep(200)
		const afterCtrlA = await read()
		log("after Ctrl+A", { selLog: afterCtrlA.selLog, keyLog: afterCtrlA.keyLog })

		// ---- 4. touch (raw, no emulation) ---------------------------------
		const tb = await page.locator("#touchtarget").boundingBox()
		if (!tb) throw new Error("no touch box")
		const tx = tb.x + tb.width / 2
		const ty = tb.y + tb.height / 2
		let touchRawErr = ""
		try {
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ x: tx, y: ty, id: 1 }],
			})
			await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
		} catch (err) {
			touchRawErr = String(err)
		}
		await sleep(300)
		const afterTouchRaw = (await read()).touchLog
		log("touchLog (raw, no emulation)", { afterTouchRaw, touchRawErr })

		// ---- 5. touch with Emulation.setTouchEmulationEnabled ---------------
		let touchEmuErr = ""
		let maxTouchPointsAfter: number | string = "n/a"
		try {
			await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
			maxTouchPointsAfter = await page.evaluate(() => navigator.maxTouchPoints)
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ x: tx, y: ty, id: 2 }],
			})
			await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
		} catch (err) {
			touchEmuErr = String(err)
		}
		await sleep(300)
		const afterTouchEmu = (await read()).touchLog
		log("touchLog (with touch emulation)", { afterTouchEmu, maxTouchPointsAfter, touchEmuErr })
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {})

		// ---- 6. scroll via mouseWheel --------------------------------------
		const sb = await page.locator("#scrollbox").boundingBox()
		let scrollErr = ""
		if (sb) {
			try {
				await cdp.send("Input.dispatchMouseEvent", {
					type: "mouseWheel",
					x: sb.x + sb.width / 2,
					y: sb.y + sb.height / 2,
					button: "none",
					deltaX: 0,
					deltaY: 300,
				})
			} catch (err) {
				scrollErr = String(err)
			}
		}
		await sleep(400)
		const afterScroll = (await read()).scrollLog
		log("scrollLog after mouseWheel", { afterScroll, scrollErr })

		// ---- 7. final DOM snapshot ------------------------------------------
		const final = await read()
		log("FINAL DOM", final)

		// ---- 8. verdicts ------------------------------------------------------
		const mouseOk = Boolean(final.clickLog?.startsWith("CLICK"))
		const textOk = final.value?.includes("hello from phon")
		const keysOk = Boolean(
			afterBackspace === "hello from phon" &&
				afterChar === "hello from phon!" &&
				final.keyLog?.includes("DOWN:Enter") &&
				final.keyLog?.includes("DOWN:Backspace"),
		)
		const touchOk = Boolean(afterTouchRaw && afterTouchRaw !== "-")
		log("VERDICT", {
			MOUSE: mouseOk ? "yes" : "no",
			TEXT: textOk ? "yes" : "no",
			KEYS: keysOk ? "yes" : "no",
			TOUCH: touchOk ? "yes" : "no",
			SCROLL: afterScroll && afterScroll !== "-" ? "yes" : "no",
		})

		console.log("\n=== S3v2 RAW ===")
		console.log(JSON.stringify(results, null, 2))
	} finally {
		await browser.close().catch(() => {})
		await solari.close().catch(() => {})
	}
}

main().catch((err) => {
	console.error("[S3v2] FATAL", err)
	process.exit(1)
})
