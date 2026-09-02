# 03 — CDP input injection on a Solari cloud browser

**What was measured, and why.** The screencast is only half of a handoff; the
human's taps and keystrokes have to reach the page. This document establishes
that the return channel works on a Solari cloud browser, that injected events
carry `isTrusted: true`, and that the phone-to-page coordinate mapping is
exact. Measured 2026-09-01.

**Answer: yes, the full input return channel works.** Raw CDP
`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` /
`Input.dispatchTouchEvent` all reach the page on a Solari cloud browser, and the
page reacts exactly as it would to a real user. Nothing is stubbed, nothing is
filtered, no extra permission or flag is needed.

Every result below was verified by reading page state back (DOM text, input
values, URL after navigation) — never by "no error was thrown".

## Environment measured

| | |
|---|---|
| SDK | `@solarisdk/browser@0.1.2` (wraps `patchright-core@1.62.2`) |
| Browser | `HeadlessChrome/151.0.7922.34`, `X11; Linux x86_64` |
| Viewport | 1280 x 720 CSS px, `devicePixelRatio = 1` |
| `navigator.maxTouchPoints` | 0 (desktop fingerprint) |
| CDP session | `await page.context().newCDPSession(page)` — works, no restrictions found |

## Evidence

| Channel | Proof (read back from the page) |
|---|---|
| Mouse click | `CLICK x=170 y=160 trusted=true detail=1 btn=0` — handler ran, coords match exactly |
| Mouse on a real site | CDP click on `example.com` link → URL became `https://www.iana.org/help/example-domains` |
| Focus by click | `document.activeElement.id === "inp"` after a CDP press/release |
| `Input.insertText` | field value became `"hello from phone"` |
| Backspace | value `"hello from phone"` → `"hello from phon"` |
| Enter | `keydown` handler saw `DOWN:Enter/Enter/13/t=true`, and nothing was inserted into the field |
| Printable via key event | `!` with `text:"!"` produced `keydown` + `keypress` + inserted the char |
| Tab | focus moved to the next focusable element |
| Ctrl+A | `keydown` saw `KeyA+ctrl`, selection became `0-16`, and no `"a"` was typed |
| Touch | `touchstart` (1 point, correct clientX) + `touchend` + a synthesized compat `click`, all `isTrusted=true` |
| Wheel scroll | `deltaY: 300` → `scrollTop = 300` (1:1) |
| Coordinate math | Simulated phone tap on a 360px-wide view of a 640px downscaled frame of a page scrolled to y=800 → **0.000 px** mapping error, click landed |

Measured with three throwaway injection scripts plus a copy-paste-ready module
that typechecked and was verified live. They are not carried in the tree; the
repository history has them. The shipped implementation is `src/core/input.ts`.

---

## The exact working sequences

Coordinates are **CSS pixels relative to the top-left of the layout viewport** —
the same space as `boundingBox()` and `getBoundingClientRect()`. No DPR
multiplication, no scroll offset addition.

```ts
const cdp = await page.context().newCDPSession(page)
```

### Click

`clickCount: 1` and the `buttons` bitmask are both required. With
`clickCount: 0` Chromium dispatches mousedown/mouseup but **no `click` event**.
The leading `mouseMoved` is optional for the click itself but needed for hover
menus and tooltips.

```ts
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved",    x, y, button: "none", buttons: 0 })
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed",  x, y, button: "left", buttons: 1, clickCount: 1 })
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 })
```

Right click: `button: "right", buttons: 2`. Double click: send the triple twice,
second one with `clickCount: 2`.

### Scroll

```ts
await cdp.send("Input.dispatchMouseEvent", {
  type: "mouseWheel", x, y, button: "none", deltaX: 0, deltaY: 300,
})
```

### Drag (for sliders and drag-puzzle captchas)

```ts
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 })
for (let i = 1; i <= steps; i++) {              // intermediate moves matter:
  const t = i / steps                            // a single jump looks synthetic
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: x0 + (x1 - x0) * t,
    y: y0 + (y1 - y0) * t,
    button: "left", buttons: 1,
  })
}
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1 })
```

### Text — two modes, and the choice matters

**Fast path.** Fires `beforeinput` and `input` (so React controlled inputs
update), but **no `keydown` / `keypress`**. Verified: typing `"123456"` via
`insertText` left the page's `keydown` log completely empty.

```ts
// click the field first — insertText goes to the focused element
await cdp.send("Input.insertText", { text: "hello from phone" })
```

**Compatible path.** One triple per character, produces real key events.

```ts
for (const ch of text) {
  const vk = ch.toUpperCase().charCodeAt(0)
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: ch, text: ch, unmodifiedText: ch,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  })
}
```

### Special keys

`rawKeyDown` for non-printables, `keyDown` **plus `text`** for printables.
Getting this backwards is the classic bug: `rawKeyDown` with no `text` fires
`keydown` but inserts nothing, so `pressKey("a")` silently types nothing.

```ts
// Backspace / Enter / Escape / arrows / Tab — no text field
await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp",      key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })

// Enter: text "\r" gives a keypress and does NOT insert a character
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" })
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp",   key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
```

Verified key codes: Enter 13, Backspace 8, Delete 46, Tab 9, Escape 27,
ArrowUp 38, ArrowDown 40, ArrowLeft 37, ArrowRight 39, Home 36, End 35,
PageUp 33, PageDown 34, Space 32.

### Modifiers

Bitmask on every `Input.*` call: `Alt = 1, Ctrl = 2, Meta = 4, Shift = 8`.
Combine with `|`.

```ts
// Ctrl+A — use rawKeyDown, or the "a" gets typed into the field
await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp",      key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
```

Rule: a modifier other than Shift suppresses `text`. Verified — with the rule
applied, `Ctrl+A` selected `0-16` and the value stayed `"12345"`.

### Touch

```ts
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] })
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd",   touchPoints: [] })
```

`touchEnd` takes an **empty** `touchPoints` array (the released points). Works
without `Emulation.setTouchEmulationEnabled` and even though
`navigator.maxTouchPoints === 0`; Chromium also synthesizes the compat `click`.

---

## Recommendation for the phone UI: send mouse events, not touch events

Use `Input.dispatchMouseEvent` as the transport for taps. Reasons, in order:

1. **The page fingerprint stays desktop.** `Emulation.setTouchEmulationEnabled`
   sets `navigator.maxTouchPoints` to 5 (verified) while the UA stays
   `X11; Linux x86_64` — a desktop UA with touch support is exactly the kind of
   inconsistency bot detection looks for. Solari sells stealth; do not spend it
   on a feature the user does not see.
2. **The agent's own automation uses mouse events.** Mixing input models mid-session
   is another inconsistency, and it changes how hover-dependent UI behaves.
3. **Raw touch already produces a compat `click`**, so there is no capability gained.
4. Sites that render a mobile layout only when touch is present would suddenly
   reflow mid-handoff, invalidating the coordinates the human just aimed at.

Translate on the client: `touchstart` → `mouseMoved` + `mousePressed`,
`touchend` → `mouseReleased`, `touchmove` while held → `mouseMoved` with
`buttons: 1`, and a two-finger or scroll gesture → `mouseWheel`.

Keep `dispatchTouchEvent` behind an opt-in flag (`{ input: "touch" }`) for the
two cases it is genuinely needed: multi-touch gestures (pinch-zoom) and sites
that are broken without real touch events. It is verified working, so the flag
is cheap.

---

## Coordinate conversion — frame pixels to CDP coordinates

The phone UI shows a JPEG from `Page.screencastFrame`, scaled to fit the phone
screen. Three coordinate spaces are involved:

1. **Display px** — inside the `<img>` element on the phone.
2. **Frame px** — the true pixel size of the decoded JPEG. Chromium clamps this
   to the requested `maxWidth`/`maxHeight`, so **measure it, do not assume it**
   (`img.naturalWidth`, or read it out of the JPEG/PNG header server-side).
3. **CSS viewport px** — what `Input.dispatchMouseEvent` wants.

Each `Page.screencastFrame` carries the metadata needed to bridge 2 → 3:

```jsonc
{ "offsetTop": 0, "pageScaleFactor": 1, "deviceWidth": 1280, "deviceHeight": 720,
  "scrollOffsetX": 0, "scrollOffsetY": 800, "timestamp": 1788238079.27949 }
```

### The formula

```ts
// 1. display px -> frame px
const fx = tapX * frameWidth  / displayWidth
const fy = tapY * frameHeight / displayHeight

// 2. frame px -> CSS viewport px
const k     = frameWidth / meta.deviceWidth        // downscale factor Chromium applied
const scale = k * (meta.pageScaleFactor || 1)      // pinch zoom, 1 on desktop

const x = fx / scale
const y = (fy - meta.offsetTop * k) / scale

// 3. send {x, y} straight to Input.dispatchMouseEvent
```

This is `frameToPage()` in `src/core/input.ts`.

**Verified end-to-end:** page scrolled to `scrollY = 800`, screencast requested
at `maxWidth: 640` (so `k = 0.5`), frame displayed at 360 px wide. A tap
computed for the centre of a button mapped back to `{x: 300, y: 145}` against a
ground truth of `{x: 300, y: 145}` — **0.000 px error** — and the click landed
(`YES@300,145`).

### Two things NOT in the formula

- **Do not add `scrollOffsetX/Y`.** CDP input coordinates are viewport-relative,
  and the screencast frame already shows the scrolled viewport. Adding the
  offset was the single most likely bug here; it is why the verification runs
  with an 800 px scroll.
- **Do not multiply by `devicePixelRatio`.** CDP `Input.*` takes CSS pixels.
  Measured DPR was 1 anyway, but the frame is in device pixels, and `k` already
  absorbs any DPR the frame carries because it is derived from `deviceWidth`.

The one field that does move the origin is `offsetTop` (mobile top-controls
inset). It was 0 in every frame measured, but subtract it — it costs nothing.

`scrollOffsetX/Y` still has a use: send it to the phone UI so it can show a
scroll indicator, and use a change in it to invalidate any stale tap that was
queued before a scroll.

---

## Stolperfallen

**1. `page.evaluate` runs in an isolated world.** This cost the first run.
Patchright (the stealth fork Solari ships) evaluates in an isolated
`ExecutionContext`, so `window.__anything` set by a page's own inline `<script>`
is `undefined` from `page.evaluate`, while the DOM is shared and fully visible.

```
mainWorldMarker: "UNDEFINED"     // set by an inline <script> on the page
domReadable:     "set-by-inline-script"  // same script wrote this to the DOM
```

Consequences for handraise:
- Verify injected input through the **DOM** (`textContent`, `input.value`,
  `page.url()`), never through page globals. The v1 run reported `KEYS=no` /
  `TOUCH=no` purely because of this — the events had actually worked.
- Any main-world hook (a `window.__handraise` bridge, monkey-patching `fetch`)
  will not be reachable from `page.evaluate`. Use `Runtime.evaluate` over CDP
  with the main-world execution context, or `Runtime.addBinding`, if a bridge
  is ever needed.
- Do not build a "did the human's click work?" check on `window` state.

**2. `insertText` fires no key events.** It emits `beforeinput`/`input` only.
That is enough for React and for most login forms, but it silently breaks:
split 6-box OTP inputs that auto-advance on `keydown`, keystroke-throttled
search, and some masked/formatted inputs. The 2FA code entry is handraise's
headline use case, so **default the human's typed text to the per-character
`keyDown` path** and offer `insertText` as a `{ fast: true }` option for long
strings such as pasted passwords.

**3. `rawKeyDown` vs `keyDown` + `text`.** Non-printables need `rawKeyDown`
without `text`; printables need `keyDown` **with** `text`. A `rawKeyDown` for
`"a"` fires `keydown` and inserts nothing — the classic "my typing does nothing"
bug. And a modifier other than Shift must suppress `text`, or `Ctrl+A` types an
`a` into the field.

**4. `clickCount` must be ≥ 1.** With `clickCount: 0` the `click` event never
fires, only `mousedown`/`mouseup`. Plenty of buttons work anyway; plenty do not.

**5. Every injected click moves focus.** A tap on a non-focusable element blurs
the field the human was typing into. Observed in the v2 run: after tapping a
plain `<div>`, `document.activeElement` was `<body>` again. If the UI has a
separate text-entry box, re-click the target field before sending its text —
do not assume focus survived.

**6. `touchEnd` takes an empty `touchPoints` array**, not the released point.
Passing the point is a silent no-op in some Chromium versions.

**7. One CDP session per page.** `newCDPSession(page)` is bound to that page.
2FA flows love popups and new tabs — hook `context.on("page", ...)` and create a
fresh session, or the human's taps go to a page nobody is looking at.

**8. `solari.close()` is mandatory**, after `browser.close()`, or the process
hangs. Both in a `finally`.

**9. Send events with a small gap.** All of the above was sent back-to-back with
no delay and worked, but a human's taps arriving as one burst after a network
stall will land at coordinates that were valid several frames ago. Timestamp
taps on the client and drop any tap whose frame's `scrollOffsetY` no longer
matches the current one.

**10. `isTrusted` is `true` on everything injected.** Verified on click, keydown,
keypress, touchstart, touchend and the compat click. Sites that reject synthetic
`dispatchEvent()` input will accept this. Worth stating in the README — it is
the reason handraise can solve a captcha where an in-page script cannot.

---

## What is still open

- **Latency.** Not measured here. Round-trip tap → screencast frame showing the
  result is the number that decides whether the phone UI feels usable. It is
  measured end-to-end in [`benchmarks/`](../../benchmarks/README.md).
- **Concurrency.** Whether the agent's Playwright actions and the human's CDP
  input can interleave safely, or whether the agent must be parked while a
  handoff is open. Recommend parking it — the human's mental model is "I have
  the wheel now".
- **File upload.** `DOM.setFileInputFiles` was not tested. A human on a phone
  may need to upload an ID photo. A separate experiment if the use case needs it.
