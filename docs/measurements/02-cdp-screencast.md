# 02 — CDP screencast on a Solari cloud browser

**What was measured, and why.** The live view is a CDP screencast. This
document establishes that the screencast works through the Solari SDK at all,
and what it costs in framerate, payload size and bandwidth — the numbers the
README quotes for live-view bandwidth. Measured 2026-09-01.

**Question.** Does `Page.startScreencast` work over the Solari SDK's Playwright-compatible
connection, and at what framerate and payload size?

**Answer.** Yes. It works with no workaround. `@solarisdk/browser` wraps
`patchright-core` (a Playwright fork), so `page.context().newCDPSession(page)` exists and
speaks raw CDP through the SDK's loopback proxy. No `connectOverCDP`, no `wsEndpoint`
plumbing, no second connection.

Measured 2026-09-01 against `us-west`, Chromium `151.0.7922.34`, SDK `@solarisdk/browser@0.1.2`,
sessions launched with `{ stealth: true }`, viewport 1280x800, target `https://github.com/login`
and `https://en.wikipedia.org/wiki/Web_browser`.

---

## 1. Measurements

Four runs, three browser sessions, ~4 minutes of session time total.

| # | Scenario | Profile | fps | KB/frame (mean) | KB/frame (p95) | KB/s | Mbit/s |
|---|---|---|---|---|---|---|---|
| A | Typing in the GitHub login form | q60 / 800px | **6.54** | 12.10 | 12.50 | **79** | 0.63 |
| E | Idle, caret blinking in a focused field | q60 / 800px | **1.86** | 12.48 | 12.49 | **23** | 0.19 |
| B | Continuous rAF scroll (worst case) | q60 / 800px | **12.96** | 53.05 | 62.09 | **687** | 5.5 |
| C | Continuous rAF scroll (worst case) | q40 / 480px | **14.01** | 14.09 | 15.77 | **197** | 1.6 |
| F | Continuous rAF scroll, `everyNthFrame: 2` | q60 / 800px | 11.37 | 55.92 | 64.23 | 636 | 5.1 |
| D | Continuous rAF scroll, **frames not acked** | q60 / 800px | **0.36** | 49.70 | — | 18 | 0.14 |

Sizes are base64-decoded JPEG bytes. On the wire the CDP payload is base64, so add ~33%.

Other numbers, consistent across every run:

- **Time to first frame after `startScreencast`: 194–323 ms.**
- **Median frame delivery lag: 90–97 ms** (local arrival time minus the Chromium
  `metadata.timestamp`). This includes any clock skew between the cloud VM and the local
  machine, so treat it as an upper bound on one-way latency to `us-west`, not a clean RTT.
  Its stability across four sessions suggests it is mostly real network time.
- **Median inter-frame gap under motion: 76–83 ms** → the ceiling is ~13 fps, not 60.
- Max observed gap under motion: 219–543 ms. Plan for a stall of half a second.

### Quality profiles compared

The mobile profile is **3.5x cheaper** than the desktop profile at the same framerate
(197 vs 687 KB/s). Frame size, not framerate, is the lever — Chromium sends a **full JPEG
every frame**, never a delta, so bitrate tracks resolution and quality, not how much of
the page actually changed.

A 800x500 q60 frame of the GitHub login page is 11.6 KB and fully legible, including the
form labels and footer links. q60 at 800px is comfortable;
there is room to go lower.

### The realistic HITL number

Scenarios A and E are what a real handoff looks like: a human reads a page and types a
2FA code. That costs **23–80 KB/s (0.2–0.6 Mbit/s)**. Only continuous full-page motion
reaches 687 KB/s, and a person doing a 2FA challenge does not scroll continuously.

Budget the pump for ~80 KB/s steady state and ~700 KB/s burst. If the relay hop is
constrained, the mobile profile caps the burst at 197 KB/s with no loss of legibility for
a form.

---

## 2. Working code

Exactly what ran. Copy-pasteable.

```ts
import { Solari } from "@solarisdk/browser"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const browser = await solari.launch({ stealth: true })

try {
  // Use the session's existing context/page — browser.newPage() opens a NEW
  // context, and you want to cast the page the agent is actually driving.
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = context.pages()[0] ?? (await context.newPage())

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("https://github.com/login", { waitUntil: "domcontentloaded" })

  // >>> THE CDP PATH <<<
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Page.enable")

  cdp.on("Page.screencastFrame", (frame) => {
    const jpeg = Buffer.from(frame.data, "base64")   // full JPEG, not a delta
    // frame.metadata: { deviceWidth, deviceHeight, scrollOffsetX, scrollOffsetY,
    //                   pageScaleFactor, offsetTop, timestamp }

    send(jpeg)   // ... push to your viewer ...

    // MANDATORY. Without this the stream dies after ~3 frames.
    // Ack *after* your downstream write — see "ack is your flow control" below.
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {})
  })

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,        // 40 for the mobile profile
    maxWidth: 800,      // 480 for the mobile profile
    maxHeight: 1400,
    everyNthFrame: 1,
  })

  // ... handoff happens ...

  await cdp.send("Page.stopScreencast")
} finally {
  await browser.close()   // releases the Solari session
  await solari.close()    // MANDATORY — otherwise the process never exits
}
```

TypeScript note: `patchright-core` types are not re-exported by `@solarisdk/browser`, so
the `page` and `cdp` objects come back loosely typed. In these probes they were narrowed to
a hand-written `CdpSession` interface (`{ send, on, off }`) rather than `any`. Do the same
in `src/` — do not widen to `any`.

---

## 3. Traps

**1. `Page.screencastFrameAck` is mandatory, and it is stronger than "the stream slows".**
Control run D, under identical continuous motion, produced **3 frames in 8.3 seconds**
(0.36 fps) versus 199 frames (12.96 fps) with acks. Chromium allows a very small number of
unacknowledged frames and then stops entirely. If your viewer ever appears frozen, this is
the first thing to check.

**2. Turn that trap into the design: ack is your flow control.** There is no bitrate
setting in the CDP screencast API. The ack *is* the throttle. Ack immediately and you get
max framerate; ack only after the frame has been flushed to the viewer socket (e.g. when
`ws.bufferedAmount` is below a threshold) and Chromium paces itself to whatever the
downstream link can carry, with no queue growth and no frame ever going stale in a buffer.
This is the recommended pump design for handraise.

**3. `everyNthFrame` is not a usable throttle.** `everyNthFrame: 2` gave 11.37 fps versus
12.96 fps unthrottled — a 12% reduction, not the expected 50%. It counts compositor frames,
which is not the thing that limits you here. Do not use it for rate control. Use ack pacing
(trap 2) or lower `maxWidth` / `quality`.

**4. Measure only on a page that actually repaints.** The first run measured a static
GitHub login page and reported 2.06 fps / 11 KB — meaningless numbers, because Chromium
only emits a frame on repaint. The tell was that min and max frame size were nearly
identical (9.09 vs 11.38 KB) and `scrollOffsetY` stayed 0. Any benchmark of this API needs
forced motion; these runs drive a `requestAnimationFrame` scroll loop via `page.evaluate`.

**5. Idle is not zero, and idle is not stable.** Scenario E measured 1.86 fps with only
**two distinct frame sizes** — that is the text caret blinking in the focused input. A
blinking cursor alone costs 23 KB/s at the desktop profile. A page with an animated spinner
or a carousel will idle far higher. Do not assume an idle viewer is free.

**6. The frame is scaled; the metadata is not.** With viewport 1280x800 and `maxWidth: 800`,
the JPEG is **800x500** (scaled by `maxWidth / viewportWidth` = 0.625), but
`metadata.deviceWidth` / `deviceHeight` still report **1280x800** — the CSS viewport, not
the image. For input forwarding ([measurement 03](03-cdp-input-injection.md)), map viewer coordinates as:

```
pageX = imgX * (metadata.deviceWidth  / jpegWidth)
pageY = imgY * (metadata.deviceHeight / jpegHeight)
```

Do **not** add `scrollOffsetX/Y`: `Input.dispatchMouseEvent` takes viewport-relative
coordinates. `scrollOffsetY` was 0 on GitHub and 3072 on the scrolled Wikipedia page, so it
would corrupt every click if added. `offsetTop` was 0 throughout (headless has no browser
top controls). Simplest robust client rule: render the JPEG at any CSS size and map by the
ratio of `metadata.deviceWidth` to the rendered CSS width.

**7. The screencast survives cross-origin navigation.** Verified: started the cast on
`github.com/login`, navigated to `en.wikipedia.org` without touching the cast, and kept
receiving frames (10 frames after navigation, no restart). You do **not** need to re-arm on
every `framenavigated`. The CDP session is bound to the page target, which survives the
navigation.

**8. `browser.newPage()` opens a new *context*.** The SDK docs say so explicitly. If the
agent is driving the session's default page and you cast a `newPage()`, you will stream a
blank tab and see nothing wrong in the logs. Always take `contexts()[0].pages()[0]`.

**9. `solari.close()` is not optional.** The SDK runs a loopback proxy; without
`solari.close()` the process hangs forever after the work is done. `browser.close()` alone
is not enough. Both belong in `finally`.

**10. Naming collision.** `frame.sessionId` in the screencast event is a **number** that
identifies the screencast frame sequence. It has nothing to do with the Solari session id
or the CDP session id. Ack with exactly the value from the frame.

**11. `Page.enable` before `startScreencast`.** Every run sent it first and every run
worked. It was not tested without, so it is unverified whether it is strictly required —
keep it, it costs one round trip.

---

## 4. Recommendation for the handraise pump

- **Default profile: `jpeg`, `quality: 60`, `maxWidth: 800`.** Legible for form-filling at
  ~12 KB/frame; measured 79 KB/s while typing.
- **Mobile/constrained profile: `quality: 40`, `maxWidth: 480`.** 3.5x cheaper under load
  (197 vs 687 KB/s) and still readable for a login form. Good default if the relay hop
  through the sandbox turns out to be the bottleneck.
- **Pace with ack, never with `everyNthFrame`.** Hold the ack until the frame is written
  downstream. This gives adaptive framerate for free and bounds memory.
- **Expect ~13 fps ceiling and ~90 ms delivery lag.** That is fine for a human solving 2FA.
  It is not a gaming-grade stream and should not be sold as one.
- **Budget 80 KB/s steady, 700 KB/s burst** at the desktop profile.

---

## 5. How this was run

Four throwaway scripts against three browser sessions. Run 1 was the first CDP
path probe; its *numbers* are invalid (static page, see trap 4) but its failure
mode is the reason trap 4 is written down. Run 2 covered scenarios B, C and D
(motion desktop, motion mobile, no-ack control), run 3 covered A, E and F
(typing, idle, `everyNthFrame: 2`), and run 4 measured JPEG pixel dimensions
and navigation survival. The scripts and their raw JSON output were experiments
rather than product and are not carried in the tree; the repository history has
them. One artefact did stay: the 800x500 q60 sample frame of the GitHub login
page, 11.6 KB, which is now the fixture behind
`src/core/screencast.test.ts`.
