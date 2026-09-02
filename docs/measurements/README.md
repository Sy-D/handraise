# Platform measurements

Four questions had to be answered against the live Solari API before handraise
could be designed at all, and one more before the QR passthrough was built.
These are the write-ups, kept as evidence: the numbers are unchanged from the
day they were taken, and the ADRs in [`../adr/`](../adr/) cite them.

| # | What was measured | When | How |
|---|---|---|---|
| [01](01-preview-transport.md) | WebSocket, SSE and polling through the port-preview proxy; its 60 s idle kill; its token auth | 2026-09-01 | Probe server in a `base` sandbox, driven from a laptop in Germany |
| [02](02-cdp-screencast.md) | CDP screencast over the SDK: framerate, frame size, bandwidth, delivery lag | 2026-09-01 | Four runs, three browser sessions, six scenarios |
| [03](03-cdp-input-injection.md) | CDP input injection: mouse, text, keys, touch, scroll, `isTrusted`, coordinate mapping | 2026-09-01 | Every result read back from page state, never from "no error was thrown" |
| [04](04-browser-session-lifetime.md) | Whether a browser session survives a multi-minute human pause | 2026-09-01 | Six browser sessions and five sandboxes, idle vs. pinged vs. streaming |
| [05](05-qr.md) | Reading a QR code off the page: `BarcodeDetector`, screenshot vs. cast frame, decode latency | 2026-09-02 | One cloud browser session and local Chromium; reproducible with `scripts/measure-qr-decode.ts` |

**04 is the one to read first.** It is why the default wait is five minutes,
why there is no keep-alive pinger, why `disconnected` is an outcome rather than
an exception, and why `storageState` is captured on handback.

The probe scripts behind 01-04 were throwaway experiments and are not carried
in the tree; the repository history has them. 05 is reproducible from
[`scripts/measure-qr-decode.ts`](../../scripts/measure-qr-decode.ts), which also
regenerates the decoder's test fixture. Timing benchmarks of the
shipped library live in [`../../benchmarks/`](../../benchmarks/).
