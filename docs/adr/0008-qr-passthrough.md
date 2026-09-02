# 0008 — QR passthrough: the agent reads the code, the phone gets the link

- **Status:** accepted
- **Date:** 2026-09-02

## Context

A growing class of walls asks for a *second device*. reCAPTCHA's scan-to-verify
variant, a WhatsApp Web login, an authenticator enrolment, a payment code: the
site draws a QR code and says "scan this with your phone".

handraise's whole answer to a wall is to put a human on a phone in front of the
page. That answer breaks here, and it breaks in a way that is funny once and
then expensive: the human is holding the phone the site is asking for, and the
code is on that phone's screen. **A phone cannot scan itself.** Before this,
the only way through was a second device — which defeats the point of a handoff
that was supposed to take twenty seconds.

The information is right there. The code is a string, usually a URL, and the
agent has the page it is drawn on.

## Decision

**A human-initiated scan.** The phone gains one control in the key bar,
`Scan QR`. It sends `{ "type": "scanqr" }`; the agent takes a fresh
full-resolution `page.screenshot({ type: "png" })`, decodes it, and answers
`{ "type": "links", "links": [...], "source": "qr" }`. The phone shows a sheet
with what each code said, an **Open in new tab** button for the schemes below,
and **Copy** for everything.

Five decisions inside that, each one measured or argued rather than assumed
([Measurement 05](../measurements/05-qr.md)).

**Decode in the agent process, not in the page.** `BarcodeDetector` does not
exist in Solari's Chromium (measured, §1), so "let the browser do it" was not
available. It would have been the wrong shape anyway: running the decode via
`page.evaluate` puts handraise's code in the realm of whatever site the agent
got stuck on, where the page can replace `BarcodeDetector` and answer with a
link of its choosing — a link a human is then invited to open on their phone.
The decode is `jsqr` plus a PNG decoder written against `node:zlib`
(`src/core/png.ts`, ~180 lines): one new pure-JavaScript dependency, no native
build on any platform an agent runs on.

**A fresh screenshot, not the cast frame.** The phone is already looking at a
picture of the page, and reusing it would cost nothing. It is not good enough:
the cast is 800 px wide at JPEG quality 60, chosen for a form field, and it
fails on symbols the screenshot reads (measured, §3 — 180 px and 120 px fail
from the frame and decode from the screenshot, with a luck-dependent band in
between). The screenshot costs 239 ms p50, which is the price of the difference
between "works" and "works when the site draws its code large".

**On request, and rate-limited.** No auto-scan of every frame: a scan is a
screenshot plus a decode on a stream that already paces itself to a phone's
link, and 99% of pages have no code on them. One scan per 2 s, enforced in the
core rather than on the phone — the handoff URL is a bearer credential and the
socket behind it is reachable from any HTTP client, so the phone's own floor is
a courtesy, not a limit.

**An allowlist of openable schemes, checked twice.** `http:`, `https:`, `tel:`,
`mailto:`, `otpauth:` may be opened; everything else is shown as text with a
Copy button and no anchor. An allowlist rather than a blocklist because the
interesting half is the half nobody thinks of: `javascript:` and `data:` are
the two everyone remembers, and `intent:`, `file:`, `content:` and whatever a
phone browser ships next year are the ones a blocklist would have let through.
The agent classifies, and the phone checks the scheme again before it builds
the anchor — the `kind` field crosses a socket a stranger holding the link can
write to, so the page must not have to trust it. The anchor carries
`rel="noopener noreferrer"`: the opened site gets no handle on the tab holding
a live handoff, and is not told the handoff URL it came from.

**The agent never opens anything.** It reads and classifies; the fetching is
the human's, in their own browser. An agent process that followed a URL out of
a hostile page would be an SSRF primitive with the agent's own network position.

**And it never blocks on the decode.** The PNG decode plus up to three `jsQR`
passes is pure synchronous CPU: on a 3840x2160 screenshot it held the event
loop for **2132 ms, during which a 5 ms heartbeat did not tick once**
(measured, §6). That loop is the frame pump, the human's handback, the timeout
and the browser's disconnect. So the work runs in a worker thread —
`dist/qr-worker.js`, started at the first scan of a handoff, terminated when it
settles — and the same decode costs the loop one millisecond. The worker also
buys the only lever there is over a decode that will not finish: a six-second
deadline and `terminate()`.

**Every size is bounded before anything is allocated.** A PNG's header is the
only part of it that is cheap to believe, and everything downstream is sized
from it, so it is checked first: 8192 pixels a side, 24 megapixels in total, 32
MB of compressed image data, and the exact inflated length the header implies
passed to `inflateSync` as `maxOutputLength` and then required to match. The 2x
retry allocates four times the source, so it is refused above 40 megapixels
rather than taking a half-gigabyte step for a code it probably cannot read.

Takeover only. An approval is one screenshot of a moment, not a live page —
there is nothing to scan and nothing a scan could change.

## Alternatives

**Auto-scan every cast frame.** Rejected on cost and on false positives: a
decode per frame on a stream that runs at ~14 fps, to answer a question almost
every page answers "no" to, and a sheet that opens itself while the human is
typing.

**Decode the cast frame on the phone.** Attractive — no protocol change, no
agent work, and the phone already has `BarcodeDetector` on iOS. Rejected on the
same measurement that killed reusing the frame in the agent (§3): the picture
the phone holds is the one that does not decode. It would also have shipped a
feature whose reliability depended on which phone the human happened to hold.

**Send a screenshot to the phone and let it decode.** The phone would need the
full-resolution PNG — 43.7 KB here, more on a real page — over a link that is
already pacing a live cast, to run a decode that costs 54 ms in Node. All of
the bandwidth, none of the control, and still phone-dependent.

**Let the agent open the link itself.** It is the obvious shortcut and it is
wrong twice: the site is asking for a *different device* on purpose, so opening
it from the browser that showed the code defeats the check it is making; and it
turns any page the agent lands on into a request the agent will make.

**`pngjs` instead of a hand-written PNG decoder.** A second dependency to read
four colour types at one bit depth. The decoder is ~180 lines against
`node:zlib`, refuses everything it has not been fed, and is tested against a
real cloud-browser screenshot.

## Consequences

- One new runtime dependency: `jsqr` (pure JavaScript, no dependencies of its
  own). `qrcode` is added as a **dev** dependency, for the test app's page and
  for generating test images.
- The protocol grows one message in each direction (`scanqr`, `links`). The
  wide event grows `qrScans` and `qrHits`; `qrScans - qrHits` is the number
  worth watching, because it is either a page with no code or a decode that
  failed.
- `scanQrLinks(png)` and `OPENABLE_SCHEMES` are exported: an agent that wants
  to read a code without a human can, and the dist smoke uses it to prove the
  CommonJS interop survives bundling — the failure mode that once broke
  `qrcode-terminal` in `dist` while every bun test stayed green.
- **A symbol below ~120 CSS px will not decode** (§3). The sheet says nothing
  was found; the human can zoom or scroll the remote page and scan again.
- **One decode is not enough.** A code the page drew at a resampled size can be
  large, centred and sharp and still not be *located*, because `jsQR`
  thresholds in fixed 8x8 blocks and a 4.9-pixel module grid straddles them
  (§5). `scanImage` therefore looks up to three times — as it came, at 2x, then
  four overlapping corners — and only when the previous look found nothing. A
  page with no code pays all three, about 320 ms of CPU. This was found by the
  live e2e after every offline test had passed, which is the argument for
  having one.
- **Two codes on one screen** need the tiled second pass to be found at all
  (§4). Three or more are not attempted: `MAX_CODES` is 2.
- **reCAPTCHA itself is untested.** Its demo never served the QR variant
  (§7). The mechanism is proven end to end against the test app's `/qr` page in
  the live e2e, and the README says as much rather than implying more.
- A hostile page can put any string in a QR code and have a human read it on a
  phone. That is the residual risk, and it is bounded by the allowlist, by the
  page applying the whole rule again itself, by `noreferrer`, and by the fact
  that opening it is an explicit act by a person who can see the whole link —
  which is why the sheet never truncates it.

  **"The whole link" has to mean the link that opens.** A raw payload beside an
  anchor that resolves it is two strings, and the difference is invisible:
  `https://аpple.com` with a Cyrillic а reads as apple.com and lands on
  `xn--pple-43d.com`, and a U+202E override reverses the visible tail of a
  path. So an openable link is shown as `new URL(text).href` — punycode host,
  percent-encoded overrides — and the card says so when that differs from the
  payload. Copy takes the same string. Nothing is truncated, so the argument
  above still holds; it just stopped being false.

- **`tel:` and `otpauth:` are not openable, and that is a reversal.** They were
  on the allowlist because a device-change flow genuinely uses them. They are
  off it because both are *actions* rather than pages, and both are one tap:
  `tel:*21*1234567890%23` is a call-forwarding sequence handed to a dialler,
  and an `otpauth:` URI enrols an attacker-chosen TOTP secret in the human's
  authenticator — the feature working exactly as designed, and exactly what a
  phisher wants from it. Neither is worth a tap taken from a page nobody
  vetted. They are still decoded, still shown in full and still copyable, under
  a label that says what they are ("Phone number", "Authenticator secret") so
  the human hands them to the right app deliberately. Only `http`, `https` and
  `mailto` keep an Open button.

- **The decode no longer blocks the event loop, and `scanQrLinks` still does.**
  The exported function is synchronous by design — a caller's own thread is
  their business — and the handoff path uses `createQrScanner()`, which is the
  same decode on a worker. Both are exported; the ADR's argument only covers
  the second.
- **The relay's backpressure pause delays, it does not drop.** When the agent's
  socket is full the relay stops reading the human's, having first written the
  message that triggered it. Anything already behind that in the human's socket
  buffer — a handback among them — waits for the agent to drain, or for it to
  go away, at which point `closePeer` resumes the human. Bounded by
  drain-or-close and never lost, but not instant. Separating terminal messages
  out would mean parsing before the flow-control decision, which is exactly the
  work the 4 KiB pre-parse cap exists to avoid.

- **A worker is a file, not a function.** `dist/qr-worker.js` is resolved at
  runtime with `new URL("./qr-worker.js", import.meta.url)`, so a consumer who
  re-bundles handraise has to keep it next to the entry it resolves from. The
  dist smoke runs the worker under node against the shipped artifact, because
  this is the one part of the package a bundler can silently drop.

- **`jsqr` is a bet, not just a dependency**, and it is pinned to exactly
  `1.4.0` rather than a range. That release is from January 2021 and
  `cozmo/jsQR` is archived. The bet is taken knowingly: zero transitive
  dependencies, Apache-2.0, pure JavaScript with no `eval`, so a bad decode is
  a crash or a stall and never an execution primitive — and it now runs in a
  worker, where a stall is a terminated thread. The alternatives in the
  ecosystem are WASM or native, which trades an archived dependency for a build
  step on every platform an agent runs on.

  **What would trigger a fork or a replacement:** a decode that is wrong rather
  than absent (a payload that is not what the symbol encodes), a crash that the
  worker deadline cannot contain, or a CVE. The committed fixtures and the dist
  smoke are the corpus a fork would have to keep passing, and `scanImage` is
  the only seam it would have to fit.
