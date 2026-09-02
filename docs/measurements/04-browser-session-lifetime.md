# 04 — Browser session lifetime under a human pause

**What was measured, and why.** A handoff asks a human to spend minutes on a
page while the agent's browser session sits there. Whether that session
survives is the single fact the whole failure model rests on. It is why the
default wait is five minutes, why there is deliberately no keep-alive pinger,
why `disconnected` is an outcome instead of an exception, and why
`storageState` is captured on handback — see
[ADR 0003](../adr/0003-no-keep-alive-five-minute-wait.md). Measured 2026-09-01.

**Short answer: no, and no-op keep-alive calls make no difference.**
Browser sessions on this plan die ~10 minutes after creation whether they are
completely idle, pinged every 25 s, or streaming a CDP screencast at ~14 fps.
One session died after 5.3 minutes. `expiresAt` sat at `createdAt + 5 h` in
every run — the documented plan ceiling, not an idle window — and no session
got within 1/30th of it. Nothing in the docs explains the gap.

The `timeoutMs` rolling idle window from the docs does **not** exist for browser
sessions. It belongs to sandboxes/desktops, where it works exactly as
documented — and where a paused session can be resumed in ~3 s.

---

## 1. What the SDK actually offers (from the shipped d.ts, no API calls)

### `@solarisdk/browser@0.1.2`

`solari.launch(options)` takes `LaunchOptions extends CreateSessionOptions`:

| Option | Type | Meaning |
|---|---|---|
| `profileId` | `string` | attach stored cookies + localStorage |
| `recording` | `boolean` | session recording, off by default |
| `stealth` | `boolean` | runtime stealth shim |
| `captcha` | `boolean` | managed captcha solving (needs `stealth`) |
| `webBotAuth` | `boolean` | Cloudflare Web Bot Auth signing |
| `proxy` | `string \| ProxyRequest \| "off" \| "smart"` | managed egress (needs `stealth`) |
| `retries` | `number` | extra re-launch attempts, default 0 |
| `probe` | `boolean` | health-probe the browser before returning |
| `probeTimeoutMs` | `number` | cap for that probe, default 2000 |

**There is no `timeoutMs`, no `ttl`, no `keepAlive` and no `lifecycle` for
browser sessions.** Nothing in the SDK lets a caller ask for a longer session.

`timeoutMs` *does* appear on `SolariOptions` (the `new Solari({...})`
constructor), but `dist/index.js` uses it only as the `AbortController` deadline
for the SDK's own HTTP calls — `DEFAULT_TIMEOUT_MS = 90_000`. It has nothing to
do with session lifetime. Do not confuse the two.

Session record (`Session`): `id`, `wsEndpoint`, `cdpEndpoint`,
**`expiresAt` ("plan-tier deadline; session auto-releases at this point")**,
`storageState?`, `proxy?`.

`solari.sessions` (`SessionsResource`) offers only:
`create()`, `release()` (fire-and-forget `DELETE`), `releaseAndWait()`,
`getReplayUrl()`, `downloadReplay()`. **No `get`, no `list`, no status.**

Undocumented, but reachable through the public `solari.request()` escape hatch:

* `GET /sessions/:id` → **200**
  `{"id":…,"status":"active","kind":"fast","org":…,"createdAt":…,"expiresAt":…,"wsEndpoint":…}`
* `GET /sessions` → **404 Not Found** (no list endpoint)

`dist/local-proxy.js` is a plain TCP/TLS relay with no idle timers of its own
(only a 2 s upstream *connect* timeout), so a client-side drop always mirrors an
upstream drop. Local liveness signals are therefore trustworthy.

### `@solarisdk/sdk` + `@solarisdk/core` (sandboxes / desktops)

This is where the documented rolling window lives:

* `sandboxes.create({ timeoutMs, lifecycle, ttlSeconds, … })` —
  *"Rolling idle window in ms. The session auto-pauses (per `lifecycle`) after
  this long with no activity, **resetting on every use**. Overrides the legacy
  `ttlSeconds` and the 30-minute desktop default."*
* `lifecycle: { onTimeout: "pause" | "kill", autoResume?: boolean }`
* `sandbox.setTimeout(ms)` → `{ expiresAt }` (`POST /sandboxes/:id/timeout`)
* `sandbox.pause()` / `sandbox.resume()`
* `sandboxes.get(id)` → `SandboxView { state, expiresAt, cpu, memMb, … }`,
  `sandboxes.list()` / `listAll()` — a **real** status API, unlike browsers.

---

## 2. Measurement protocol — browser sessions

Method. Liveness was polled every 5 s with `browser.isConnected()` plus a
`disconnected` listener on the raw patchright `Browser`. Both are local socket
state, send zero bytes, and therefore cannot themselves reset any server-side
window. `GET /sessions/:id` was called only once at t=0 and once after death.

The probe script and its raw JSONL logs are in the repository history.

| Run | Activity during the wait | Created (UTC) | Died (UTC) | Lifetime |
|---|---|---|---|---|
| b1-screencast | CDP `Page.startScreencast`, ~14 fps + acks, nonstop | 04:46:24.181 | 04:56:29.970 | **605.8 s** |
| b1-keepalive | `page.evaluate("1")` every 25 s | 04:46:24.183 | 04:56:29.976 | **605.8 s** |
| b1-idle | **nothing at all** (zero bytes) | 04:46:24.206 | 04:56:40.040 | **615.8 s** |
| x0 | `page.evaluate("1")` every 25 s | 05:00:06.234 | 05:05:25.285 | **319.1 s** |
| x3 (started +3 min, staggered) | `page.evaluate("1")` every 25 s | 05:03:06.186 | 05:13:10.053 | **603.9 s** |
| lone (single session, no other load) | `page.evaluate("1")` every 25 s, 24× ok | 05:13:38.942 | 05:23:55.096 | **616.2 s** |

Every session reported `expiresAt = createdAt + 5 h`. Every session was gone
after ~10 minutes.

### 2.1 Keep-alive does not help — and idling does not hurt

The three modes of batch 1 were launched within 25 ms of each other and died
within 10 s of each other. The **idle** session outlived both busy ones. Traffic
volume made no measurable difference: a screencast pushing 71 JPEG frames per
5 s (1848 frames by t=133 s) bought exactly nothing over sending nothing at all.

There is therefore **no short idle reaper** on browser sessions. A pause of up to
~5 minutes needs no keep-alive of any kind. A pause of more than ~10 minutes is
not survivable by any keep-alive.

### 2.2 The staggered test rules out a shared host event

Batch 1 died at one wall-clock moment, which alone could have been a pool
restart. x3 was created 3 minutes after x0 and died **603.9 s after its own
creation**, at a different wall-clock time and on a different host
(`ip-10-0-11-23` vs `ip-10-0-10-166`). The clock runs per session, from
creation, and it runs to roughly 600 s.

x0's 319 s is the outlier: sessions can also die **early**, with no warning and
no different error. Design for that, not for the average.

### 2.3 Confirmation run

Devil's advocate: five sessions had always shared the process with other runs,
so the cap could have been an artefact of local load or of concurrent sessions
evicting each other. The `lone` run was a single browser session with nothing
else in flight. It answered 24 consecutive `page.evaluate("1")` calls without a
single error — and died at **616.2 s** anyway, 3 seconds after the last
successful ping.

Five of six runs landed in a 604–617 s band. The cap is real, it is per session,
it starts at creation, and neither traffic nor solitude moves it.

---

## 3. How the death looks in code (this is what the library must catch)

```
browser.raw.on("disconnected")      → fires first, ~1.5 s before the next poll
browser.isConnected()               → false          (free, local, no traffic)
await page.title()                  → throws
await page.evaluate("1")            → throws
```

The throw is patchright's `TargetClosedError`:

| Field | Value |
|---|---|
| `err.constructor.name` | `TargetClosedError2` (bundled/minified name — do **not** match on it) |
| `err.name` | `"Error"` (also useless) |
| `err.message` | `"title: Browser closed"`, `"evaluate: title: Browser closed"`, screencast variant `"title: send: send: Browser closed"` |
| `err.code` / `err.status` | `undefined` |

There is no `SolariError` and no error code on this path. The only stable
discriminator is the substring **`"Browser closed"`**, or better: do not rely on
the exception at all — subscribe to `disconnected` and check `isConnected()`.

**The control plane lies.** After the browser was gone, `GET /sessions/:id`
still returned `200 {"status":"active", …}` for all three batch-1 sessions.
Never use it as a liveness check.

---

## 4. Measurement protocol — sandboxes (where `timeoutMs` is real)

All runs: `sandboxes.create({ template: "base", timeoutMs: 60_000 })`, i.e. a
deliberately short 60 s window.

| Run | What touched the session | Result |
|---|---|---|
| **idle** | nothing for 601 s | `state: "paused"`, `expiresAt` unchanged at creation + 60 s. Auto-pause fired exactly at the window. Reconnect → `ConnectionError: … failed: Expected 101 status code` |
| **probe** | **only** `sandboxes.get(id)` every 15 s | **alive after 366 s = 6× the window.** Every response carried `expiresAt = requestTime + 60 s` |
| **keepalive** | `sandboxes.get()` every 15 s + `commands.run("true")` every 30 s | alive after 613 s, exec `exitCode: 0` |
| **ws** | control WebSocket open, otherwise nothing | paused on schedule; WS stayed "connected" locally for ~75 s past the deadline, then dropped. Final `sandboxes.get()` → `GatewayError 404 "Not found"`, exec → `ConnectionError` |
| **resume** | untouched for 120 s (2× window), then `resume()` | `state: "paused"` → **`resume()` succeeded in 2819 ms** → `commands.run("echo resumed")` ok → `state: "running"`, fresh `expiresAt` |

### What counts as activity for the rolling window

* **Yes — a plain control-plane read.** `GET /sandboxes/:id` on its own kept a
  60 s window open for 6 minutes. Each response's `expiresAt` was exactly
  *request time + timeoutMs*. This is the cheapest possible keep-alive, and it
  is also a trap: a naive status poller silently prevents the auto-pause you may
  be relying on to save money.
* **Yes — any in-session RPC** (`commands.run`, exec, files, …).
* **Yes — `setTimeout(ms)`,** explicitly (`POST /sandboxes/:id/timeout`).
* **No — an idle open control WebSocket.** Holding the socket open did not
  reset anything; the sandbox paused on schedule underneath the live connection.

### Post-timeout state is recoverable

Default `lifecycle` is **pause**, not kill: RAM+disk are snapshotted and the slot
is freed. `resume()` brought it back in **2.8 s** with the process state intact.
For a human-in-the-loop wait this is the friendliest behaviour in the whole
platform — the opposite of the browser's silent hard stop.

Note one inconsistency: `sandboxes.get()` on a paused session returned
`state: "paused"` in one run but `GatewayError 404 "Not found"` in another
(4 min after the pause). Handle 404 as "paused or gone", not as a hard error.

### Concurrency cap (incidental finding)

`POST /sandboxes` with two sandboxes already running →
`ConcurrencyLimitError`, HTTP **429**, `code: "ConcurrencyLimitExceeded"`,
message `"Too many concurrent sessions"`. So the sandbox/desktop cap on this
plan is **2 concurrent**. Browser sessions ran 3 at a time without complaint —
separate pool, separate limit. Sandbox ids decode to a `desktop-pool-…` prefix,
so sandboxes and desktops share one pool and therefore one cap.

---

## 5. Answers to the questions this run had to settle

**Does a browser session survive a multi-minute pause if kept awake with
periodic no-op calls?**
No. It survives ~10 minutes and then dies regardless of what you send it. Below
that limit it survives equally well with *no* calls at all. Periodic no-ops are
pure cost: they buy no time and they hide nothing.

**Which minimal call reliably keeps a session alive?**
*Browser:* none exists. There is no call, no option and no endpoint that extends
a browser session. `expiresAt` (+5 h) is not enforceable from the client side and
was never reached.
*Sandbox/desktop:* one `sandboxes.get(id)` per window is enough — no in-session
traffic required. `setTimeout(ms)` is the explicit, intention-revealing version
and should be preferred in library code.

**Is an open CDP screencast enough as activity?**
It is not *needed* (idle sessions live just as long) and it is not *sufficient*
(the screencast session died at 605.8 s, in the same second as the ping-only
session). ~14 fps of continuous CDP traffic changed nothing.

**How does session death present itself in code?**
`disconnected` event → `isConnected() === false` → subsequent page calls throw a
patchright `TargetClosedError` whose only stable marker is the message substring
`"Browser closed"`. No error code, no status, and the REST API keeps claiming
`"active"`.

---

## 6. Recommendations for handraise

1. **Cap the human wait on a browser session at 5 minutes**, not 10. Five of six
   sessions reached 604–617 s, one died at 319 s. A 5-minute cap keeps the failure
   out of the common path; a 10-minute cap sits exactly on it. Show the human a
   countdown from the moment the hand goes up.
2. **Do not ship a keep-alive pinger for browsers.** It is measurably useless.
   Deleting it removes a component, a config option and a class of bugs.
3. **Treat session loss as an expected state, not an exception.** Subscribe to
   `browser.raw.on("disconnected")` at handoff start, expose it as a typed
   `HandraiseSessionLost { elapsedMs, phase }`, and let the caller resume the
   agent instead of crashing it. Match `"Browser closed"` only as a fallback.
4. **Never poll `GET /sessions/:id` for liveness.** It reported `"active"` for
   dead sessions in every run. `isConnected()` is free, local and truthful.
5. **For waits longer than 5 minutes, rotate instead of wait.** The only design
   that survives the cap: save `storageState` into a profile, `close()` the
   browser, and re-`launch({ profileId })` when the human arrives. This turns an
   unavoidable platform limit into a feature ("we hold your place"). Worth a
   follow-up experiment on how faithfully `profileId` restores a half-finished login.
6. **For the relay sandbox, set `timeoutMs` explicitly** to the full handoff
   budget (e.g. 15 min) and refresh with `setTimeout()` at `timeoutMs / 3`.
   Recommended keep-alive interval: **20 s for a 60 s window, or generally
   window/3**, which survived 6× the window in the probe run without a single
   in-session call.
7. **Rely on pause/resume rather than on staying awake.** A paused sandbox came
   back in 2.8 s with state intact. Set `lifecycle: { onTimeout: "pause",
   autoResume: true }` and handle the 404-on-paused case.
8. **Handle 429 `ConcurrencyLimitExceeded`.** The sandbox pool cap on this plan
   is 2. If handraise creates a relay sandbox per handoff, two concurrent
   handoffs already exhaust it. Queue, or share one relay across handoffs.

## 7. Limits of this measurement

Six browser sessions and five sandboxes, one API key, one plan, region
`us-west`, `kind: "fast"`, all within ~45 minutes on 2026-09-01. The ~600 s
browser cap is consistent (5 of 6 runs within 604–617 s) but is not
documented anywhere in the SDK, so it may be a plan-tier limit rather than a
product-wide one. Before publishing any number in the README, confirm the cap
with Solari — "we measured ~10 min on our plan" is defensible, "Solari browsers
die after 10 min" is not.

---

## Addendum 2026-09-02 — re-measured after Solari's status fix

Solari's changelog of Sep 1 ("Session status is accurate again") and Sep 2
("`GET /sessions/:id` now reports `released` once a session is closed or
deleted") postdate the runs above. The documented status set is
`active | released | expired | unknown`; a session ended server-side should
read `released`. Re-run at 11:20 UTC with
[`scripts/measure-session-lifetime.ts`](../../scripts/measure-session-lifetime.ts),
which adds a second status read at death + 5 min — past the documented
~3.5 min orphan grace the first measurement did not wait for.

| t | event | `GET /sessions/:id` |
|---|---|---|
| 1.9 s | launched, `expiresAt = createdAt + 5 h` | `200 {"status":"active"}` |
| 608.4 s | `disconnected`, `isConnected() === false` | |
| 609.3 s | read at death | `200 {"status":"active"}` |
| 910.1 s | read at death + 5 min | `200 {"status":"active"}` |

20 of 20 pings answered until the drop. Every status response was identical:
`active`, same `wsEndpoint`/`cdpEndpoint`, same `expiresAt`. Both findings
stand: the ~600 s lifetime is unchanged, and the fix for closed/deleted
sessions does not cover a session the pool ends on its own. Tracked in
[solari-cookbook#25](https://github.com/solari-sdk/solari-cookbook/issues/25).
