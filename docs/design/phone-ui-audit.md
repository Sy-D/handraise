# Design-engineering audit — the phone UI

This is the audit that produced the 0.3.0 phone UI, kept as a case study
because the reasoning is more useful than the diff. It was written against the
0.2.0 UI, before any of it was changed; every fix below has since shipped (see
the [0.3.0 entry in the changelog](../../CHANGELOG.md)). Read it as a record of
what was wrong and why, not as a to-do list.

The headline finding was not a matter of taste. On a 390px phone the 1280×800
remote page was letterboxed to 28.9% with zoom blocked, so remote 16px text
rendered at ~4.6 CSS px — roughly a millimetre of glyph. The human was being
asked to operate a page they could not read.

Method: the real page, served by the real relay on port 3999, driven in
Playwright Chromium at 390×844 / dpr 3 and 320×568, with a `role=agent`
WebSocket client standing in for the agent (a rendered 1280×800 "Acme Bank 2FA"
page as the frame). Eleven states were captured: initial, frame, focus ring,
typing, long label, long reason, handback overlay, abort overlay, reconnecting,
320px, session lost. Measurements taken from the live DOM, contrast ratios
computed from the actual rendered pixels of the oklch tokens.

Lens: Emil Kowalski's design engineering — clarity of the primary action,
details you feel rather than notice, touch ergonomics, feedback for every
action, restraint in motion, and no ambiguity anywhere.

---

## Question 1 — two buttons or one?

**Two. Keep both. Then fix how they are presented, because the presentation is
currently wrong in a way that matters more than the count.**

### Why two is right

The two buttons are not two ways of saying the same thing. They are the only
place in the whole system where a fact enters that nothing else can produce:
*a human looked at this and it is not solvable.*

- `handback` → `resolved` → the agent is told "Re-read the page and continue."
- `abort` → `aborted` → the agent is told "Do not retry the same step; report
  why you were stuck." (`src/tool.ts:64`)

Delete "Can't help" and the human is left with two bad exits:

| Exit | What the agent learns | Cost |
|---|---|---|
| Hand back anyway | "fixed, carry on" — a lie | Agent retries, fails again, probably raises a second hand. Two handoffs for one dead end. |
| Close the tab | `timeout` — "nobody came" — also a lie | The full `DEFAULT_TIMEOUT_MS` of 5 min burns down (`src/core/raise-hand.ts:41,164`) with nobody waiting on the other end. |

Both destroy information the human had and the agent cannot recover. The
second one destroys five minutes of wall clock as well. A second button is a
cheap price for a typed, truthful outcome. **This is an information-bearing
fork, not a decoration — it stays.**

### What is wrong with it today

**1. The one colour in the entire interface is spent on the give-up button.**
The CSS comment is proud of this: *"exactly one colour in the whole interface —
the destructive red on the 'Can't help' button."* Monochrome everywhere means
the single red element is the strongest visual pull on the screen. So the most
eye-catching thing on a screen whose job is "please fix this for me" is the
button that says *I won't*. The accent should mark the action you want, or
nothing. Right now it advertises failure.

**2. Both are irreversible, both end the session, and they sit 10px apart.**
Measured at 390px: `#handback` 246.4×47 at x=16, `#abort` 101.6×49 at x=272.4.
Ten pixels of gap, and the destructive one occupies the bottom-right corner —
exactly where a right-handed thumb rests. There is no confirmation on either.
A mis-tap silently and permanently ends the handoff.

**3. They are drawn as peers and they are not.** Equal height, equal padding,
equal row. The visual grammar says "two options", the semantics say "the
expected path, and the escape hatch".

**4. They are not even the same height.** `.primary` has `border: none`,
`.ghost` has `1px`, both have `padding: 13px`. Result: 47px vs 49px, baselines
offset by 1px. This is the kind of thing nobody consciously sees and everybody
feels.

**5. At 320px the primary wraps to two lines.** Measured: `#handback` becomes
176.4×**68**, `#abort` stays 49. A 19px height mismatch and a two-line label
that reads "Hand back to / agent".

**6. "Can't help" understates its own consequence.** It reads like "not me,
ask someone else" — low stakes, deferrable. It actually means *terminate the
task; the agent will stop and report failure*. The weight of the label does not
match the weight of the effect. That gap is the ambiguity Emil warns about, and
it is the one that will be tapped by accident.

### On confirm dialogs vs undo

Emil's position, and the correct one here: **prefer undo over confirm.** But
undo is impossible in this system — the `abort` message leaves the socket and
`raise-hand.ts:212` settles the promise immediately; there is nothing to undo.

The answer is therefore **neither a confirm dialog nor nothing**. It is to make
the *gesture* cost more than a tap:

- **Primary (Hand back): no confirmation, ever.** It is the expected ending and
  its worst case is recoverable in spirit — the agent looks, fails, and asks
  again. Confirming the happy path is the classic mistake.
- **Destructive (Can't help): press-and-hold, ~700ms.** This is Emil's
  hold-to-delete pattern verbatim: slow and deliberate on press (`linear`, so
  the fill reads as elapsed time), snappy on release (200ms `ease-out`). It
  cannot fire from a stray thumb, it needs no second screen, and it teaches the
  weight of the action through the interaction rather than through a paragraph
  of warning copy.

### The recommendation

| | Now | Proposed |
|---|---|---|
| Hierarchy | two peers in one row | primary owns the row; "Can't help" is quieter and separated |
| Colour | red, always, on the ghost | muted grey at rest; red only fills during the hold and in the overlay |
| Commitment | one tap, irreversible | hold 700ms, with visible progress and a release escape |
| Label | "Can't help" | "I can't do this" — first person, unmistakable |
| Height | 47 vs 49, wraps at 320 | equal box heights, one line at 320 |

Sketch (CSS only; the hold needs ~15 lines of JS):

```css
/* Equal boxes: give the primary a transparent border so both are 49px. */
.primary { border: 1px solid transparent; }

/* Stop the give-up button from owning the only colour on the screen. */
.ghost {
  position: relative; overflow: hidden;
  color: var(--muted);            /* not --danger */
  border-color: var(--line);
  font-weight: 500;
}

/* Emil's hold-to-delete: the fill IS the confirmation. */
.ghost::before {
  content: ""; position: absolute; inset: 0;
  background: oklch(0.65 0.2 25 / 0.22);
  clip-path: inset(0 100% 0 0);
  transition: clip-path 200ms ease-out;      /* release: snappy */
}
.ghost[data-holding]::before {
  clip-path: inset(0 0 0 0);
  transition: clip-path 700ms linear;        /* press: deliberate */
}
.ghost[data-holding] { color: var(--danger); border-color: var(--danger); }

@media (prefers-reduced-motion: reduce) {
  /* Keep the safety, drop the motion: no fill, just the colour shift. */
  .ghost::before { display: none; }
}
```

```js
var abortBtn = document.getElementById("abort")
var holdTimer = null
function startHold() {
  if (holdTimer) return
  abortBtn.dataset.holding = ""
  holdTimer = setTimeout(function () {
    holdTimer = null
    delete abortBtn.dataset.holding
    if (navigator.vibrate) navigator.vibrate(20)
    send({ type: "abort" })
    finish("Thanks for looking", "The agent knows it can't be done here and will stop. You can close this tab.")
  }, 700)
}
function cancelHold() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
  delete abortBtn.dataset.holding
}
abortBtn.addEventListener("pointerdown", startHold)
abortBtn.addEventListener("pointerup", cancelHold)
abortBtn.addEventListener("pointercancel", cancelHold)
abortBtn.addEventListener("pointerleave", cancelHold)
// The tap that does nothing must say why, or the human thinks it is broken.
abortBtn.addEventListener("click", function () {
  hint.textContent = "Hold the button to tell the agent to stop"
})
```

Effort: **S** for the equal-height / colour / label / no-wrap fixes, **S–M**
for the hold.

*Alternative if the hold feels too clever for a one-time visitor:* stack the
buttons — primary full width on its own row, "Can't help" beneath it as a plain
text button with 16px of separation. It removes the adjacency and the 320px
wrap for free. It costs ~40px of vertical space, which this layout can afford
(see M1: the stage wastes 414px). Take the hold; it is stronger and cheaper in
space.

---

## Muss

### M1. The human cannot read the page they are being asked to operate

**What.** At 390×844 the canvas is 370×625 and a 1280×800 frame is letterboxed
into **370×231** — a 28.9% scale. Remote 14px body text lands at ~4 CSS px,
about a millimetre of glyph height. 414 of 625 stage pixels (66%) are black
bars. `canvas { touch-action: none }` means the human cannot pinch to zoom
either, and `maximum-scale=1` in the viewport meta blocks browser zoom on
Android.

**Why.** Everything else in this UI is craft applied to an interaction the
human cannot perform, because they cannot read the thing they are tapping. It
is the difference between an interface that works and one that only passes its
tests. (Verified: rotating to landscape makes it *worse* — the 153px footer
leaves ~195px of stage, giving 21.9% scale. Rotation is not the answer.)

**Fix.** Two moves, in this order.

1. **Auto-zoom to the focused field.** The agent already sends the field's box
   in `focus`. When it arrives, scale the canvas so that box plus context fills
   the width. This is the exact moment the human needs to read, and the
   information is already on the wire — no protocol change.
2. **Pinch and double-tap zoom on the canvas**, with pan. `toFrame()` divides
   out the zoom; `placeRing()` multiplies it back in.

```js
var zoom = 1, panX = 0, panY = 0
function drawFrame() {
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr)
  ctx.drawImage(img, box.x, box.y, box.w, box.h)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}
function toFrame(cx, cy) {
  var r = canvas.getBoundingClientRect()
  var x = (((cx - r.left - panX) / zoom) - box.x) * frameW / box.w
  var y = (((cy - r.top  - panY) / zoom) - box.y) * frameH / box.h
  /* …bounds check unchanged… */
}
// Fit the focused field to the width, with 20% context either side.
function zoomToFocus() {
  if (!focus || !focus.rect || !box.w) return
  var want = (box.w / frameW) * focus.rect.width * 1.4
  zoom = Math.min(4, Math.max(1, canvas.clientWidth / Math.max(want, 1)))
  /* centre pan on the field, clamp to the letterbox, then render() */
}
```

Also drop `maximum-scale=1` from the viewport meta — it is a WCAG 1.4.4 failure
and iOS has ignored it since iOS 10 anyway, so it only penalises Android.

Effort: **M** (auto-zoom alone is **S–M** and delivers most of the value).

---

### M2. A tap on the canvas produces no feedback at all

**What.** `pointerup` sends `{type:"tap"}` and nothing else happens locally.
The only confirmation is the next screencast frame — and at 28.9% scale, a
focus outline or a pressed button on the remote page is invisible. `*
{ -webkit-tap-highlight-color: transparent }` removes even the platform
default. The human taps, sees nothing, and taps again. On a login form that is
a double submit.

**Why.** "A button scales down on press, confirming the interface heard the
user." Every action needs an acknowledgement inside one frame. This is the most
consequential missing detail in the app.

**Fix.** A ripple in `#stage` (never on the canvas — every frame repaints it):

```css
.tapmark {
  position: absolute; width: 28px; height: 28px; margin: -14px 0 0 -14px;
  border: 2px solid var(--text); border-radius: 50%; pointer-events: none;
  animation: tapmark 320ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
}
@keyframes tapmark {
  from { transform: scale(0.4); opacity: 0.9; }
  to   { transform: scale(1.5); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .tapmark { animation: tapmark-fade 200ms linear forwards; }
  @keyframes tapmark-fade { from { opacity: .9 } to { opacity: 0 } }
}
```

```js
function markTap(clientX, clientY) {
  var host = stage.getBoundingClientRect()
  var m = document.createElement("div")
  m.className = "tapmark"
  m.style.left = (clientX - host.left) + "px"
  m.style.top  = (clientY - host.top)  + "px"
  stage.appendChild(m)
  m.addEventListener("animationend", function () { m.remove() })
  if (navigator.vibrate) navigator.vibrate(8)
}
```

Note the scale starts at 0.4, not 0 — nothing in the real world appears from
nothing. Effort: **S**.

---

### M3. While disconnected, taps and keystrokes are silently thrown away

**What.** `send()` is `if (ws && ws.readyState === 1) ws.send(...)`. During a
reconnect the header reads "Reconnecting…" but the canvas stays fully bright
and fully interactive. Every tap and every character typed in that window is
dropped with no trace, and nothing about the stage suggests it is not live.

**Why.** Silent failure is the one thing an interface may never do. Worse here
than usual: the human will assume the *remote page* ignored them and will retry
the action once the socket is back, double-submitting.

**Fix.** Make the offline state visible and refuse the input rather than eat it.

```css
main[data-offline] canvas { opacity: 0.45; filter: grayscale(1); transition: opacity 150ms ease-out, filter 150ms ease-out; }
main[data-offline] #placeholder { display: block; }
```

```js
function setStatus(live) {
  dot.className = live ? "dot" : "dot waiting"
  stage.toggleAttribute("data-offline", !live)
  kbd.disabled = !live
  if (!live) { reason.textContent = "Reconnecting…"; placeholder.textContent = "Paused — reconnecting" }
}
// and in the pointer handlers:
if (!ws || ws.readyState !== 1) return
```

Effort: **S**.

---

### M4. The bottom safe-area inset is applied twice

**What.**

```css
body   { padding: … env(safe-area-inset-bottom) …; }
footer { padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); }
```

On an iPhone with a 34px home indicator the footer gets 34 + 10 + 34 = 78px of
bottom padding. Ten wasted percent of the screen, on a screen whose canvas is
already starved.

**Why.** Not a judgement call, just a bug — and exactly the class of thing that
never shows up in a desktop Chromium test.

**Fix.** Take the insets off `body`, apply them where they belong. This also
lets the canvas bleed to the screen edges, which M1 wants:

```css
body   { padding: 0; }
header { padding: calc(12px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 12px calc(16px + env(safe-area-inset-left)); }
footer { padding: 10px calc(16px + env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left)); }
```

Effort: **S**.

---

### M5. `height: 100%` and no soft-keyboard handling

**What.** `html, body { height: 100% }` with no `dvh` fallback, and the
viewport meta has no `interactive-widget`. On Chrome Android the default is
`resizes-visual`: the layout viewport does not shrink when the keyboard opens,
so the footer — input, four keys, both buttons — goes under the keyboard.
Typing is the core interaction of this page.

**Fix.**

```html
<meta name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
```

```css
html, body { height: 100%; }
@supports (height: 100dvh) { html, body { height: 100dvh; } }
```

(`maximum-scale=1` is dropped here as well — see M1.) Effort: **S**.

---

### M6. Four key buttons at 40px wide

**What.** Measured 40×48.4. The height passes; the width does not. The 44px
minimum is a *target*, not a height.

**Why.** These four buttons exist precisely because the soft keyboard is
unreliable — Android virtual keyboards report `keyCode 229` instead of a real
key, so deletion riding on `keydown` never arrives. They are the fallback, so
they have to be the most reliable controls on the page.

**Fix.** 44px wide is 4×44 + 3×6 = 194px of the 358px row, leaving 156px for
the field — still enough for a 6-digit code but tight for an email. Better:
give the input its own full-width row and put the keys underneath. The footer
grows by ~40px, out of a stage that currently wastes 414 (M1).

```css
.bar { display: block; }
input { width: 100%; }
.keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 8px; }
.key { width: auto; min-height: 48px; }
```

Note this contradicts the "key bar stays on one line" e2e assertion in
`e2e/ui.spec.ts`, which was written to protect the buttons from being pushed
below the fold. That constraint is not binding: the footer is 153px of 844 and
the stage wastes 414. Update the test with the layout.

Effort: **S**.

---

### M7. ⌫ and ✕ are 6px apart and one of them deletes everything

**What.** Order is ⌫ ✕ ⇥ ⏎, 6px gaps, 40px targets, all four rendered at the
same 16px weight in the same muted grey. A missed backspace hits "clear the
whole field". No undo.

**Fix.** Group by consequence and separate the destructive one:

```css
.keys { gap: 6px; }
#key-clear { margin-right: 10px; }   /* a real gutter before the safe keys */
```

Better still: move clear inside the field, where the platform convention puts
it, and free the slot. Effort: **S**.

---

## Sollte

### S1. The glyphs are ambiguous to the person who will actually see them

**What.** ⌫ ✕ ⇥ ⏎ with `aria-label`s that a touch user never hears. ⇥ ("Next
field") is the weakest — phones have no Tab key, so the glyph carries no
learned meaning. ✕ next to a text field reads as "close/dismiss" as often as
"clear", and it is disabled most of the time (see S2). This is a one-time
visitor with no chance to learn the vocabulary.

**Fix.** Short text labels. They fit in the same width and remove the guessing:

```html
<button id="key-back"  class="key" type="button" aria-label="Delete one character">⌫</button>
<button id="key-clear" class="key" type="button" aria-label="Clear the field">Clear</button>
<button id="key-tab"   class="key" type="button" aria-label="Next field">Next</button>
<button id="key-enter" class="key" type="button" aria-label="Submit">Go</button>
```

```css
.key { width: auto; min-width: 44px; padding: 0 10px; font-size: 13px; }
#key-back { font-size: 17px; }   /* the one glyph everyone knows */
```

Keep ⌫ — it is universally understood. Effort: **S**.

---

### S2. The disabled ✕ is invisible and unexplained

**What.** `.key:disabled { opacity: .38 }` puts the glyph at **1.91:1** against
the surface (measured from rendered pixels). It is effectively not there. And
when it is disabled, nothing says why — the reason ("focus a field first") is
knowable only from a source comment.

**Why.** A disabled control with no explanation is pure ambiguity: the human
concludes the button is broken, or does not see it and wonders why there are
sometimes three keys and sometimes four.

**Fix.** Keep it enabled and let it explain itself when it cannot act. Emil's
rule of thumb — do not disable, respond.

```js
var clearKey = keyButton("key-clear", function () {
  if (!(focus && focus.rect)) {
    hint.textContent = "Tap the field on the screen first"
    setTimeout(setHint, 2200)
    return
  }
  send({ type: "clear" }); resetMirror()
})
```

If it must stay disabled, raise it to `opacity: .55` (≈3.1:1) so it is at least
legible. Effort: **S**.

---

### S3. The reason is the whole point and it is truncated to one line

**What.** `#reason` is `white-space: nowrap; text-overflow: ellipsis`. A real
reason truncates to "Blocked on two-factor authentication at login.a…"
in the captured state. This is the only sentence that tells
the human why they are here.

**Why.** Truncation is right for a label and wrong for the primary
explanation. The stage has 414 spare pixels; two lines of header cost 21.

**Fix.** Clamp at two lines instead of one — still no layout shift:

```css
#reason {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden; white-space: normal;
}
header { align-items: flex-start; }
.dot { margin-top: 6px; }   /* optical alignment to the first line */
```

Effort: **S**.

---

### S4. The page never says what it is or who is asking

**What.** A stranger scans a QR code and lands on a black screen with a dot and
a truncated sentence, and is then asked to type a two-factor code into it.
There is no name, no identification, no "an agent needs your help".

**Why.** No ambiguity — and here it is also a trust problem. This is a phishing
shape: unfamiliar page, dark, credential field, urgency. One superline fixes it.

**Fix.**

```html
<header>
  <span id="dot" class="dot"></span>
  <div class="head-copy">
    <span class="eyebrow">handraise · an agent needs your help</span>
    <span id="reason">Connecting to the browser…</span>
  </div>
</header>
```

```css
.head-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.eyebrow { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
```

Effort: **S**.

---

### S5. Header and footer are not visually surfaces

**What.** `--bg` is `#040404`, `--surface` is `#0a0a0a` — **1.04:1**. The
divider `--line` is **1.2:1** against it. The header, the stage and the footer
read as one continuous black rectangle; the bottom bar is not perceived as a
bar. The key and input borders,
`--field` on `--surface`, measure **1.28:1** — WCAG 1.4.11 wants 3:1 for
control boundaries, and by eye the four keys are ghosts.

**Fix.** Lift the chrome, not the canvas area:

```css
:root {
  --surface: oklch(0.185 0 0);   /* ≈ #131313 — 1.8:1 vs --bg, a readable plane */
  --line:    oklch(0.30 0 0);    /* ≈ #333 — the divider becomes a divider */
  --field:   oklch(0.36 0 0);    /* ≈ #414141 — ~3.1:1, controls read as controls */
}
```

This keeps the palette monochrome and keeps the canvas the brightest thing on
the screen, which is correct. Effort: **S**.

---

### S6. The typed value survives a focus change

**What.** `#kbd` is a local mirror. `resetMirror()` runs on Tab, Enter and
Clear — but **not** when a `focus` message moves the caret to a different
remote field. The hint updates to the new field name while the input still
shows the previous field's characters, and the next keystroke diffs against
stale text.

**Why.** The hint says "Typing into: Password" above a box containing the
username. Two elements 20px apart telling contradictory stories.

**Fix.** In the `focus` branch of `handle()`:

```js
else if (message.type === "focus") {
  var before = focus && focus.rect ? JSON.stringify(focus.rect) : null
  focus = readFocus(message)
  var after = focus.rect ? JSON.stringify(focus.rect) : null
  if (before !== after) resetMirror()   // a different field: start clean
  placeRing(); setHint(); setClearEnabled()
}
```

Effort: **S**.

---

### S7. Passwords and OTPs are typed in the clear and stay on screen

**What.** `#kbd` is always `type="text"`, `autocomplete="off"`, and the typed
value persists until Tab/Enter/Clear. A helper standing in an office types a
password and it sits legible on their phone. And for the product's most common
case — relaying an SMS code — iOS cannot offer the code from Messages because
`autocomplete="off"` opts out of it.

**Why.** The one-time-code autofill is precisely the "unseen detail" that makes
software feel like it was built by someone who thought about the actual
situation. Right now the code is switched off.

**Fix (right).** Extend `focus` in `src/relay/protocol.ts` with an optional
`inputType`, and let the page choose:

```ts
| { type: "focus"; rect: FocusRect | null; label: string | null
    inputType?: "password" | "otp" | "email" | "tel" | "text" }
```

```js
var TYPES = {
  password: { type: "password", inputmode: "text",    autocomplete: "current-password" },
  otp:      { type: "text",     inputmode: "numeric", autocomplete: "one-time-code" },
  email:    { type: "email",    inputmode: "email",   autocomplete: "off" },
  tel:      { type: "tel",      inputmode: "tel",     autocomplete: "off" },
  text:     { type: "text",     inputmode: "text",    autocomplete: "off" }
}
```

**Fix (cheap, UI-only, today).** Infer from the label the agent already sends:

```js
var l = (focus.label || "").toLowerCase()
if (/pass|pin|secret/.test(l))                     applyType("password")
else if (/code|otp|token|2fa|verification/.test(l)) applyType("otp")
```

Effort: **S** for the heuristic, **M** for the protocol field. Do the protocol
field.

---

### S8. Overlay copy is written about the human, not to them

**What.** Six terminal strings, none of them thanking anybody, several
addressing the reader in the third person or contradicting the situation they
are shown in.

| Where | Now | Problem | Proposed |
|---|---|---|---|
| local handback | "Handed back" / "You can close this tab." | never says whether it worked; no thanks | "Thanks — that unblocked it" / "The agent is driving again. You can close this tab." |
| local abort | "Told the agent" / "It knows you couldn't help and will stop waiting…" | "Told the agent" *what?* | "Thanks for looking" / "The agent knows it can't be done here and will stop. You can close this tab." |
| `ENDINGS.resolved` | "Handed back" / "The agent is driving again." | different copy for the same event as the local path | unify with the local handback string |
| `ENDINGS.aborted` | "Handoff ended" / "The helper couldn't solve it." | third person, about the reader | "Handoff ended" / "You couldn't solve it here. Nothing more to do — you can close this tab." |
| `ENDINGS.timeout` | "The agent stopped waiting" / "Nobody picked this up in time." | somebody did — they are reading it | "Too late" / "The agent gave up waiting. Nothing you can do here now." |
| `ENDINGS.disconnected` | "Session lost" / "The browser session died. The agent knows." | "died" is alarming; a stranger who just typed a code will assume they broke it | "Connection ended" / "The remote browser closed. The agent has been told — this wasn't anything you did." |

**Why.** Copy is UI. This person did a stranger a favour under mild pressure and
the interface never acknowledges it. One line of gratitude is free and is the
highest-return change in this document. Effort: **S**.

---

### S9. The terminal overlay appears with no transition

**What.** `overlay.hidden = false` — a full-screen blurred panel snaps into
existence in one frame.

**Why.** This is the one moment in the session where motion is unambiguously
earned: it is seen once, it is user-initiated, and it marks a state change the
human needs to trust. An instant snap on a dark screen reads as a crash.

**Fix.** 200ms, `ease-out`, entering from `scale(0.96)` — never from 0:

```css
#overlay {
  opacity: 1; transform: scale(1);
  transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
              transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
}
@starting-style { #overlay { opacity: 0; transform: scale(0.96); } }
@media (prefers-reduced-motion: reduce) {
  #overlay { transition: opacity 150ms linear; }
  @starting-style { #overlay { opacity: 0; transform: none; } }
}
```

Effort: **S**.

---

### S10. The status dot pulses in the state where nothing is happening

**What.** `.dot::after` runs `pulse 2s ease-out infinite` in the **live** state
— the normal state, present for the whole session. `.dot.waiting` pulses faster
(0.9s); `.dot.dead` is static.

**Why.** Motion is a signal and this one is on 100% of the time, so it signals
nothing. It animates continuously in the corner of a screen someone is staring
at while typing a password. Restraint: motion should mark change, not
permanence.

**Fix.** Invert it. Live is a steady dot; only *waiting* pulses, because
waiting is the state where the human needs to know something is still trying:

```css
.dot::after { animation: none; opacity: 0; }
.dot.waiting::after { animation: pulse .9s ease-out infinite; }
```

Effort: **S**.

---

### S11. The key buttons may never show their press state on iOS

**What.** `.key:active` is the only press feedback, but `keyButton()`
`preventDefault()`s both `mousedown` and `touchstart`. Whether WebKit still
applies `:active` after a cancelled `touchstart` is not something to leave to
chance on the controls that exist *because* the platform is unreliable.

Separately: `touchend` fires `run()` with no hit test, so pressing ⌫ and
sliding the thumb off the button still deletes a character. There is no
`touchcancel` handler either.

**Fix.** Drive the press state from the handlers that already exist, and check
the release point:

```js
function keyButton(id, run) {
  var button = document.getElementById(id)
  var touchedAt = 0
  var hold = function (e) { e.preventDefault(); button.dataset.pressed = "" }
  button.addEventListener("mousedown", hold)
  button.addEventListener("touchstart", hold, { passive: false })
  button.addEventListener("touchcancel", function () { delete button.dataset.pressed })
  button.addEventListener("touchend", function (e) {
    e.preventDefault()
    delete button.dataset.pressed
    touchedAt = Date.now()
    var t = e.changedTouches[0]
    // A finger that slid off the button did not press the button.
    if (t && !button.contains(document.elementFromPoint(t.clientX, t.clientY))) return
    if (!button.disabled) run()
  })
  /* click handler unchanged */
  return button
}
```

```css
.key[data-pressed]:not(:disabled),
.key:active:not(:disabled) { color: var(--text); border-color: var(--focusBorder); background: oklch(0.26 0 0 / 0.4); }
```

Effort: **S**.

---

### S12. No press feedback on either bottom button

**What.** `.primary:active` shifts the background from `#fafafa` to `#e6e6e6`
and `.ghost:active` tints — both with no transition, and both barely
perceptible on a bright button under a thumb that is covering it.

**Fix.** Scale, which is felt even when the button is hidden by the finger:

```css
button { transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1); }
.primary:active, .ghost:active { transform: scale(0.97); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
```

Effort: **S**.

---

### S13. Nothing tells the human a clock is running

**What.** `setTimeout(() => settle("timeout"), timeoutMs)` with a 5-minute
default (`src/core/raise-hand.ts:41,164`) is armed when the handoff starts and
is **never reset by human activity**. Someone waiting on an SMS at minute 4:50
can be cut off mid-typing, and the agent records `timeout` — "nobody came" —
which is false.

**Why.** A deadline the user cannot see is a trap. And it is the missing third
outcome behind Question 1: "I'm on it, give me longer."

**Fix.** Needs the agent to put the remaining time on the wire (extend `state`,
or add a `deadline` message). Then the UI shows it only when it starts to
matter — a permanent countdown would just add anxiety:

```js
// below 60s: the header earns a countdown, tabular so it cannot shift
if (remainingMs < 60000) {
  reason.textContent = "Ending in " + Math.ceil(remainingMs / 1000) + "s"
  reason.style.fontVariantNumeric = "tabular-nums"
}
```

The better fix is upstream: reset the timer on any human message, and use the
hard timeout only for "nobody ever arrived". Effort: **M** (protocol + core).

---

## Nice

### N1. Two competing "we are waiting" messages
`#reason` says "Connecting to the browser…" while `#placeholder` says "Waiting
for the first frame…" — the same fact in two places in two vocabularies, and
"frame" is jargon. Make the placeholder the quiet one: "Loading the screen…",
or drop it and let the header speak. And it never gives up: if no frame arrives
in 15s, say so. **S**

### N2. No `aria-live` anywhere
`#reason`, `#hint` and `#overlay` all change without announcement. Add
`aria-live="polite"` to the first two and `role="alertdialog" aria-live="assertive"`
to the overlay. Mark the canvas `aria-hidden="true"` — a screencast is not
usable by a screen reader and pretending otherwise helps nobody. **S**

### N3. The overlay does not trap anything
After `finish()` the buttons behind the overlay are still tabbable and still
wired. Add `inert` to `<header>`, `<main>` and `<footer>` when the overlay
opens. **S**

### N4. The input has no label
`placeholder="Type here"` is the only naming, and placeholder-as-label
disappears the moment you type. Add `aria-label` and wire `#hint` as the
description: `<input id="kbd" aria-label="Type into the remote browser"
aria-describedby="hint">`. **S**

### N5. Typographic inconsistencies
`letter-spacing: -0.01em` on `#reason` and `.primary` only; `font-size: 12.5px`
on `.hint` (fractional, and below a sensible 13px floor for copy that carries
"Typing into: X"). Negative tracking on 12.5px text hurts — small type wants
slightly *positive* tracking. Set the hint to `13px` / `letter-spacing: 0.005em`
and either apply the negative tracking systematically to headings or drop it.
Add `-webkit-font-smoothing: antialiased` for the light-on-dark stack. **S**

### N6. `#focus-ring` transitions layout properties
`transition: left .12s, top .12s, width .12s, height .12s` animates four
properties that each force layout, and `placeRing()` runs on every decoded
frame (~10/s) doing two `getBoundingClientRect()` calls. The 120ms move is
justified — it lets the human follow where the caret went — but it should ride
on the compositor:

```css
#focus-ring { transform: translate(var(--rx), var(--ry)); transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1); left: 0; top: 0; }
```
with width/height written directly. Cache the two rects instead of re-measuring
per frame. **S**

### N7. Horizontal drags vanish
`pointermove` only produces `{type:"scroll", fdy}`. A drag past the 10px
threshold cancels the tap; if it was horizontal, nothing at all is sent and
nothing on screen acknowledges the gesture. Either send `fdx` too, or ignore
horizontal travel for the tap-cancel test so a slightly sideways thumb still
taps. **S**

### N8. The typed value is never cleared on teardown
`finish()` calls `kbd.blur()` but leaves the value in the field. The overlay
covers it, but a password sits in the DOM of a page that may stay open on a
phone for hours. Call `resetMirror()` in `finish()`. **S**

---

## What is already right

Worth recording, because a review that only lists faults misrepresents the
work:

- **Zero `:hover` rules.** Correct for a touch-only surface, and rare.
- **`font-size: 16px` on the input** — no iOS zoom-on-focus. Deliberate and
  correct.
- **`prefers-reduced-motion` already handled** for the dot and the focus ring.
  Both existing animations are covered.
- **Focus preservation in the key bar.** The `mousedown`/`touchstart`
  `preventDefault` plus the 700ms `touchedAt` click de-dupe is genuinely
  careful work, and the comment explains exactly why each line is there.
- **`textContent`, never `innerHTML`, for the field label**, with an e2e test
  proving it. The label is attacker-controlled by construction and it is
  treated that way.
- **`overscroll-behavior: none`** kills pull-to-refresh and rubber-banding —
  exactly right for a full-bleed canvas surface.
- **The 1px dark keyline outside the white focus ring**, so it stays readable
  on a light page whose colours are not ours. That is an unseen detail doing
  real work.
- **No layout shift** anywhere: every dynamic string is single-line and
  clipped. (The fix in S3 keeps that property by clamping instead of wrapping.)
- **No console errors** in any of the eleven states exercised.

---

## Summary

| # | Finding | Effort |
|---|---|---|
| **Q1** | Keep both buttons. Equalise heights, stop the 320px wrap, take the accent colour off "Can't help", relabel it, and gate it behind a 700ms hold instead of a confirm dialog. | S–M |
| M1 | The remote page renders at 28.9% and cannot be zoomed — unreadable. Auto-zoom to focus + pinch/double-tap. | M |
| M2 | A tap on the canvas produces no local feedback. Add a ripple. | S |
| M3 | Input during reconnect is silently discarded. Dim, disable, refuse. | S |
| M4 | Bottom safe-area inset applied twice (≈78px on a notched iPhone). | S |
| M5 | `height: 100%` with no `dvh`, no `interactive-widget` — footer under the keyboard on Android. | S |
| M6 | Key targets are 40px wide. Give the input its own row. | S |
| M7 | ⌫ and ✕ are 6px apart; one deletes everything. | S |
| S1–S13 | Glyph legibility, invisible disabled state, truncated reason, no page identity, chrome at 1.04:1, stale mirror on focus change, no password/OTP input types, third-person copy with no thanks, overlay with no transition, a pulse in the idle state, iOS press states, no press scale, an invisible 5-minute deadline. | S (S7, S13: M) |
| N1–N8 | Duplicate waiting copy, `aria-live`, `inert`, input label, typography, ring transitions layout, horizontal drags, value not cleared on teardown. | S |
