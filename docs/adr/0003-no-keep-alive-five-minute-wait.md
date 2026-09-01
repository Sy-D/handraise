# 0003 — No browser keep-alive, 5-minute default wait, storageState capture

- **Status:** accepted
- **Date:** 2026-09-01

## Context

A human handoff is a pause. The obvious fear is that the browser session dies
while the human is looking away, so the first instinct is to keep the session
warm with periodic no-op calls and to allow a generous wait.

Spike S4 measured this directly against the real API, and the instinct is wrong.
On the test plan, browser sessions die hard **~10 minutes after creation** — five
of six runs landed in a 604–617 s band, one died early at 319 s. The mode of
activity made no difference: an idle session (zero bytes), a session pinged every
25 s, and a session streaming a CDP screencast at ~14 fps all died within ~10 s of
each other, and the idle one actually outlived the busy ones. `expiresAt` promised
5 hours in every run and was never honored. Worse, the control plane lies:
`GET /sessions/:id` kept returning `{"status":"active"}` for sessions that were
already dead.

## Decision

Three linked decisions:

1. **No keep-alive pinger for browser sessions.** There is no call, option or
   endpoint that extends a browser session, and no-op traffic buys nothing.
2. **Default the human wait to 5 minutes**, not 10. Five minutes keeps the wait
   below the failure band; ten minutes sits exactly on it.
3. **Capture `storageState` (cookies + localStorage) right after a successful
   handback** and return it on the result, so the human's work survives even if the
   session dies moments later.

Liveness is read only from the local connection — `browser.raw.on("disconnected")`
plus `isConnected()` — never from the control plane.

## Alternatives

- **A keep-alive pinger** (no-op CDP calls on a timer). Rejected: S4 proved it is
  measurably useless — it extends nothing and hides the coming death. Deleting it
  removes a component, a config option and a class of bugs.
- **A long default wait** (e.g. 10+ minutes). Rejected: it runs the common path
  straight into the hard death, turning a normal handoff into a `disconnected`.
- **Polling `GET /sessions/:id` for liveness.** Rejected: it reported `"active"`
  for every dead session. `isConnected()` is free, local and truthful.

## Consequences

- A new terminal outcome, **`disconnected`**, models mid-handoff session death as
  an expected state rather than an exception. The caller keeps control and can
  decide what to do next instead of catching a `TargetClosedError`.
- **Detecting death is connection-only.** handraise subscribes to `disconnected`
  and checks `isConnected()`; the exception path (`"Browser closed"` substring) is
  a fallback, and the REST status is never trusted.
- **`storageState` on the result enables relaunch.** The caller can persist it to a
  Solari profile and re-`launch({ profileId })` when the human arrives — turning
  the platform's hard cap into a "we hold your place" feature. It is absent when
  the session was already gone.
- Follow-up: for waits that must exceed 5 minutes, the durable design is
  rotate-not-wait (save state, close, relaunch on the human's arrival). A spike on
  how faithfully `profileId` restores a half-finished login is still open.
- The ~10-minute cap is a measured plan-tier observation, not a documented Solari
  guarantee; claims are phrased as "we measured ~10 min on our plan".
