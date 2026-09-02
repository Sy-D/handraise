# Phone UX 0.3.0 — Block 1

Implementation of blocks A–E of the phone-UX increment against
`spikes/emil-ui-audit.md`. Auto-zoom (M1), the reconnect queue (M3) and OTP
autofill (S7) are **not** in here — they are Block 2.

Files touched: `src/relay/guest/server.js` (source of truth),
`src/relay/guest-source.ts` (generated), `e2e/ui.spec.ts`. Nothing else. Not
committed.

---

## A — the two exit buttons (audit Q1)

Both buttons stay. They are an information-bearing fork: `handback` →
`resolved` ("re-read the page and continue"), `abort` → `aborted` ("do not
retry this step"). What changed is the presentation.

| Audit finding | What was done |
|---|---|
| Q1.1 the only colour in the interface sits on the give-up button | `.ghost` is `--muted` on `--line` at rest. The red survives only as the hold's progress fill and the border while a finger is on it. |
| Q1.4 heights differ (47 vs 49, `border: none` vs `1px`) | `.primary` got `border: 1px solid transparent`. Both boxes measure **49.0px** at 390 and at 320. |
| Q1.5 the primary wraps to two lines at 320 | `white-space: nowrap` on both, and the primary label shortened. One line at 320 (153.4 × 49.0), verified from `getBoundingClientRect`. |
| Q1.6 "Can't help" understates its consequence | Relabelled — see below. |
| Q1 press-and-hold instead of a confirm dialog | 700 ms hold with a linear fill; release snaps back in 200 ms ease-out. |
| S8 overlay copy is written about the human | All six terminal strings rewritten in the second person, with a thank-you. |
| S9 the overlay snaps into existence | 200 ms `@starting-style` fade from `opacity: 0; scale(0.96)`. |
| S12 no felt press state on either button | `transform: scale(0.97)` on `:active`, 160 ms ease-out. |

### The label decision

`Can't help` → **`I can't do this`**, which is the audit's own recommendation.

"Can't help" reads as *not me, ask someone else* — low stakes, deferrable —
while it actually terminates the task. First person removes the deflection: the
human is not declining to help, they are reporting that the thing cannot be
done. The consequence itself is carried by two other surfaces rather than
crammed into a 15px button label: the hold gesture (you cannot do this by
accident), and the hint that answers a bare tap — **"Hold the button to stop the
agent"**. That is where the word *stop* belongs, because it is read at the exact
moment the human is asking "what does this button do?".

The primary went from `✋ Hand back to agent` to **`✋ Hand back`**. Not
cosmetic: at 320px the row has 288px, the give-up button needs 124.6 of them,
and the long label was the thing that wrapped to two lines and broke the row
height. "to agent" was also the only redundant part — the header already says
*an agent asked for your help*.

### The hold

- Pointer events only (`pointerdown` / `pointerup` / `pointercancel` /
  `pointerleave`). One stream covers mouse, touch and pen, so there is no
  touch-plus-mouse double fire to guard against.
- The fill is `::before` with `transform: scaleX()` and
  `transform-origin: left`, not `width` or `clip-path` — the progress never
  leaves the compositor. Press: `700ms linear` (it reads as elapsed time).
  Release: `200ms cubic-bezier(0.23, 1, 0.32, 1)`. Asymmetric on purpose —
  slow where the human is deciding, fast where the system is responding.
- Release before 700 ms clears the timer and the attribute; nothing is sent.
- The click that a release always produces is swallowed after a completed hold
  (`holdFired`), so `abort` goes out exactly once — asserted.
- Keyboard: held Space or Enter starts the same 700 ms. Without it the button
  would be unreachable without a pointer.
- `prefers-reduced-motion`: the fill is `display: none` and a flat red tint
  marks the hold instead. **The 700 ms is unchanged** — reduced motion means
  less movement, never less safety.
- The label is a `<span class="ghost-label">` with `position: relative`,
  because an absolutely positioned `::before` otherwise paints over the
  button's own text.

### Overlay copy

| Where | Now |
|---|---|
| handback (local **and** `ENDINGS.resolved`, one string for one event) | "Thanks — that unblocked it" / "The agent is driving again. You can close this tab." |
| give-up (local) | "Thanks for looking" / "The agent knows it can't be done here and will stop. You can close this tab." |
| `ENDINGS.aborted` | "Handoff ended" / "You couldn't solve it here. Nothing more to do — you can close this tab." |
| `ENDINGS.timeout` | "Too late" / "The agent gave up waiting. Nothing you can do here now." |
| `ENDINGS.disconnected` | "Connection ended" / "The remote browser closed. The agent has been told — this wasn't anything you did." |

The local handback path now reads `ENDINGS.resolved` instead of holding its own
copy of the same sentence, which is how the two drifted apart in the first
place.

---

## B — the key bar (audit M6, M7, S1, S2)

**Order: `⌫ ⇥ ⏎` ⟨gutter⟩ `Clear`.** The reasoning is consequence, not
alphabet:

- ⌫, ⇥ and ⏎ each cost one character or one step and are recoverable by
  retyping or tabbing back. They belong together, and they sit in the order a
  human works a form: delete, next field, submit.
- Clear destroys the whole remote field with no undo. It is the one key that
  must not be reachable by a missed press of the key next to it — and the key
  pressed most often, by a wide margin, is ⌫.
- Pushing it to the right edge behind a gutter means the thumb has to
  deliberately travel for it. Measured gap ⏎ → Clear: **24.0px**; ⌫ → Clear:
  **124px** (was 6px, audit M7).

Also:

- Every key is **44 × 48.4px** (was 40 wide — the 44 minimum is a target, not a
  height, audit M6).
- The ✕ glyph became the word **"Clear"** (audit S1). ✕ beside a text field
  reads as *close/dismiss* as often as *clear*, and this is a one-time visitor
  with no chance to learn the vocabulary. ⌫ stays a glyph — it is universally
  understood — and ⇥/⏎ stay glyphs because the row has no width to spare at
  320px. All `aria-label`s stay; ⌫'s became "Delete one character".
- Disabled contrast (audit S2): `opacity: .38` → **`.62`**. Computed from the
  composited colour: `--muted` on `--surface` at .38 is **1.96:1** (the audit
  measured 1.91 on the old surface), at .62 it is **3.17:1** — over the WCAG
  1.4.11 3:1 floor for controls.
- The focus-preservation logic in `keyButton()` (`mousedown`/`touchstart`
  `preventDefault`, `touchend` plus the 700 ms `touchedAt` click de-dupe) was
  **not touched**. The "every key button sends its message without taking the
  focus" test still passes unchanged.
- At 320px the field keeps **69.4px** (it would have been 61.4 — the
  `max-width: 360px` rule below buys it 8px back).

---

## C — tap feedback on the canvas (audit M2)

A 28px ring at the touch point in `#stage` (never on the canvas — every frame
repaints it), 300 ms, `transform` and `opacity` only, from `scale(.4)` to
`scale(1.6)`. It starts at 0.4 and not 0 because nothing in the real world
appears from nothing. `navigator.vibrate(8)` where it exists.

It is only drawn when a tap is actually sent, so a drag or a tap in the
letterbox produces no false acknowledgement. It removes itself on
`animationend`, with a 600 ms `setTimeout` fallback for the case where
animations are off entirely and `animationend` never fires — otherwise the
marks would pile up on the stage for the rest of the session.

`prefers-reduced-motion`: a 200 ms linear fade of the same dot, no movement.

---

## D — the layout traps (audit M4, M5, S5)

- **Safe-area insets applied once.** `body` lost its inset padding entirely;
  `header`, `footer` and `main` each apply the insets that touch their own
  edges. On a notched iPhone the footer had 34 + 10 + 34 = 78px of bottom
  padding.
- **Viewport meta**: `interactive-widget=resizes-content` added, so Chrome
  Android shrinks the layout viewport when the keyboard opens and the bottom
  bar stays above it. `maximum-scale=1` dropped with it (audit M1/M5) — a WCAG
  1.4.4 failure that iOS has ignored since iOS 10, so it only ever penalised
  Android.
- **`100dvh`** behind `@supports`, with `100%` as the fallback.
- **Chrome contrast** (audit S5): `--surface` 0.145 → **0.205**, `--line`
  0.24 → **0.30**, `--field` 0.26 → **0.36**. Still monochrome, still oklch,
  still the cmpinf/shadcn step values.

  Honest numbers, computed from the rendered colours: surface against bg goes
  from **1.03:1 to 1.14:1**, field borders from **1.27:1 to 1.65:1**. WCAG
  ratios compress to nothing near black, so the meaningful figure is the sRGB
  step: `#0a0a0a` → `#171717` against a `#040404` stage (6/255 → 19/255), and
  the divider from `#1f1f1f` to `#2e2e2e`. The screenshots show the header and
  footer reading as surfaces and the key borders reading as controls, which is
  what the audit asked for. Pushing further would leave the palette.
- Added `@media (max-width: 360px)`: 16px chrome padding → 12px, because at
  320px the field and the key bar were fighting over 288px.

---

## E — the cheap shoulds

| Audit | Done |
|---|---|
| S3 the reason is truncated to one line | `-webkit-line-clamp: 2`, `header { align-items: flex-start }`, dot nudged 4px down onto the first line. Still clamped, so it can never take the stage with it. |
| S4 the page never says what it is | Header eyebrow: **handraise · an agent asked for your help**, 11px, muted, wordmark in `--text`. |
| S10 the dot pulses in the state where nothing happens | The pulse moved off `.dot` onto `.dot.waiting` only. Live is a steady dot; reconnecting pulses at 0.9s. |
| `-webkit-tap-highlight-color: transparent` + visible `:active` | Already present; the missing half (`:active` on the two bottom buttons) added under A. |
| `overscroll-behavior` | Already `none` on `html, body` — verified, unchanged. |

One thing the audit did not ask for, added because block E caused it: the
header can now grow to a second line, which resizes the stage without resizing
the window. `render()` is bound to `window.resize` only, so the letterbox would
have gone stale until the next frame. A `ResizeObserver` on `#stage` now calls
`render()`. No console errors in any of the 20 e2e states.

**Not touched**: the 5-minute deadline (S13), as instructed.

---

## Tests

`e2e/ui.spec.ts`: 15 → **20** tests, 64 → 95 assertions. Real Chromium, real
relay, no Solari.

New:

1. `a tap on the canvas is acknowledged on the stage, then cleans up` — counts
   `.tapmark` insertions through a `MutationObserver` (the element lives 300 ms,
   so counting beats racing it) and then asserts it removes itself.
2. `every key is a 44px target and clear is fenced off from backspace` — all
   four keys ≥ 44 on both axes, ⌫ → Clear gap ≥ 24px.
3. `the header names the page and gives a long reason two lines` — the eyebrow
   text, the live dot's `animationName === "none"`, and a long reason growing
   to two lines but not three.
4. `reduced motion drops the fill and keeps the 700ms` — `::before` is
   `display: none`, a 300 ms press still does nothing, a 900 ms hold still
   aborts.
5. `a press shorter than the hold never ends the handoff` — no `abort`, no
   overlay, no `data-holding` left behind, and the hint explains itself.
6. `holding the give-up button past 700ms aborts exactly once` — `data-holding`
   present mid-hold, and exactly one `abort` on the wire after the release's
   click.

Changed: the abort test was replaced by (5) and (6); the handback and `ended`
overlay tests follow the new copy; the reconnect test now also asserts the
waiting dot *does* pulse. `AgentClient` gained a `received: RelayMessage[]` that
`next()` never consumes, which is what makes "exactly once" assertable.

### Red before green

Both assertions were watched failing against the unmodified page:

```
455 | test("every key is a 44px target and clear is fenced off from backspace", ...
459 |     expect(box.w).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX)
error: expect(received).toBeGreaterThanOrEqual(expected)
Expected: >= 44
Received: 40
(fail) every key is a 44px target and clear is fenced off from backspace [117.61ms]

524 |   await pressAndHold("#abort", 300)
527 |   expect(countOf("abort")).toBe(0)
error: expect(received).toBe(expected)
Expected: 0
Received: 1
(fail) a press shorter than the hold never ends the handoff [850.71ms]

544 |   expect(await page.locator("#abort").getAttribute("data-holding")).toBe("")
error: expect(received).toBe(expected)
Expected: ""
Received: null
(fail) holding the give-up button past 700ms aborts exactly once [449.03ms]

 14 pass
 3 fail
```

The 40px is the old key width; the `abort` on a 300 ms press is the old
single-tap button firing; `data-holding` is the hold state that did not exist.

---

## Gates

All run from the repo root after the last change.

```
$ ./node_modules/.bin/tsc --noEmit
exit=0                                    (no output)

$ ./node_modules/.bin/oxlint
exit=0                                    (no output, 0 warnings)

$ ./node_modules/.bin/biome check .
Checked 48 files in 47ms. No fixes applied.
Found 2 infos.
exit=0
  — both infos are pre-existing biome.json schema-version notices, not findings
    on this change. The complexity ratchet for server.js stays at 59; no Node-
    side function was touched, and the page JS lives in a template literal.

$ bun scripts/embed-guest.ts --check
guest-source.ts is in sync with guest/server.js
exit=0

$ bun run test
 146 pass
 0 fail
 456 expect() calls
Ran 146 tests across 12 files. [13.15s]
exit=0
```

141 → 146: five net new (six added, the old abort test removed).

`git status --short` shows exactly three modified files:
`e2e/ui.spec.ts`, `src/relay/guest/server.js`, `src/relay/guest-source.ts`.
Nothing committed.

---

## Screenshots

390 × 844, `deviceScaleFactor: 3`, real relay, a rendered 1280 × 800 "Acme Bank
two-factor" page standing in for the stuck page.

| File | State |
|---|---|
| `/tmp/hr-ui-after/block1-1-initial.png` | Connected, no frame yet |
| `/tmp/hr-ui-after/block1-2-frame-focus.png` | Frame decoded, focus ring on the code field, two-line reason |
| `/tmp/hr-ui-after/block1-3-hold-progress.png` | The hold at ~380 ms — the fill is just past half |
| `/tmp/hr-ui-after/block1-4-overlay-handback.png` | "Thanks — that unblocked it" |
| `/tmp/hr-ui-after/block1-5-overlay-giveup.png` | "Thanks for looking" |

The overlay fade was verified frame by frame rather than by eye
(`requestAnimationFrame` sampling of the computed style):

```
t0  opacity 0      matrix(0.96, …)
t1  opacity 0.177  matrix(0.967081, …)
t2  opacity 0.339  matrix(0.973542, …)
t3  opacity 0.481  matrix(0.979250, …)
t4  opacity 0.594  matrix(0.983745, …)
    after 260ms: opacity 1, matrix(1, …)
```

Measured boxes:

| | 390px | 320px |
|---|---|---|
| `#handback` | 223.4 × 49.0, 1 line | 161.4 × 49.0, 1 line |
| `#abort` | 124.6 × 49.0 | 124.6 × 49.0 |
| `#kbd` | 131.4 | 69.4 |
| each key | 44 × 48.4 | 44 × 48.4 |
| ⏎ → Clear gap | 24.0 | 24.0 |
| header / footer / stage | 62.4 / 152.9 / 628.7 | 62.4 / 152.9 / 352.7 |

---

## Open for Block 2

**In the agreed Block 2 scope**

- **M1 auto-zoom + pinch.** Untouched and still the biggest problem: the frame
  is letterboxed to ~29% and the remote body text lands at ~4 CSS px. Block 1
  made the chrome correct around an image the human still cannot read.
  `maximum-scale=1` is already gone, so browser zoom is no longer blocked.
- **M3 reconnect queue.** Taps and keystrokes are still dropped silently while
  the socket is down. The canvas gives no sign it is not live.
- **S7 OTP/password input types.** `#kbd` is still `type="text"`,
  `autocomplete="off"` — iOS cannot offer the SMS code, and passwords sit
  legible on the phone.

**Found or caused here, not in Block 1 scope**

- **M6, now sharper.** At 320px the field is 69.4px — about four visible
  characters. Fine for a 6-digit code, poor for an email. The audit's answer is
  to give the input its own row and put the keys underneath; that changes the
  "key bar stays on one line" e2e, which is why it was left out. Worth doing in
  Block 2 while that test is being touched anyway.
- **S5 residual.** `--surface` against `--bg` is 1.14:1 by WCAG maths. It reads
  correctly on screen, but if a real device says otherwise the next step is
  `--bg` down rather than `--surface` up, so the stage stays the brightest
  thing.
- **The header now costs 16px more** (46 → 62.4) for the eyebrow. Cheap against
  a stage that wastes 414px, but it is stage the zoom work will want back.
- Still open from the audit and untouched: S6 (the mirror survives a focus
  change), S11 (`touchend` fires with no hit test, so a finger that slides off
  ⌫ still deletes), S13 (the invisible 5-minute deadline — explicitly excluded),
  N1–N8 (`aria-live`, `inert` on the overlay, the input's label, the ring
  transitioning layout properties, horizontal drags, the value left in the DOM
  after `finish()`).
