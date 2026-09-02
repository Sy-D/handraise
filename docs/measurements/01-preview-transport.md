# 01 — Preview transport: WebSocket, SSE, polling

**What was measured, and why.** The handoff UI is served from a Solari sandbox
through the port-preview proxy. Before anything could be built on it, the proxy
had to be characterised: which transports survive it, what they cost, when it
kills an idle socket, and how its token auth behaves. The answers are the
foundation of [ADR 0001](../adr/0001-websocket-live-view-transport.md) and
[ADR 0002](../adr/0002-relay-in-solari-sandbox.md).

Measured 2026-09-01. SDK `@solarisdk/sdk@0.1.2`, template `base`, region as
served by `api.getsolari.com` default. All numbers measured from a laptop in
Germany; the RTT floor to the preview edge was ~185 ms and every transport hit
exactly that floor, so treat 185 ms as "network", not "proxy overhead".

**Recommendation: use WebSocket.** It works, it is the lowest-latency option, it
carries 100 KB frames, and server→client push is not buffered. SSE is a fully
working fallback (same push behaviour, ~250 ms tick fidelity preserved). Polling
works but is strictly worse for a live view — it adds the poll interval to every
frame's age and burns a request per frame.

---

## 1. Results

### WebSocket — works

| Metric | Value |
|---|---|
| `wss://` upgrade | 101, no proxy interference |
| Handshake (connect → open) | 579 ms |
| Echo RTT, 10 msgs, ~40 B | median **185 ms**, min 185, max 185 |
| Echo of 100 KB payload | round-trip 1181 ms, bytes intact (102400 in = 102400 out) |
| Unsolicited server→client push | received, no buffering |
| Socket with 500 ms server pushes | alive at 45 s, 88 pushes, no proxy close |
| Socket with **zero traffic** | **killed at 59 993 ms**, close code 1006 "Connection ended" |

RTT variance was zero across ten messages, which means the proxy is a plain TCP
relay after the upgrade — no per-message processing.

**The 60 s idle cut is the one thing you must design around.** Any traffic
resets it — the 500 ms push socket ran happily — but a silent socket dies at
almost exactly 60 s with an abnormal close (1006, no close frame). Send an
application-level heartbeat every **20–25 s** in both directions and reconnect on
1006. Do not rely on `ws`'s built-in ping/pong alone unless you have verified it
fires inside 60 s; an explicit timer is cheaper to reason about.

### SSE — works, and is genuinely streamed

| Metric | Value |
|---|---|
| Status / content-type | 200, `text/event-stream`, `transfer-encoding: chunked` |
| Response headers received | 274 ms |
| First byte | 277 ms |
| Server tick interval | 250 ms |
| Observed gaps between events | 248, 331, 204, 220, 248, 251, 252 ms — **median 248 ms** |
| 40 KB-per-event stream | 5 events / 205 080 B in 1559 ms (≈1000 ms of that is the server's own delay) |

The gaps match the server's 250 ms interval, so the proxy does **not** buffer the
stream and does not wait for the response to complete. `x-accel-buffering: no`
was set on the response; it was not proven to be *necessary*, but keep it — it
costs nothing and protects against a proxy change.

### HTTP polling — works, boringly reliable

15 sequential `GET /ping`: **median 185 ms**, min 183, p90 193, max 269. No
failures, no rate limiting. Same latency floor as WS, so polling is not slower
*per request* — it is only worse because frame age = latency + poll interval.

### Cold start — 2.9 s from `create()` to a 200 through the public URL

| Step | ms |
|---|---|
| `sandboxes.create({ template: "base" })` | 664 |
| `sandbox.connect()` | 613 |
| `files.write("/tmp/server.js")` (5 KB) | 194 |
| spawn two `node` servers via `sh -c "nohup … &"` | 392 |
| `previewUrl(3000)` + `previewUrl(3001)` | 455 |
| first HTTP 200 through the preview URL | — |
| **total create → first 200** | **2925 ms** |

The very first poll attempt already returned 200 (`statusSequence: [200]`), so no
retry loop was actually needed. Still keep a short readiness poll: the timing
depends on how heavy your in-guest server is.

For handraise UX this means: from "agent is stuck" to "phone can load the page"
is about **3 seconds**, plus however long it takes the human to look at their
phone. The transport is not the bottleneck.

---

## 2. `base` template contents

```
sh       /usr/bin/sh          bash    /usr/bin/bash
node     /usr/bin/node        v18.20.4
npm      /usr/bin/npm         npx     /usr/bin/npx
python3  /usr/bin/python3     3.11.2 (full stdlib: ssl, socket, hashlib, base64, http.server)
pip3     /usr/bin/pip3
curl     /usr/bin/curl
```

Missing: `bun`, `nc`, `socat`.
OS: Debian GNU/Linux 12 (bookworm), kernel 6.6.30, x86_64, running as **root**.

Node 18 is present, so the in-guest relay needs **no install step** — write one
`.js` file and run it. Do not add an `npm install ws`: a raw RFC6455 server is
~70 lines of stdlib and removes a network dependency from the critical path.
The probe server used here was exactly that.

---

## 3. The preview URL's auth model — read this before building the UI

`previewUrl(port)` returns:

```json
{
  "url": "https://<sandbox-hash>-<port>.preview.getsolari.com?pt_token=<jwt>",
  "token": "<same jwt>"
}
```

* The token is **required as the `pt_token` query parameter on the first
  request**. Without it: `401 invalid preview token`, with a body that literally
  says `Present it as ?pt_token=<token>`. A bad token is also 401.
* The token works on **any path** (`/anything/deep/path?pt_token=…` → 200).
* **A successful request sets a `__pt_preview` cookie, and that cookie alone
  authenticates every later request.** Verified: authenticate once (200), keep
  the cookie jar, then request the same path with **no** `pt_token` → **200**.
  This is what makes a normal browser UI possible; see §5.2.
* Header-based auth is **not** accepted: `Authorization: Bearer <token>` → 401,
  `X-Pt-Token: <token>` → 401. Query param or cookie, nothing else. That rules
  out passing the token from a non-browser client via headers.
* The token payload is base64 JSON: `{ sandboxId, port, orgId, exp }`. Observed
  lifetime: **exp = issue time + 1 hour** (3 601 s). One token is scoped to one
  port — `previewUrl(3001)` returns a different token with `port: 3001`.
* Each port gets its **own subdomain** (`<hash>-3000.` / `<hash>-3001.`), and
  **multiple ports work simultaneously** — both servers answered on the same
  sandbox. The `<hash>` part is stable per sandbox; only the port prefix changes.
* The edge is an AWS ALB. Responses carry `AWSALB` / `AWSALBCORS` (load-balancer
  stickiness, not auth) alongside the real `__pt_preview` auth cookie.

Net effect for handraise: put the token in the URL you hand to the phone, and
everything the page does afterwards — relative assets, `fetch`, the WebSocket —
is carried by the cookie. No token plumbing inside the page is required.

---

## 4. Working code

### 4.1 In-guest server — WS + SSE + HTTP on one port

The probe server (Node 18, stdlib only, no deps) serves
`/ws`, `/sse`, `/sse-big`, `/ping` on a single port. The parts that matter:

```js
// upgrade handler — this is all the proxy needs to let a WS through
server.on("upgrade", (req, sock, head) => {
  const accept = crypto.createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64")
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  )
  sock.setNoDelay(true)
  // …frame read/write…
})
```

```js
// SSE headers that were verified to stream, not buffer
res.writeHead(200, {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
})
res.write(": open\n\n")
```

### 4.2 Starting it — the exact incantation

`commands.run` is **not** shell-interpreted, and it blocks until the process
exits. Both problems are solved by one `sh -c` with `nohup … &`:

```ts
await sandbox.files.write("/tmp/server.js", readFileSync("server.js", "utf8"))
await sandbox.commands.run("sh", {
  args: ["-c", "nohup node /tmp/server.js 3000 >/tmp/s.log 2>&1 & sleep 0.2; echo started"],
})
```

The `sleep 0.2` is what makes this reliable — without it `sh` can exit before the
child has actually been forked far enough to bind. Redirecting to a log file is
not optional either: `nohup` writes to `nohup.out` in the cwd otherwise, and you
lose the only diagnostic you have when the server fails to boot.

### 4.3 Connecting from outside — keep the query string

The token lives in the URL's query, so **never rebuild the URL from its origin**.
Set the pathname on the parsed URL and leave `search` alone:

```ts
function at(previewUrl: string, path: string) {
  const u = new URL(previewUrl)
  u.pathname = path        // keeps ?pt_token=…
  return u.toString()
}

// WebSocket
const ws = new WebSocket(at(preview, "/ws").replace(/^https:/, "wss:"))

// SSE
const res = await fetch(at(preview, "/sse"), { headers: { accept: "text/event-stream" } })
const reader = res.body!.getReader()

// polling
const r = await fetch(at(preview, "/ping"))
```

`new URL("/ping", preview).toString()` **drops the query** and gives you a 401.
That is the single easiest way to waste an hour on this.

---

## 5. Traps, in the order you will hit them

1. **`new URL(path, previewUrl)` silently drops `?pt_token`.** Every request to
   the preview host needs the token in its own query string. Use the `at()`
   helper above.

2. **A browser UI is fine, but only because of the `__pt_preview` cookie.** The
   phone loads `…?pt_token=X`, the edge sets the cookie, and every later
   tokenless sub-request (`/app.js`, `fetch("/api/…")`, the `wss://` upgrade)
   passes. Two conditions on that:
   - The **first** request the browser makes to that host must carry the token.
     Deep-linking straight to a sub-resource without one gives a 401.
   - A non-browser client (a Node/CLI relay, `fetch` without a cookie jar) keeps
     **no** cookie, so it must append `pt_token` to every URL itself. Headers do
     not work. Use the `at()` helper.

3. **Idle WebSockets die at 60 s** (see §1). Heartbeat every 20–25 s and handle
   close code 1006 as "reconnect", not "the human left". A live view that pushes
   frames continuously never notices this — but a paused or fully-loaded page
   does, and that is exactly the state a human handoff sits in while someone
   reads a 2FA code off another device.

4. **The token expires after 1 hour.** A handoff that a human abandons over
   lunch comes back to a dead URL. `previewUrl(port)` is cheap (~200 ms) and can
   be called again on the same running sandbox to mint a fresh token, so re-issue
   rather than trying to extend. Separately, the *sandbox* dies on its own idle
   timeout — `timeoutMs` is a rolling idle window, so call `sandbox.setTimeout()`
   or keep traffic flowing while a human is connected.

5. **One token = one port = one subdomain.** If handraise serves the UI on one
   port and the frame stream on another, that is two hosts, two tokens, and two
   separate cookie grants — the second host's first request must carry its own
   token. Keep everything on one port; it costs nothing and halves the auth
   surface. This is the main reason `server.js` puts `/ws`, `/sse` and the page
   on a single listener.

6. **`commands.run` is not a shell and it blocks.** Anything with a pipe, a
   redirect, or a background `&` must go through `sh -c`. Forgetting this hangs
   the whole handoff.

7. **Concurrency limit is 2 sandboxes on the test plan**, and it is enforced with
   `429 ConcurrencyLimitError: Too many concurrent sessions`. Parallel runs
   *will* collide with each other. Retry on 429 with a short backoff, and
   always `await sandbox.kill()` in a `finally` — `close()` only drops the local
   control channel and leaves the VM running and billing.
   `scripts/cleanup-sandboxes.ts` lists and kills strays; note `sandboxes.listAll()`
   yields objects keyed `sandboxId`, **not** `id`. During this measurement another
   run held both slots for ~7 minutes and the follow-up sat in a retry loop the
   whole time — budget for that when runs overlap.

8. **`ws` client and `unexpected-response`.** If the proxy ever rejects an
   upgrade, the `ws` package reports it on the `unexpected-response` event, not
   `error`. Listen for both or you will see a bare timeout and learn nothing.

---

## 6. How this was run

Five throwaway scripts: a template inventory and `previewUrl` smoke test, the
in-guest WS/SSE/HTTP echo server (Node 18, stdlib only), the measurement run
behind §1, an auth-propagation and idle-timeout follow-up (§3, §7), and a
sandbox janitor. They were experiments, not product, and they are not carried
in the tree — the repository history has them. The janitor was the one that
kept earning its keep and now lives at
[`scripts/cleanup-sandboxes.ts`](../../scripts/cleanup-sandboxes.ts).

---

## 7. Recommended transport for the live view

```
Browser frames --(in-guest WS server, one port)--> wss://<hash>-3000.preview.getsolari.com/ws?pt_token=…
```

* **WebSocket, binary frames**, one port, one token, served by the same Node
  process that serves the HTML page.
* **Heartbeat every 20 s** in at least one direction. The 60 s idle cut is real.
* **Reconnect on close 1006**, with the token re-fetched via `previewUrl(3000)`
  if the page has been open longer than ~50 min.
* **SSE is the fallback** if a corporate network blocks `wss://` — it needs a
  separate channel for the human's clicks back to the browser (a `POST` works
  fine, 185 ms), but it is a real fallback, not a theoretical one.
* **Do not use polling for frames.** Use it only for the coarse "is the handoff
  still open" check, if you want one at all.

## 8. Raw measurement output

`transport-test.ts` (first run):

```json
{"coldStart":{"createMs":664,"connectMs":613,"uploadMs":194,"spawnMs":392,
  "previewUrlMs":455,"untilFirst200Ms":2925,"pollAttempts":1,"statusSequence":[200]},
 "secondPort":{"status":200,"body":"{\"t\":1788237915499,\"port\":3001,\"echo\":null}"},
 "polling":{"ok":true,"n":15,"medianMs":185,"minMs":183,"maxMs":269,"p90Ms":193},
 "sse":{"ok":true,"status":200,"contentType":"text/event-stream",
   "transferEncoding":"chunked","headersMs":274,"firstByteMs":277,"events":8,
   "gapsMs":[248,331,204,220,248,251,252],"medianGapMs":248,"streamedNotBuffered":true},
 "sseBig":{"ok":true,"events":5,"bytes":205080,"elapsedMs":1559},
 "ws":{"handshakeMs":579,"serverPushSeen":true,"bigEchoBytes":102400,"bigEchoOk":true,
   "bigEchoRttMs":1181,"ok":true,"echoRttMedianMs":185,"echoRttMinMs":185,"echoRttMaxMs":185},
 "wsIdle":{"survivedMs":45002,"closedEarly":false,"serverPushes":88}}
```

`session-test.ts` (follow-up run):

```json
{"session":{"authedStatus":200,
  "setCookieNames":["AWSALB","AWSALBCORS","__pt_preview"],
  "tokenlessSamePathStatus":401,
  "tokenlessWithProxyCookiesStatus":200,
  "bearerHeaderStatus":401,
  "xPtTokenHeaderStatus":401,
  "tokenOnOtherPathStatus":200},
 "wsIdle":{"closedEarly":true,"aliveMs":59993,"code":1006,"reason":"Connection ended"}}
```

One caveat on `bigEchoRttMs: 1181` for a 100 KB round trip: that is 200 KB over
the wire including the laptop's uplink, so it measures the test client's
connection more than the proxy. The downstream-only figure is the better guide —
`sseBig` moved 205 KB in 1559 ms of which ~1000 ms was the server's own
scheduled delay, so server→client bandwidth is not a constraint for screencast
frames.
