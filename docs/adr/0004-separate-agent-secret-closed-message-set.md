# 0004 — Agent role via a separate secret, and a closed human message set

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The handoff link is meant to be shareable — you send it to whoever can solve the
wall (view the screen, type the 2FA code, tap through a dialog). But the relay has
two roles on it: the **human**, who may send input, and the **agent**, who reads
the human's keystrokes and drives the browser. The keystrokes include OTP codes.

The preview token authorizes *any path* on the sandbox (S1). So if the only
protection is the preview token, anyone holding the human link can also connect as
`role=agent`. The security review flagged exactly this as a blocker: a link holder
could claim the agent role, evict the real agent, read another helper's OTP and
keystrokes, spoof frames and the ending, and retake the slot at will.

## Decision

**Split the two roles onto two credentials.** The agent role requires a separate,
cryptographically random secret (`randomUUID`) that `startRelay` mints and appends
**only to the agent's own WebSocket URL** — never to the human link. The relay
validates it before admitting an agent connection. A foreign `Origin` is refused,
so the preview cookie cannot be ridden from another page.

The human side is restricted to a **closed message set**: mouse, keyboard (a few
named keys plus characters), scroll, hand-back and abort — and nothing else.
Inputs are length- and rate-bounded. There is no path from the link to arbitrary
browser control.

## Alternatives

- **Rely on the preview token alone.** Rejected: the preview token authorizes
  every path on the sandbox, so it cannot distinguish "may view and solve" from
  "may drive the browser and read keystrokes". One credential for two trust levels
  is the blocker itself.

## Consequences

- **`agentWsUrl` carries a per-handoff secret** that the human link does not. Only
  a client holding it may connect as the agent that reads input and drives the page.
- **The human link is safe to share.** Its holder can view and solve, but cannot
  read the agent channel or issue anything outside the closed message set.
- **The relay is a dumb router with a fixed vocabulary.** Reducing the human's
  reachable actions to mouse / keyboard / scroll / handback / abort removes the
  attack surface of "arbitrary CDP over the link".
- Follow-up (from the same review, tracked for hardening): make peer replacement
  terminal so a displaced socket cannot keep routing; add an exact runtime decoder
  with per-peer rate, queued-count and queued-byte limits; bound fragmented-message
  bytes; and apply destination backpressure so a non-reading client cannot grow the
  frame queue without limit.
