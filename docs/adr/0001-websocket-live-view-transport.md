# 0001 — WebSocket as the live-view transport

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The live view is the product. When the agent raises its hand, the browser's CDP
screencast frames have to reach the human's phone with as little added latency as
possible, and the human's taps and keystrokes have to travel back the other way.
Everything crosses Solari's port-preview edge (`*.preview.getsolari.com`), so the
transport had to be one the preview proxy actually forwards — not one that works
on localhost and dies at the edge.

Spike S1 measured all three plausible options against the real preview URL from a
laptop in Germany. The network floor to the preview edge was ~185 ms, and every
transport hit exactly that floor, so the proxy adds no measurable per-message
overhead.

## Decision

Use a **WebSocket** for the live view: binary frames, one port, one preview
token, served by the same in-guest Node process that serves the handoff HTML.
Frames stream server→client; taps and keys stream client→server on the same
socket.

## Alternatives

- **HTTP polling.** Works and is boringly reliable (S1: 15 sequential polls,
  median 185 ms, no rate limiting). Rejected for frames because frame age =
  latency + poll interval, and it burns one request per frame. Kept only as the
  coarse "is the handoff still open" check.
- **Server-Sent Events (SSE).** A genuine, non-buffered stream through the proxy
  (S1: median 248 ms tick fidelity preserved, `transfer-encoding: chunked`).
  Rejected as the default because it is one-directional — the human's clicks need
  a second channel (a `POST` back) — so it doubles the moving parts for no
  latency win. Retained as a documented fallback for networks that block `wss://`.

WebSocket won on latency, on being bidirectional over a single channel, and on
carrying 100 KB frames without the proxy buffering server→client push.

## Consequences

- **The 60 s idle cut must be designed around.** S1 measured the preview proxy
  killing a silent WebSocket at 59 993 ms with close code 1006 (abnormal, no
  close frame). A live view pushing frames never notices this — but a paused,
  fully-loaded handoff page (exactly the state while a human reads a code off
  another device) does. Mitigation: an application-level heartbeat every 20 s in
  both directions, and treat close code 1006 as "reconnect", not "the human left".
- **The preview token lives in the URL query, never in a header.** Header auth is
  refused (401). The first request carries `?pt_token=…`; the edge then sets a
  `__pt_preview` cookie that authenticates the page's later sub-requests and the
  `wss://` upgrade. A non-browser client keeps no cookie and must append the token
  to every URL itself.
- **Everything stays on one port.** One token = one port = one subdomain = one
  cookie grant, so the page, the frame stream and the input channel share a single
  listener. This halves the auth surface and is why the in-guest server multiplexes
  `/ws` and the HTML on one port.
- Follow-up: SSE fallback selection is not implemented in v1; it is documented as
  the escape hatch for `wss://`-blocking networks.
