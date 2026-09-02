# Phone UX 0.3.0 — Block 2

Blocks A–D of the phone-UX increment, on top of Block 1 (commit `c573b8d`).
This is the half that fixes the audit's headline finding: the human could not
read the page they were being asked to operate.

Files touched: `src/relay/guest/server.js` (source of truth) and its generated
`src/relay/guest-source.ts`, `src/relay/protocol.ts`, `src/core/focus.ts`,
`src/core/focus.test.ts`, `e2e/ui.spec.ts`. Nothing else. Not committed.

---

## A — auto-zoom, pinch and double tap (audit M1)

### What was wrong

At 390×844 a 1280×800 frame was letterboxed into 370×231 — a 28.9% scale, with
14px remote body text landing at ~4 CSS px. Everything Block 1 fixed was craft
applied around an image nobody could read.

### The two boxes

```html
<main id="stage">
  <div id="frame">          <!-- never transformed; clips at the content edge -->
    <div id="zoom">         <!-- transform: translate() scale(); origin 0 0 -->
      <canvas id="view">
      <div id="focus-ring">
```

Both are load-bearing:

- **`#frame` is never transformed**, so `getBoundingClientRect()` on it is the
  honest layout size *even while a zoom is mid-animation*. Measuring the canvas
  instead would hand `render()` the rectangle the transition is currently
  passing through, and the letterbox would breathe with the animation. It also
  does the clipping, at the stage's content edge rather than its padding edge.
- **`#zoom` carries the transform**, with `transform-origin: 0 0`, which is what
  makes the inverse every tap needs a subtraction and a division and nothing
  else — no origin term, no separate pan term.

### The coordinate formula

Forward, page → screen:

```
k          = (jpegW / deviceW) · pageScaleFactor · (box.w / frameW)   [page px → canvas CSS px]
canvas px  = box.x + rect.x · k                                       [letterbox offset]
screen px  = frameOrigin + t + canvasPx · scale                       [the transform]
```

Inverse, the one `toFrame()` runs on every tap:

```
local.x = (clientX − zoomRect.left) / scale        ← zoomRect is the TRANSFORMED rect,
fx      = (local.x − box.x) · frameW / box.w          so its left edge IS the image of
                                                       canvas-local zero: t is already in it
```

That is the whole change to the tap path: two lines. At `scale = 1, t = 0` it is
byte-for-byte the old behaviour, which is why the existing pixel-exact tap test
was left untouched and still passes.

**Focus ring: inside `#zoom`.** It has to track a rectangle *on the remote page*,
so it must scale and pan with the frame. Putting it in the transformed wrapper
means one transform instead of a second set of maths that can disagree with the
first — `placeRing()` lost the `here.left − host.left` term entirely and now
writes canvas-local coordinates. Its stroke divides the zoom back out
(`border: calc(2px / var(--zoom))`), so a 2px ring is 2px at 3× rather than a
6px slab over the field it is meant to outline.

**Tap ripple: stays in `#stage`, at the finger.** It marks *the finger*, not a
place on the remote page, so it must not scale — at 3× it would be an 84px blob.
It is positioned from `clientX/clientY` against the stage, so it lands under the
finger at any zoom for free. This is the one place where "must zoom with the
canvas" would have been the wrong answer.

**Scroll drag divides by the zoom** (`fdy = −stepped · frameH / (box.h · scale)`),
or a magnified page would scroll magnified too.

### What the zoom is aimed at

```js
readable = READABLE_FIELD_PX / (rect.height · k)      // 44 CSS px of field height
fits     = (view.w · 0.92)   / (rect.width  · k)      // a thumb of margin either side
scale    = min( max(readable, 1), max(fits, 1), 3 )
tx, ty   = clampPan( centre the field at (0.5·W, 0.42·H) )
```

- **`FOCUS_ANCHOR_Y = 0.42`**, not 0.5: what sits below a field is the button
  that submits it, and the human needs to see it.
- **`MAX_ZOOM = 3`.** Past that the JPEG has no more detail to magnify, only
  artefacts.
- **`clampPan(t, size, scale) = min(0, max(size − size·scale, t))`** keeps the
  frame covering the viewport. At fit there is nowhere to pan, so it collapses
  to `t = 0` and the letterbox cannot be dragged off screen.

**Honest arithmetic on the 44px target.** The width term binds whenever the
field's aspect ratio exceeds `view.w · 0.92 / 44 ≈ 7.7`. The Acme mock's field
is 520 × 44 (ratio 11.8), so it zooms to **2.26×** and lands 28.8 CSS px tall,
not 44. A 300 × 44 field (ratio 6.8) gets the full readability zoom. This is
arithmetic, not a bug: a 520px field cannot be both fully on a 370px screen and
have 44px rows. Measured effect on the mock: remote 16px text goes from 4.6 to
**10.4 CSS px**, and 24px headings from 6.9 to 15.6. See the screenshot.

**Sharpness.** A CSS transform scales the canvas's *rasterised bitmap*, so a
dpr-sized backing store magnified 3× is the JPEG squeezed down to the canvas and
then blown back up — the field gets big and stays unreadable, which would have
missed the entire point. `backingScale()` draws at the zoom instead, capped at
the JPEG's own resolution (`frameW / (box.w · dpr)`) so the backing store lands
exactly on the source pixels and never past them, and at `MAX_ZOOM` so it cannot
grow without bound on a phone.

### Gestures, and the conflict

| Fingers | Gesture |
|---|---|
| 1, still | tap → `{type:"tap"}` + ripple, as before |
| 1, moving ≥10px | scroll drag, as before, divided by the zoom |
| 2 | pinch zoom **and** pan — the midpoint between the fingers stays under them |
| 1, twice within 250ms and 20px | toggle zoom: fit ↔ 2.5× centred on the tap |

**The single tap is never delayed.** The first tap leaves immediately. A second
tap inside the window sends *nothing* and toggles the zoom instead.

The alternative — hold the first tap for 250ms to find out whether a second is
coming — puts a delay on the one action this whole page exists for, on a screen
whose entire job is "operate this form for me". A tap that arrives late on a
login form is worse than having no zoom gesture at all. The cost of the choice
is one extra tap delivered to the remote page per double tap, and it lands
exactly where the human was already tapping — the same place their first tap
went, which they intended.

Small pieces, so the Biome complexity ratchet on `server.js` stays at **59**
(unchanged, not raised): `pinchSpan`, `beginPinch`, `updatePinch`, `dragScroll`,
`isDoubleTap`, `toggleZoom`, `applyTransform`, `clampZoom`, `clampPan`,
`setView`, `centreOn`, `reclamp`, `settleView`, `backingScale`, `frameScale`.

`settleView()` is the one that is easy to miss: a finger landing during a running
zoom transition freezes the transform where it is (read back with
`DOMMatrixReadOnly`), so the pinch maths never compares a mid-animation rectangle
against the transition's final value. Without it the frame jumps under the
fingers.

### When the focus goes away

**The zoom is kept.** Snapping back to 29% would undo the one thing the human
asked for and lose their place on a page they are working through field by
field. They zoom out with a double tap, when they mean to. A repeated focus for
the *same* rect is also ignored (`zoomedTo`), because the agent re-probes after
every keystroke and the view must not fight a human who has since pinched
elsewhere.

Motion: 180ms `cubic-bezier(0.23, 1, 0.32, 1)` on the eased moves only. A pinch
has no transition at all — it follows the fingers. `prefers-reduced-motion`
drops the transition and keeps the zoom: the zoom is the only way the page can
be read, so it arrives instead of travelling.

---

## B — input made while the socket is down (audit M3)

`send()` used to be `if (ws && ws.readyState === 1) ws.send(...)`. Everything
typed or tapped during a reconnect fell off the end of that line with no trace —
and the human, seeing nothing happen, assumes the *remote page* ignored them and
retypes, which is a double submit on a login form.

- Queue depth **50** (a long password), oldest dropped when full.
- The hint says so, always: **"Reconnecting — your input is queued"**, or
  **"Reconnecting — queue full, the oldest input was dropped"** once something
  has actually been lost. Restored to the normal hint on reconnect.
- `ping` is never queued: a heartbeat is only worth anything now.
- **In order, at most once.** The queue is taken before the first send, so a
  socket that dies halfway through cannot replay what already left. A duplicated
  Backspace deletes a character the human never asked to lose; a dropped one is
  a character they can see is missing and retype.

One thing this exposed and fixed: **a give-up made while the socket was down used
to be lost too**, and the agent would then burn its whole five-minute timeout
waiting for a human who had already answered. `finish()` now closes the socket
only when the outbox is empty, and `connect()` / `scheduleReconnect()` /
`visibilitychange` stay alive while `stillSending()` — the reconnect exists for
exactly that flush, and `onopen` closes the socket again once it is done.

Verified end to end in the screenshot run: socket displaced, `7726` typed, socket
restored, agent received `417726` (the `41` from before the outage plus the four
queued digits, in order, once each).

---

## C — one-time-code and password autofill (audit S7)

**Protocol** (`src/relay/protocol.ts`): `focus` gains an optional
`kind?: "otp" | "password" | "text"`. Optional, so an older agent still speaks
this protocol and a phone that receives no `kind` falls back to `"text"` — which
is exactly how every field behaved before the field existed.

Three values and not the audit's five: the phone's keyboard has exactly three
behaviours to choose between, and a kind nothing acts on is a kind that goes
stale. `FocusProbe` carries it, and `raise-hand.ts` already spreads the probe
onto the wire (`{ type: "focus", ...focus }`), so nothing there had to change.

**Derivation** (`src/core/focus.ts`, attributes only, never the value):

| Test | Kind |
|---|---|
| `type="password"` | `password` |
| `autocomplete` contains `one-time-code` | `otp` |
| `inputmode="numeric"` and `maxlength` 4–8 | `otp` |
| `name` / `id` / `aria-label` / label text matches `/otp\|one.?time\|verification\|2fa\|totp\|code/i` | `otp` |
| otherwise | `text` |

`type` is checked first **and alone**: a field called `passcode` that takes a
password is a password. Getting that order wrong would put a secret into a
numeric keypad and offer to autofill it from Messages.

**The phone** dresses its own field to match:

| kind | type | inputmode | autocomplete |
|---|---|---|---|
| otp | text | numeric | `one-time-code` |
| password | password | text | off |
| text | text | text | off |

No `pattern` on the OTP case — plenty of one-time codes are alphanumeric, and a
digits-only pattern would silently swallow the letters. Characters still stream
out one at a time under `type="password"`; the mirror keeps working, it just
stops being legible over a shoulder in an office. Changing the kind calls
`resetMirror()`: a different field is a different context, and without it the
Backspace diff would run the next keystroke against what was typed into the last
one (audit S6, fixed here as a side effect).

---

## D — the field gets its own row (audit M6)

`.bar` became a column: field on its own full-width row, the four keys on theirs.
The three safe keys are `flex: 1 1 0`, Clear keeps its 18px gutter and its
`flex: 0 0 auto`.

| | 390px before | 390px now | 320px before | 320px now |
|---|---|---|---|---|
| `#kbd` width | 131.4 | **358.0** | 69.4 | **296.0** |
| `#key-back` | 44 × 48.4 | **90.5 × 44** | 44 × 48.4 | **69.8 × 44** |
| `#key-clear` | — | 50.6 × 44 | — | 50.6 × 44 |
| ⏎ → Clear gap | 24.0 | 24.0 | 24.0 | 24.0 |
| ⌫ → Clear gap | 124 | 216.9 | 124 | 175.6 |
| footer | 152.9 | 204.9 | 152.9 | 204.9 |
| stage | 628.7 | 576.7 | 352.7 | 300.7 |

At 320px the field went from about four visible characters to about eighteen.
The footer cost 52px; the stage was wasting 414 of them, and the zoom is what
gives them back.

The focus-preservation logic in `keyButton()` was not touched. The e2e
`the key bar stays on one line on a narrow phone` became
`the field owns its row and the key bar stays on one line` — it still asserts the
key bar is a single line (all four keys within 1px of the same y, `.keys` height
under 1.5 keys) and that every key clears 44 on both axes, and it now also
asserts the keys sit *below* the field and that the stage still has 200px+ left.

---

## Verification

### Red before green

Four assertions watched failing. The first two ran against the unmodified page
(`git stash push -- src/relay/guest/server.js`); the last two against the new
page with one line surgically broken, because "the element does not exist yet"
is a weaker proof than a wrong number.

**1. `kind` derivation** — against `focus.ts` before the derivation existed:

```
159 |   expect(await kindOf(`<input id="field" type="password" name="passcode">`)).toBe("password")
error: expect(received).toBe(expected)
Expected: "password"    Received: undefined
(fail) a password field is a password even when it is named like a code

166 |   expect(await kindOf(`<input id="field" autocomplete="one-time-code">`)).toBe("otp")
Expected: "otp"         Received: undefined
(fail) a one-time-code field is recognised by autocomplete, shape or name

 5 pass    7 fail
```

**2. Reconnect queue** — against the old `send()`:

```
701 |   expect(await page.locator("#hint").textContent()).toBe(QUEUE_HINT)
error: expect(received).toBe(expected)
Expected: "Reconnecting — your input is queued"
Received: "Typing goes straight to the browser"
(fail) input made while the socket is down is queued, then sent once in order
```

and against the old `#kbd`:

```
736 |   expect(await kbd.getAttribute("autocomplete")).toBe("one-time-code")
Expected: "one-time-code"    Received: "off"
(fail) the local field dresses itself as the remote one: OTP, then password
```

**3. Reconnect queue *order*** — `flushOutbox()` temporarily iterating backwards:

```
717 |   expect(typed).toEqual(["a", "b", "c"])
error: expect(received).toEqual(expected)
  [ -"a", -"b", "c", +"b", +"a" ]
(fail) input made while the socket is down is queued, then sent once in order
```

**4. Zoom coordinate maths** — two separate breakages of the new page.

`zoomToFocus()` returning before `centreOn()` (the auto-zoom never fires):

```
618 |   expect(Math.abs(live.scale - want.scale)).toBeLessThanOrEqual(0.01)
Expected: <= 0.01    Received: 2          ← live 1×, hand-computed want 3×
(fail) the focused field is zoomed to and a tap on it still lands exactly
```

`toLocal()` dividing by a constant 2 instead of by `view.scale`:

```
644 |   expect(Math.abs(message.fx - expectedFx)).toBeLessThanOrEqual(1)
Expected: <= 1       Received: 53
(fail) the focused field is zoomed to and a tap on it still lands exactly
```

The 53 is the point: a tap under a wrong zoom lands 53 frame pixels away, which
on a real login form is a different control.

### Gates

All run from the repo root after the last change.

```
$ bun scripts/embed-guest.ts --check
guest-source.ts is in sync with guest/server.js
exit=0

$ ./node_modules/.bin/tsc --noEmit
exit=0                                    (no output)

$ ./node_modules/.bin/oxlint
exit=0                                    (no output, 0 warnings)

$ ./node_modules/.bin/biome check .
Checked 48 files in 96ms. No fixes applied.
Found 2 infos.
exit=0
  — both infos are the pre-existing biome.json schema-version and
    "recommended is deprecated" notices, not findings on this change.
    The server.js complexity ratchet stays at 59; biome.json is untouched.

$ bun run test
 153 pass
 0 fail
 506 expect() calls
Ran 153 tests across 12 files. [16.74s]
exit=0
```

146 → 153: three new in `src/core/focus.test.ts`, four new in `e2e/ui.spec.ts`
(20 → 24). `git status --short` shows exactly six modified files and nothing
committed:

```
 M e2e/ui.spec.ts
 M src/core/focus.test.ts
 M src/core/focus.ts
 M src/relay/guest-source.ts
 M src/relay/guest/server.js
 M src/relay/protocol.ts
```

### New tests

`src/core/focus.test.ts` (real Chromium, no Solari):

1. `a password field is a password even when it is named like a code`
2. `a one-time-code field is recognised by autocomplete, shape or name` — all
   four routes to `otp`
3. `an ordinary field is text, and a long numeric field is not an OTP` — the
   16-digit card number that must not become an OTP

`e2e/ui.spec.ts` (real Chromium, real relay, no Solari):

4. `the focused field is zoomed to and a tap on it still lands exactly` — the
   expected transform is computed in the test from `FOCUS_RECT` and `META` the
   long way round, asserted against the live `DOMMatrixReadOnly`, and then the
   tap is inverted by hand from *that* transform and compared to the wire
   message within 1 frame pixel. The test also guards that the hand-computed
   point falls inside the frame, so the assertion cannot be vacuous.
5. `a double tap toggles the zoom and sends only the first tap` — exactly one
   `tap` on the wire, scale 2.5, and a second double tap back to exactly
   `scale 1, t = 0`.
6. `input made while the socket is down is queued, then sent once in order`
7. `the local field dresses itself as the remote one: OTP, then password` —
   including that the mirror is emptied on the switch and that typing still
   streams afterwards.

Changed: `expectedRing()` now folds the auto-zoom transform in and measures from
`#frame`; the narrow-phone layout test was rewritten for D. Every test still
asserts `consoleErrors` is empty.

---

## Screenshots

390 × 844, `deviceScaleFactor: 3`, real relay, a rendered 1280 × 800 "Acme Bank
two-factor" page as the frame. The focused field on that page is 520 × 44 at
(380, 294).

| File | State |
|---|---|
| `/tmp/hr-ui-after/block2-1-autozoom.png` | Auto-zoom on the focus. **2.26×**, ring on the code field, the whole card readable. |
| `/tmp/hr-ui-after/block2-2-pinched.png` | Two-finger pinch to **3×** (CDP `Input.dispatchTouchEvent`), the heading at 15.6 CSS px. |
| `/tmp/hr-ui-after/block2-3-reconnect-queue.png` | Socket down, `417726` in the mirror, hint reads "Reconnecting — your input is queued". |
| `/tmp/hr-ui-after/block2-4-otp-field.png` | `#kbd` as `type=text inputmode=numeric autocomplete=one-time-code pattern=null`, bar named "Typing into: Verification code". |

Measured from the live DOM during that run:

```
auto-zoom transform   scale 2.26462, tx -234, ty -327
focus ring on screen  340.4 x 28.8 at (24.8, 304.0)
pinch transform       scale 3, tx -370, ty -520
kbd attributes        type=text inputmode=numeric autocomplete=one-time-code pattern=null
agent received        417726
```

Compare with the audit's measurement of the same situation: 28.9% scale, ~4 CSS
px of glyph, 66% of the stage black.

---

## Open

**Caused here**

- **A queued tap is replayed against a page that may have moved on.** The
  remote page is frozen while nobody is driving it, and reconnects are typically
  under a second, so this is a small risk — but it is a real one and it is the
  reason the audit's own M3 proposed *refusing* input instead. Queuing was the
  instructed choice and it is the better one for keystrokes; if a stale tap ever
  bites, the fix is to drop `tap` and `scroll` from the queue and keep `char`,
  `key`, `clear` and the terminal messages.
- **The 44px readability target is not reached for wide fields** (aspect ratio
  over ~7.7), which includes most full-width form inputs. 2.26× on the mock
  instead of the 3.46× readability wanted. Raising `MAX_ZOOM` would not help —
  the width cap binds first. The only real fix is to zoom past the field's own
  width and accept horizontal panning, which is a judgement call worth making
  with a real device in hand.
- **`main[data-offline]` dimming was not added.** The audit's M3 wanted the
  canvas dimmed and greyscaled while the socket is down; the hint carries the
  message instead. Cheap to add later, and it changes no coordinates.
- The overlay path (`finish()`) now leaves the socket open until the outbox
  drains. If the relay never comes back, the page keeps retrying with the 8s
  backoff cap behind a terminal overlay. Harmless — the human has closed the tab
  — but it is a behaviour that did not exist before.

**Still open from the audit, untouched**

- S11 (`touchend` fires with no hit test, so a finger that slides off ⌫ still
  deletes), S13 (the invisible 5-minute deadline, explicitly excluded),
  N1–N8 (`aria-live`, `inert` on the overlay, the input's label, the ring
  transitioning layout properties rather than `transform`, the value left in the
  DOM after `finish()`).
- S5 residual: `--surface` against `--bg` is 1.14:1 by WCAG maths. Unchanged.
- The header still costs 16px for the eyebrow. The zoom made that affordable.
