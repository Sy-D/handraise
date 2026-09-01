# Key bar — deleting text that is already in the remote field

VERDICT: FIXED. Four explicit buttons next to the input, no dependency on
soft-keyboard events, one new protocol message (`clear`).

## The bug

The phone sent `Backspace` from exactly one place:

```js
if (e.key === "Backspace" && kbd.value === "") send({ type: "key", key: "Backspace" })
```

That works on a desktop keyboard. It does not work on a phone. Android's
virtual keyboards report composition, not keys: a Backspace on an empty field
arrives as `keyCode 229` / `key: "Unidentified"`, or as no `keydown` at all. So
whenever the remote field already held text — the exact case the human is there
to fix — the human could type but never delete. Found by operating the real UI
on a real phone; every gate in the repo was green at the time.

## What was built

| Button | id | Message |
|---|---|---|
| ⌫ | `#key-back` | `{"type":"key","key":"Backspace"}` |
| ✕ | `#key-clear` | `{"type":"clear"}` |
| ⇥ | `#key-tab` | `{"type":"key","key":"Tab"}` |
| ⏎ | `#key-enter` | `{"type":"key","key":"Enter"}` |

Tab needed no protocol work: `KEY_TABLE` in `src/core/input.ts` already carried
Enter, Backspace and Tab, and the wire type already allowed all three. Only
`clear` is new.

Files: `src/relay/protocol.ts`, `src/core/input.ts`, `src/core/input.test.ts`,
`src/relay/guest/server.js` (re-embedded into `src/relay/guest-source.ts`),
`e2e/ui.spec.ts`. Nothing committed.

## `clear`, and why it is a keyboard sequence

`clear` is not "set the value to empty". It is select-all plus one Backspace,
dispatched as ordinary key events, so a page whose field has a `keydown` or
`input` listener sees what a human would produce. The message set stays closed:
four CDP calls, no "run this on the page" escape hatch.

```ts
// Ctrl, not Meta: the remote page is Linux Chromium (spikes/s3-report.md).
Input.dispatchKeyEvent { type: "rawKeyDown", key: "a", code: "KeyA",
                         windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
                         modifiers: 2 }              // no text
Input.dispatchKeyEvent { type: "keyUp",      key: "a", code: "KeyA",
                         windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
                         modifiers: 2 }              // no text
Input.dispatchKeyEvent { type: "rawKeyDown", key: "Backspace", code: "Backspace",
                         windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }
Input.dispatchKeyEvent { type: "keyUp",      key: "Backspace", ... }
```

Two traps from S3 are honoured here. `rawKeyDown` with no `text`, because any
modifier other than Shift must suppress `text` — a `keyDown` carrying `"a"`
next to Ctrl types an "a" into the field instead of selecting it. And the
delete half goes through the existing `dispatchKey` / `KEY_TABLE` path, so it
cannot drift from the Backspace key. Enter's documented `text: "\r"` exception
was not touched.

`clear` runs through the same serialisation queue, the same 256-message depth
cap, the same error handling and the same `applied()` counter as every other
input.

## Keeping the local mirror consistent

The bar mirrors what the human types in `mirrored`; the `input` listener diffs
`mirrored` against `kbd.value` and sends one `Backspace` per removed character
and one `char` per added one. Any button that changes the field without
updating `mirrored` makes the next keystroke send phantom messages.

Writing `kbd.value` from script fires **no** `input` event, so the diff never
runs for these edits — that is what makes the rule below sound:

* **Backspace button, field not empty:** drop the last character from
  `kbd.value` *and* set `mirrored = kbd.value`, then send exactly one
  `Backspace`. The message speaks for the character; the diff has nothing left
  to report. Forget the `mirrored` half and the next keystroke sends a second
  `Backspace` first — one character too many gone from the remote field.
* **Backspace button, field empty:** send the message only. Nothing local to
  trim.
* **Clear, Tab, Enter:** `resetMirror()` — `kbd.value = ""` and `mirrored = ""`.
  Enter already did this; Tab and Clear now do the same, because after a field
  change or a submit what the human types next belongs to a different context.
  `resetMirror()` is shared by the Enter key path and the Enter button, so the
  two cannot drift.

## Keeping the focus (and the soft keyboard)

A button that takes focus blurs `#kbd`, and the phone's keyboard slides away
under every press. `keyButton()` therefore:

* `preventDefault()` on **mousedown** — this is what actually stops the focus
  moving, on desktop and through the compatibility mousedown on a phone;
* `preventDefault()` on **touchstart** (`{ passive: false }`);
* fires the action on **touchend** for the touch path, because cancelling
  touchstart also suppresses the compatibility `click` — a handler that only
  listens for `click` would be dead on a phone;
* fires on **click** for the mouse path, guarded by `Date.now() - touchedAt <
  700`. If a browser ignores the touchstart cancel and emits the click anyway,
  the guard swallows it. A doubled Backspace is a deleted character the human
  never asked to lose, so this is worth the four lines;
* checks `button.disabled` in both paths: disabled elements suppress mouse
  events, but touch events still reach them in some browsers.

`e2e/ui.spec.ts` asserts `document.activeElement.id === "kbd"` after clicking
each of the four buttons.

## `#key-clear` is disabled without a focus

With nothing focused, Ctrl+A marks the whole remote page instead of a value, so
the key is not offered. The page already tracks the agent's `focus` message;
`setClearEnabled()` sets `clearKey.disabled = !(focus && focus.rect)` and runs
wherever `focus` changes — the `focus` branch of `handle()` and `finish()`. The
markup ships the button `disabled`, which is the correct state before the first
focus arrives.

## Layout

Same cmpinf language: monochrome, the oklch tokens already in the file, the
existing `--radius`, ghost buttons with a `var(--field)` (oklch 0.26 0 0)
border and muted glyphs; only `:active` brightens. `.bar` is a flex row, the
field is `flex: 1 1 auto; min-width: 0`, the keys are `flex: none` at 40 x 44
px, so the row cannot wrap. A test at 320 x 568 asserts the keys sit on the
field's line, to its right, that every key is at least 44 px tall, and that the
field keeps more than 60 px. No existing id, string, overlay or behaviour was
changed.

## Tests added

`src/core/input.test.ts`

* `clear is Ctrl+A without text, then one Backspace` — the full four-call
  sequence, `modifiers: 2`, `text` undefined on both halves.
* `clear with nothing focused dispatches and resolves, never throws` — four
  events out, no rejection, counted once as applied.

`e2e/ui.spec.ts` (real Chromium, real guest server, no Solari)

* `every key button sends its message without taking the focus` — all four
  messages, and `activeElement` is `#kbd` after each click.
* `the backspace key deletes one character and sends exactly one Backspace` —
  the regression test: type `ab`, click ⌫, field is `a`, one `Backspace` on the
  wire, and the next keystroke arrives as `char c` with no second `Backspace`.
* `the clear key is offered only while a remote field is focused` — disabled,
  then enabled on `focus` with a rect, then disabled again on `rect: null`.
* `the key bar stays on one line on a narrow phone` — 320 px viewport.

## Red proof

Three mutations, each reverted afterwards.

1. **Mirror not trimmed** — dropped `mirrored = kbd.value` from the ⌫ handler:

   ```
   (fail) the backspace key deletes one character and sends exactly one Backspace
    14 pass, 1 fail
   ```

2. **Focus not held** — removed the `mousedown` `preventDefault`:

   ```
   388 |     expect(await activeId(page)).toBe("kbd")
   error: expect(received).toBe(expected)
   Expected: "kbd"      Received: "key-back"
   (fail) every key button sends its message without taking the focus
   ```

   The backspace test went red with it, for the reason the fix exists: with the
   field blurred, refocusing it selects its content, and the next keystroke
   replaces the selection, which the diff reports as an extra `Backspace`.

3. **Wrong modifier** — `CTRL = 2` changed to `4` (Meta):

   ```
   -   "modifiers": 2,
   +   "modifiers": 4,
   (fail) clear is Ctrl+A without text, then one Backspace
   ```

The lint gate itself was checked the same way: a throwaway
`function slop(value: unknown)` made oxlint fire
`anti-slop(no-unknown-parameters)`, so its silence below means it ran.

## Gates (verbatim)

```
$ ./node_modules/.bin/tsc --noEmit
TSC=ok

$ ./node_modules/.bin/oxlint
(no output, exit 0)

$ ./node_modules/.bin/biome check .
Checked 42 files in 46ms. No fixes applied.
Found 2 infos.

$ bun scripts/embed-guest.ts --check
guest-source.ts is in sync with guest/server.js

$ bun run test
 124 pass
 0 fail
 358 expect() calls
Ran 124 tests across 11 files. [8.28s]
```

118 tests before, 124 after: 2 new unit tests and 4 new UI tests. Biome's two
infos are pre-existing (schema version string and the deprecated `recommended`
field), not errors. No complexity threshold was raised — the whole key bar
lives inside the `PAGE` template literal, which Biome treats as a string, and
the module-level code of `server.js` is unchanged.
