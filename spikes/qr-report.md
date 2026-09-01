# QR shrink: half blocks → quadrant blocks

Goal: `raiseHand()` printed a QR code 63 columns wide. Anything narrower than
that wraps it, and a wrapped QR code is not a QR code. Target: fit everywhere.

Scope: `src/qr.ts`, `src/qr.test.ts`. No new dependency, no API change.
Not committed.

## Result

For a 300-character handoff URL (`pt_token` JWT, not shortenable):

| | rows | columns |
|---|---|---|
| before — half blocks (`{ small: true }`) | 32 | **63** |
| after — quadrant blocks | 32 | **32** |

Same symbol, same modules, same polarity. Half the width.

Return contract is unchanged: `handoffQr` still returns `null` instead of
throwing, and `printHandoffQr` still prints reason → QR → `or open <url>`.

## How the module matrix is obtained, and why that way

Two options were on the table.

**A — reach into qrcode-terminal's internals.** `lib/main.js` builds a
`vendor/QRCode` instance and reads `qrcode.modules`. The package exports
`generate`, `setErrorLevel` and `error` — nothing else. `modules` is a private
field of a vendored 2011-era QRCode port. Using it means depending on a shape
nobody promised, in a package that would break us silently on a patch release.

**B — reconstruct from the rendered text. Chosen.** The half-block encoding is
lossless by construction. `lib/main.js` maps every vertical module pair to
exactly one of four glyphs:

| glyph | upper module | lower module |
|---|---|---|
| `█` U+2588 | light | light |
| `▀` U+2580 | light | dark |
| `▄` U+2584 | dark | light |
| ` ` | dark | dark |

Four glyphs, four states, no collisions — so the matrix comes back bit for bit
from the published API alone. `src/qr.ts` encodes that table as the string
`" ▄▀█"`, where a glyph's *index* is the module pair: bit 1 upper, bit 0 lower.

The 2×2 packing then uses the sixteen quadrant glyphs, indexed the same way
(top-left 8, top-right 4, bottom-left 2, bottom-right 1):

```
" ▗▖▄▝▐▞▟▘▚▌▙▀▜▛█"
```

Braille was rejected as instructed and would have been wrong anyway: Braille
dots are separated points, not contiguous area. A camera sees gaps between
modules that should be one solid block.

### Polarity and the quiet zone

Worth writing down, because it is the opposite of what you would guess.

**A filled glyph is a *light* QR module.** Terminal text is light on dark, so
qrcode-terminal draws the light modules as ink and lets the dark modules be
background. Every matrix in `qr.ts` follows that convention — `true` means "the
terminal puts ink here" — which is why the constant is `const QUIET_ZONE = true`
and why the border of the printed code is `█`, not blank space.

Getting this backwards inverts the code. It is preserved 1:1 from the small
output; nothing in this change touches a single module's value.

The quiet zone is inherited unchanged from the library: one module left, right
and bottom, one module on top (the top border character's lower half; its upper
half is background, exactly as before). Packing 2×2 rounds the width from 63 to
64 modules, and `litAt` returns `QUIET_ZONE` past the edge — so the extra column
becomes *more* quiet zone, never a stray dark module. This is asserted in the
tests, both as an edge check and as part of the roundtrip.

## Correctness: the matrix roundtrip

Nobody can hold a phone up to CI, so the guarantee is structural. `src/qr.test.ts`

1. asks qrcode-terminal for the half-block drawing of a 300-character URL and
   decodes it back to a module matrix,
2. calls `handoffQr` for the same URL and decodes the quadrant output back to a
   module matrix,
3. compares them **bit for bit**, and requires every extra module the rounding
   introduced to be quiet zone.

The two decoders in the test are written out again rather than imported from
`qr.ts`. A roundtrip through a module's own encoder and its own decoder agrees
with itself no matter how wrong both are.

Test run:

```
$ bun test src/qr.test.ts
 7 pass
 0 fail
 7124 expect() calls
```

### Red proof — the gate has been seen to fail

A gate nobody has watched fail is untested. `litAt` in `src/qr.ts` was
temporarily patched to invert exactly one module:

```ts
if (x === 10 && y === 10) return matrix.lit[y * matrix.width + x] !== true
```

```
 5 pass
 2 fail

(fail) the quadrant packing carries the library's modules unchanged
  expect(firstMismatch(drawn, packed)).toBeNull()
  Received: "module 10,10: expected true"

(fail) the roundtrip comparison notices a single flipped module
  Expected: "module 10,10: expected true"
  Received: null
```

Both directions fire, which is the useful part: the roundtrip caught the single
flipped module, and the flip-detector test went green-side-up because flipping
an already-flipped module restores identity. The patch was reverted and the
suite is back to 7 pass / 0 fail.

The other tests: output ≤ 40×40 with width and height within 2 of each other;
quiet zone lit on all four edges; the pre-existing regression test for the
`qrcode-terminal` namespace import (`import { generate }` reads its
error-correction level off `this` and throws) is kept; and a 4000-character
input logs `qr_render_failed` and returns `null` rather than throwing.

## Gates

| gate | result |
|---|---|
| `./node_modules/.bin/tsc --noEmit` | exit 0, no output |
| `./node_modules/.bin/oxlint` | exit 0, no findings |
| `./node_modules/.bin/biome check .` | exit 0 — `Checked 42 files. Found 2 infos.` Both infos are pre-existing `biome.json` notices (schema pinned at 2.0.0 vs CLI 2.5.11; deprecated `recommended` field). Neither is in a changed file. |
| `bun test src/qr.test.ts` | 7 pass, 0 fail |
| `bun run test` | **118 pass, 0 fail**, 11 files |

No lint rule was relaxed and no complexity budget was raised. The renderer is
split into `drawHalfBlocks`, `halfBlockModules`, `modulesFromHalfBlocks`,
`litAt`, `quadrantLine` and `quadrantsFromModules`, all well under the global
Biome cognitive-complexity ratchet of 28. No `unknown` parameters, no type
assertions, so no `SAFETY:` comments were needed.

## Example output

A 163-character URL (`https://handraise.example/handoff?pt_token=` + 120 `A`s),
kept short so it fits this page. A real 300-character handoff URL renders 32×32
in the same style.

```
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟
▌▄▄▖▙▄█▛▜▚▝█▗▞█▗▞█▗▀▘▌▄▄▖█
▌▌ ▌▌▛▗█▚▞▟▙▀▐▙▀▐ ▘▐▗▌▌ ▌█
▌▙▄▌▙▙▙▗▄█▝▘▄▖▞█▗▜▗▝█▌▙▄▌█
▙▄▄▄▙▚▌▘▘▙▚▌▙▌▙▚▌▙▚▌▙▙▄▄▄█
▙ ▐▙▚▌██▙▞▐▚ ▗▄▝▜▄▝▜▙▝▚▗▌█
▛▞ ▄█▙▞▝▞▌▗▝▟▚▛▟▚▜▞▌▞▟▌▀▜█
▛▗▝▄▙▗▗▖█▐▞▟▄▝▜▄▝▚▖▝▗█▞▙▌█
▌▙▐▄▜▝▌▐▗▀█▗▛▟▚▛▙▐▖▙▘▌█▄▞█
▛▞▄▙ █▐▗▀█▙▛▜▄▝▜▄▝▜▄▀▜▄▛██
▌▞▘▗▐▌▟▀█▙▞▜▚▛▟▚▜▟▘▛█▚█▙▄█
▌▗▘▚▝▐▚▐▌▀▝▌▝▜▄▝▞▙▞▐▟▝▛▐▜█
▌▗ ▄▖█▗▙▚▐▛▖▄▖▛▟▐▖█▜▖▄▖▝██
▙▛ ▙▌▀▛▞▐▗▀▘▙▌▜▄▝▜▄▝▌▙▌▞▗█
▌█▙▗▖▌▚▌▗▄█▚▖▄▚▛▞▙█▝▘▄ ▜▝█
▛▝▀▚▚▘▗▐▞▙▗█▐▙▝▜▄▀▛▙▌▐▙▌▝█
▛█▝▄▞▜▗▀█▙▞▄▗▞▟▚▞█▐▌▝▗▞▜▗█
▛▌▖▄▗▘▀█▙▞▐▘▀▐▄▝▜▄▝▜▌▘▗▌▌█
█▟▐▗█▙▛▙▞▐▗██▗▛▟▘▜▞▙▟▀▗▖▜█
▌▚▞▗▙▞▌▀▝▙▜▞▙▀▜▄▐▚▄▞▄▙▀▄▘█
█▝▜▄▛█▚▐▛▀ █▞█▚▛▄▐▛▄▙▞█▄▐█
▙▄█▙▌ ▐▗▀█▙ ▄▖▝▜▄▝▜▄▘▄▖▜▟█
▌▄▄▖█▌▗▄█▝▞ ▙▌▟▚█▐▘▜ ▙▌▚▄█
▌▌ ▌▛▛▞▙▗▖█▗▖▄▄▝▀▙▞▚▚▖▖▜██
▌▙▄▌▌▞█▙▞▐▗▀▜▄▛▟▐▌▄▜▝▚▗▝▄█
▙▄▄▄▙▟▙▟▟▄██▙██▄▟█▄▟▟█▙▟▄█
```

The three finder patterns are visible at the corners. Decoding the top-left one
by hand confirms the polarity: module (1,2) dark, (2,4) light, (4,4) dark —
the `1:1:3:1:1` ring, with light where light belongs.

## What CI cannot answer — read this before shipping

**One open risk, and it needs a phone.**

Terminal cells are about twice as tall as they are wide. Half-block mode used
1 module per cell width and 2 per cell height, so its modules came out square.
Quadrant mode uses 2 modules per cell in *both* directions — so on screen each
module is now roughly twice as tall as it is wide, and the whole symbol reads as
a 1:2 rectangle rather than a square.

This is an anisotropic affine distortion, which is the kind decoders handle:
finder patterns are located by per-axis `1:1:3:1:1` runs, and the grid sampler
maps the three finders onto a square lattice, absorbing the stretch. Modern
phone scanners (iOS, Google Lens, ZXing) should read it. But "should" is not
"does", and no automated gate in this repo can tell the difference.

**Required before this ships: scan the printed code with a real phone**, ideally
in two terminals with different font metrics. Everything above proves the
modules are right; only a camera proves the picture is readable.

If it fails on a real device, the fallback is cheap and local: `handoffQr`
becomes `drawHalfBlocks(url)` again and the width goes back to 63. Nothing else
in the codebase depends on the packing.

Second, smaller caveat: quadrant blocks (U+2596–U+259F) are less universally
present in monospace fonts than half blocks. A font missing them falls back to
another font and the cells stop aligning, which breaks the code visually. Common
terminal fonts (SF Mono, Menlo, JetBrains Mono, Cascadia, Fira Code) all have
them; a stripped-down container font might not.
