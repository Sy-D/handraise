# UI e2e test — the phone page in a real Chromium

Closes the W8 / Sol#9 gap: until now nothing exercised `src/relay/guest/server.js`'s
browser half (canvas render, `toFrame()` Canvas→frame-pixel maths, the keystroke
diff, `showFrame()` JPEG decode, overlays, reconnect). The old `e2e/human-sim.ts`
is a Node `ws` client that computes tap pixels itself, so the code the human
actually operates never ran under test.

## What was added

- `e2e/ui.spec.ts` — a `bun:test` spec that loads the real handoff page in a real
  headless Chromium (`playwright-core`'s `chromium.launch()`) and drives it through
  the DOM. No Solari, no API key, no network — safe as a CI gate.

No source files were changed. `package.json` was not touched: `playwright-core` is
already a devDependency and its Chromium is installed, and `bun test` is the runner,
so no `playwright` test-runner package was needed.

## How it is built

- **Relay**: the real `src/relay/guest/server.js` is spawned per test via
  `spawn(process.execPath, [SERVER_PATH, "0", AGENT_KEY])` — port `0` lets the OS
  pick, read back from the `relay listening` log line, exactly as `relay.test.ts`
  does. An `AGENT_KEY` is set, so the agent connection also exercises the `?k=` auth.
- **Agent side**: a Node `ws` client connects `role=agent&k=<key>`, sends staged
  frames/state/ended, and collects the human→agent messages in an inbox with a
  `next()` awaiter (same pattern as `relay.test.ts`).
- **Human side**: real Chromium loads `http://127.0.0.1:<port>/`. The page builds its
  own `role=human` WebSocket relative to the URL (no query needed), so nothing is
  faked. Viewport is pinned to `390×844`, `deviceScaleFactor: 1`, so canvas geometry
  is deterministic.
- **Frame**: one `320×200` JPEG (deliberately landscape vs. the portrait canvas, so
  the vertical letterbox bars in `toFrame()` are genuinely exercised) is generated
  once by Chromium (`canvas.toDataURL`), the data-URL prefix stripped, and sent by the
  agent. The relay's late-human replay buffer means the frame is delivered whether or
  not the page's socket has finished connecting, which removes a race. The page decodes
  it via `showFrame()` and the test waits until `#placeholder` is hidden (set in
  `img.onload`).

## What it covers (7 tests, all green)

1. **Tap → exact frame pixel.** Reads the canvas `boundingBox()`, computes the
   letterbox (`scale = min(rectW/320, rectH/200)`, centred) and the expected `fx/fy`
   **independently in the test**, clicks `canvas.click({position})`, and asserts the
   agent receives `{type:"tap", fx, fy}` within ±1 px. This validates the real
   `toFrame()` including letterboxing, in the real layout.
2. **Keyboard — char / Enter / Backspace(empty).** Types `7` → `{char:"7"}`; Enter →
   `{key:"Enter"}` (clears the field); Backspace on the now-empty field →
   `{key:"Backspace"}` (the keydown empty-field path).
3. **Multi-char diff.** Types `ab` → `{char:"a"}`, `{char:"b"}`; one Backspace via the
   input diff → `{key:"Backspace"}`.
4. **Hand back** → agent `{type:"handback"}`, then the "Handed back" overlay appears.
5. **Abort** → agent `{type:"abort"}`, then the "Aborted" overlay appears.
6. **Ended overlay.** Agent sends `{type:"ended", outcome:"disconnected"}` → page shows
   "Session lost" / "The browser session died. The agent knows."
7. **Reconnect (Sol#7) + single live human.** After a frame renders, a second
   `role=human` socket displaces the page's socket (the relay sends the page a close
   frame — the same class of event as the proxy's 60 s 1006). The test asserts the
   status dot goes `waiting`, the page reconnects on its own and the dot returns to
   live, a fresh `state` message reaches the reconnected socket, and the relay is left
   holding **exactly one** human connection (`openHumans()` counts connect/close log
   events → 1), proving no overlapping sockets survived.

Every test also asserts **zero console errors and zero page errors** on the page
(`page.on("console"|"pageerror")`), which guards against untrusted-event / runtime
breakage.

### Reconnect caveat

The reconnect is triggered by displacing the human role with a second socket rather
than by the preview proxy's real 1006, which cannot be produced locally without the
proxy. This still drives the page's `onclose → scheduleReconnect → connect()` path,
the generation guard, and the single-socket invariant. It was not flaky across runs.

## Red-seen proof

Requirement: watch an assertion fail before trusting it. The tap-pixel expectation was
temporarily offset by `+40`:

```
const expectedFx = Math.round(((px - frame.x) * FRAME_W) / frame.w) + 40
```

Result — the tap test failed exactly as intended (the ±1 tolerance rejected the 40 px
error), then reverted to green:

```
expect(received).toBeLessThanOrEqual(expected)
Expected: <= 1
Received: 40
(fail) a tap maps to the exact frame pixel under the finger
 6 pass  1 fail
```

This confirms the assertion measures the real coordinate mapping and is not
self-satisfying.

## Gate outputs

Run from the repo root
(`/Users/simondoba/Documents/Projekte/Development/Projects/solaris-use-case/handraise`):

- `./node_modules/.bin/tsc --noEmit` → exit 0
- `./node_modules/.bin/oxlint` (incl. anti-slop) → exit 0
- `./node_modules/.bin/biome check .` → exit 0
- `bun run lint` (biome + oxlint + embed-guest --check) → exit 0
- `bun test e2e/ui.spec.ts` → 7 pass, 0 fail
- `bun test src/ test-app/` (existing suites) → 84 pass, 0 fail (unchanged)

Command to run the new test:

```
bun test e2e/ui.spec.ts
```

## Real UI bugs found

None. The browser page behaved correctly against every assertion — tap coordinates,
keystroke diff, overlays, ended states and reconnect all matched the protocol. No
change was made to `src/**`.
