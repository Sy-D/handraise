/**
 * S3 reference implementation — input return channel for handraise.
 *
 * Every sequence in here was verified against a live Solari cloud browser
 * (Chromium 151 headless, viewport 1280x720, DPR 1) by reading page state
 * back through the DOM. See spikes/s3-report.md.
 *
 * Coordinates in/out of this module are CSS pixels relative to the top-left
 * of the layout viewport — the same space as Playwright's boundingBox() and
 * the DOM's getBoundingClientRect(). Convert frame pixels first (see
 * frameToViewport below).
 */

/** Minimal structural type — avoids importing patchright types. */
export type CDPLike = {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>
}

/** CDP modifier bitmask. Combine with `|`. */
export const Mod = { None: 0, Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const

export type Point = { x: number; y: number }

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

export async function click(
	cdp: CDPLike,
	{ x, y }: Point,
	opts: { button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: number } = {},
): Promise<void> {
	const button = opts.button ?? "left"
	const clickCount = opts.clickCount ?? 1
	const modifiers = opts.modifiers ?? 0
	const buttons = button === "left" ? 1 : button === "right" ? 2 : 4

	// hover first: many menus/tooltips only open on mouseover
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x,
		y,
		button: "none",
		buttons: 0,
		modifiers,
	})
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x,
		y,
		button,
		buttons,
		clickCount,
		modifiers,
	})
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x,
		y,
		button,
		buttons: 0,
		clickCount,
		modifiers,
	})
}

export async function move(cdp: CDPLike, { x, y }: Point, held = false): Promise<void> {
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x,
		y,
		button: held ? "left" : "none",
		buttons: held ? 1 : 0,
	})
}

/** Drag: press at `from`, move through `steps` intermediate points, release at `to`. */
export async function drag(cdp: CDPLike, from: Point, to: Point, steps = 12): Promise<void> {
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: from.x,
		y: from.y,
		button: "left",
		buttons: 1,
		clickCount: 1,
	})
	for (let i = 1; i <= steps; i++) {
		const t = i / steps
		await move(cdp, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, true)
	}
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: to.x,
		y: to.y,
		button: "left",
		buttons: 0,
		clickCount: 1,
	})
}

/** Scroll. deltaY maps 1:1 to scrollTop pixels (verified: 300 -> top=300). */
export async function scroll(cdp: CDPLike, at: Point, delta: { x?: number; y?: number }): Promise<void> {
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseWheel",
		x: at.x,
		y: at.y,
		button: "none",
		deltaX: delta.x ?? 0,
		deltaY: delta.y ?? 0,
	})
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Fast path. Fires beforeinput/input (React-safe) but NO keydown/keypress.
 * Use `typeText` instead for fields whose JS listens on keydown
 * (split OTP boxes, keystroke-throttled search, some masked inputs).
 */
export async function insertText(cdp: CDPLike, text: string): Promise<void> {
	await cdp.send("Input.insertText", { text })
}

/** Slow path. One keyDown/char/keyUp triple per character — full key events. */
export async function typeText(cdp: CDPLike, text: string, delayMs = 0): Promise<void> {
	for (const ch of text) {
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: ch,
			text: ch,
			unmodifiedText: ch,
			windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
			nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
		})
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: ch,
			windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
			nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
		})
		if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
	}
}

// ---------------------------------------------------------------------------
// Special keys
// ---------------------------------------------------------------------------

/** key -> [code, windowsVirtualKeyCode, text?] . text present = printable. */
export const KEYS: Record<string, [string, number, string?]> = {
	Enter: ["Enter", 13, "\r"],
	Backspace: ["Backspace", 8],
	Delete: ["Delete", 46],
	Tab: ["Tab", 9],
	Escape: ["Escape", 27],
	ArrowUp: ["ArrowUp", 38],
	ArrowDown: ["ArrowDown", 40],
	ArrowLeft: ["ArrowLeft", 37],
	ArrowRight: ["ArrowRight", 39],
	Home: ["Home", 36],
	End: ["End", 35],
	PageUp: ["PageUp", 33],
	PageDown: ["PageDown", 34],
	" ": ["Space", 32, " "],
	a: ["KeyA", 65, "a"],
}

export async function pressKey(cdp: CDPLike, name: string, modifiers = 0): Promise<void> {
	const entry = KEYS[name]
	if (!entry) throw new Error(`unknown key: ${name}`)
	const [code, vk, text] = entry
	// A modifier other than Shift suppresses text insertion (Ctrl+A must not type "a").
	const printable = text !== undefined && (modifiers === 0 || modifiers === Mod.Shift)
	await cdp.send("Input.dispatchKeyEvent", {
		type: printable ? "keyDown" : "rawKeyDown",
		key: name,
		code,
		windowsVirtualKeyCode: vk,
		nativeVirtualKeyCode: vk,
		modifiers,
		...(printable ? { text, unmodifiedText: text } : {}),
	})
	await cdp.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: name,
		code,
		windowsVirtualKeyCode: vk,
		nativeVirtualKeyCode: vk,
		modifiers,
	})
}

// ---------------------------------------------------------------------------
// Touch (optional — mouse is the recommended transport, see report)
// ---------------------------------------------------------------------------

export async function tap(cdp: CDPLike, { x, y }: Point): Promise<void> {
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] })
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}

// ---------------------------------------------------------------------------
// Coordinate mapping — frame pixels -> CSS viewport pixels
// ---------------------------------------------------------------------------

/** Metadata carried by every Page.screencastFrame event. */
export type ScreencastMetadata = {
	offsetTop: number
	pageScaleFactor: number
	deviceWidth: number
	deviceHeight: number
	scrollOffsetX: number
	scrollOffsetY: number
	timestamp: number
}

/**
 * Map a tap in the phone UI to CDP input coordinates.
 *
 * @param tap    coordinates inside the displayed <img>/<canvas>, relative to
 *               its top-left, in the element's own CSS pixels
 * @param display  the rendered size of that element (getBoundingClientRect)
 * @param frame    the true pixel size of the decoded screencast image
 * @param meta     the metadata of the frame that is on screen
 *
 * Do NOT add scrollOffset: CDP Input coordinates are viewport-relative, and
 * the screencast frame already shows the scrolled viewport.
 * Do NOT multiply by devicePixelRatio: CDP Input takes CSS pixels.
 */
export function frameToViewport(
	tap: Point,
	display: { width: number; height: number },
	frame: { width: number; height: number },
	meta: Pick<ScreencastMetadata, "deviceWidth" | "deviceHeight" | "offsetTop" | "pageScaleFactor">,
): Point {
	// 1. displayed element pixels -> frame image pixels
	const fx = (tap.x * frame.width) / display.width
	const fy = (tap.y * frame.height) / display.height

	// 2. frame image pixels -> CSS viewport pixels.
	//    Chromium clamps the frame to maxWidth/maxHeight, so derive the factor
	//    from the actual image instead of trusting the requested max.
	const k = frame.width / meta.deviceWidth
	const scale = k * (meta.pageScaleFactor || 1)

	return {
		x: fx / scale,
		y: (fy - meta.offsetTop * k) / scale,
	}
}
