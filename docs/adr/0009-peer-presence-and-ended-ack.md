# 0009 — Peer presence, and a receipt for the ending

- **Status:** accepted
- **Date:** 2026-09-02

## Context

Two things the relay knew and never said.

**1. The human closed the tab.** handraise's wait was a single number:
`timeoutMs`, five minutes by default. It ran whether the human was reading a
code off another device, had never scanned the QR code, or had looked at the
page and closed it. The agent could not tell those apart, and the reason is in
the transport: the relay answers `ping` itself and never forwards it
([ADR 0001](0001-websocket-live-view-transport.md)), so a pong proves the relay
is alive and says nothing about the person. The README listed this as the first
limitation of v1.

The cost is not abstract. A Solari browser session dies about ten minutes after
creation and one measured session died at 319 s
([measurement 04](../measurements/04-browser-session-lifetime.md)). Sitting out
a five-minute wait for somebody who left after twenty seconds spends half of
that lifetime on nothing, and it spends it *after* the agent already knows the
handoff is not going to be answered — it just has no way to know it.

**2. The ending lost a race with the kill.** `raiseHand` sends
`{ "type": "ended", … }` and then destroys the sandbox. The relay keeps that
message for whoever opens the link next, which is what the phone's terminal
overlay is built on. In the live e2e's approval rounds the second viewer of a
link regularly saw nothing: the answering phone shows its own ending locally,
so the bug was invisible from the one screen that was being watched. An
approval tears down in milliseconds — there is no `storageState` capture to
hold the door open, as there is after a takeover — and the `ended` was written
to a socket whose process was already being deleted.

## Decision

**The relay reports the human's socket, and acknowledges the ending.** Two new
messages, both relay→agent, in a new `RelayToAgent` union next to the two peer
unions in `src/relay/protocol.ts`:

```jsonc
// on every connect/replace/close, and once right after an agent connects
{ "type": "presence", "human": true, "seen": true, "sinceMs": 0 }
{ "type": "ended_ack" }                 // once `ended` has been stored
```

**A three-state machine in the core**, `never_seen → present → gone`:

- `never_seen` is the ordinary wait and is **not** shortened. A QR code nobody
  scanned is a handoff nobody has been asked to answer yet, and the full
  `timeoutMs` is the honest budget for it.
- `present → gone` starts a clock: `humanGoneGraceMs`, default **60 000 ms**,
  accepted between 5 000 and 2 147 483 647 ms (`invalid_option` outside that).
  The floor is five times the phone's reconnect because one times it was
  measured failing: a 1 000 ms grace ended a healthy handoff on the first proxy
  cut. The ceiling is Node's largest timer delay, above which it becomes 1 ms.
- A reconnect inside the grace cancels it. It does not shorten it, and a second
  `presence: false` does not restart it.
- When the grace runs out, the handoff ends with the **existing** outcome
  `timeout`, and the wide event carries `humanSeen`, `humanLeftMs` and
  `endedEarly` so the two kinds of timeout are still distinguishable.

**`sendFinal` waits up to 2 s for `ended_ack`** before `raiseHand` kills the
sandbox, **re-sending the ending on any reconnect inside that window**.
Without an ack it proceeds exactly as before, and `stats().endedAcked` records
which of the two happened.

### What the report carries, and why it is not just a boolean

A current state alone loses a whole class of visit. The agent's socket goes
down — the 60 s proxy cut, a reconnect backoff — and a human opens the link,
looks at it and closes it again before the agent is back. Both announcements
find no agent and are dropped, and what the reconnecting agent is then told,
`human: false`, is also exactly what a link nobody has ever opened says. The
handoff would wait out the full `timeoutMs` and the event would report that
nobody came.

So the relay keeps the two facts that survive an outage — has a human ever been
here (`seen`), and how long the current state has held (`sinceMs`) — and sends
them with every report. Both are optional on the wire, so an older relay still
speaks this protocol and an agent that receives neither behaves exactly as it
did before they existed. The core leaves `never_seen` on `seen`, and runs both
the grace and `humanLeftMs` from when the human actually left rather than from
when it heard about it. `sinceMs` is clamped into `[0, handoff age]` first: it
is a relay-local delta, so there is no clock skew between machines to correct,
but a wall-clock step inside that sandbox would otherwise describe an absence
older than the handoff.

**The report goes out before any buffered terminal answer.** The relay already
holds a `handback` or an `approve` given while the agent was away. An answer
settles the handoff, and a settled handoff refuses everything it learns
afterwards — so announced second, a visit that happened during the outage would
still be reported as a handoff nobody ever opened. Announced first, and a
backdated grace that is already expired could settle the handoff as `timeout`
in the same breath, losing a race to the answer one frame behind it. Hence a
floor of **250 ms** on a backdated grace: the relay writes both frames back to
back on one socket, measured 0 ms apart, and the floor tolerates 240 ms of
that gap — three orders of magnitude of margin for a race that is otherwise a
coin flip on which tick the second frame lands in.

### Why the ending is re-sent, and not merely written once

The two seconds `sendFinal` waits are justified by the connection coming back
inside them — so it has to carry the ending when it does. A socket that dies
between the local write and the relay's store would otherwise leave `lastEnded`
unset with the agent none the wiser: the phone stays on "Reconnecting…" and the
next viewer of the link is told nothing, which is the failure this ADR exists
to close. The ending is held for the duration of the wait and re-sent from
every reconnect until the ack lands. Sending it twice is safe by construction:
the relay's store is an assignment, it acks each copy, and a second ack outside
an active waiter resolves nothing.

## Alternatives

- **A new outcome, `abandoned`.** Rejected. The union grew once already, in
  0.4.0, and every growth is a `switch` somewhere in a caller's code that
  silently stops being exhaustive — or worse, a default branch that treats a
  new member as success. Nothing about the *decision* a caller makes changes
  here: nobody answered, do not retry the same step blindly, report that you
  are blocked. That is `timeout`. What changed is *why*, and why belongs in the
  wide event, which is the field consumers read rather than branch on.
- **End the handoff the moment the socket drops.** Rejected on the measured
  number that shapes this whole transport: the preview proxy cuts an idle
  WebSocket after exactly 60 s (close 1006,
  [measurement 01](../measurements/01-preview-transport.md)) and the phone
  reconnects about a second later. Ending on the first `presence: false` would
  end healthy handoffs on the platform's own housekeeping — a human holding a
  phone, reading a code, doing nothing wrong.
- **Forward the heartbeats to the human instead.** Rejected. It would make the
  phone's liveness the agent's problem to infer from timing, which is exactly
  the guessing this ADR removes, and it would put a keep-alive on the critical
  path of a socket the relay is already keeping warm. The relay has the `peers`
  map; presence is a fact it can state, not a signal anyone should have to
  measure.
- **Shorten the default `timeoutMs` instead.** Rejected: it punishes the human
  who is genuinely working — reading an SMS, fetching a hardware key — to
  detect the human who is not.
- **A grace as an internal constant.** Rejected: 60 s is right for a phone on a
  proxy that cuts at 60 s, and wrong for an e2e that has to observe the
  behaviour in a test, or for a deployment behind a different proxy. It is an
  option with a floor, and the floor is where the judgement lives.
- **Fire-and-forget the ending, and let the relay outlive the handoff.**
  Rejected: the relay sandbox is a paid, capped resource (two concurrent on the
  measured plan) and leaving one alive to serve a page nobody may open trades a
  slot for a maybe. Two seconds of waiting is cheaper than a leaked sandbox.

## Consequences

- **`HandoffEvent` gains three fields**: `humanSeen: boolean`,
  `endedEarly: boolean` (both required) and `humanLeftMs?: number`. Additive
  for anybody who receives the event; a TypeScript consumer that *builds* a
  `HandoffEvent` literal in a test has to add the two required ones.
- **`timeout` now has two shapes.** `endedEarly: true` means somebody came and
  left; `false` with `humanSeen: false` means nobody came at all. Alerting on
  "handoffs nobody answered" should split on it — they are different problems
  with different fixes (a link that never reached anyone, versus a page a
  person could not finish).
- **A `presence` message is delivered on every agent reconnect.** It reports
  the state, not a change, so a reconnecting agent that finds the human still
  there cancels a grace it may have started while its own socket was down.
- **The relay's message set is no longer two peers only.** `RelayToAgent` is a
  third direction, and the vocabulary test now spans three unions; the phone
  never sees either message. Both test harnesses classify relay-originated
  traffic off that union rather than off a hand-written list, so a third member
  does not compile until they say what to do with it.
- **The relay keeps two more facts for the length of a handoff**, and neither
  is about the page: whether a human has ever connected, and when that last
  changed. They are the only state that survives an agent outage, and they are
  scrubbed with the sandbox like everything else.
- **Everyone already holding the link is told; somebody who arrives after the
  answer still may not be.** The ack fixes the part that was broken — the
  ending is stored and relayed before anything is destroyed, and the live e2e
  asserts it against a viewer who is watching when a channel answers and is
  told 306 ms later. It does not make the link outlive the handoff: measured in
  the same run, the preview URL stops serving about a second after an approval
  is answered, and a fresh HTTPS plus WebSocket handshake from Germany to
  us-west costs about as much again, so a viewer who starts opening the link
  after the answer usually finds a 404. Serving them would mean keeping the
  sandbox alive past the handoff, which spends a capped, paid slot on a page
  nobody may open. The e2e measures that window rather than asserting it.
- **Teardown is up to 2 s slower in the worst case** — a relay that cannot
  answer — and typically one round trip. In exchange the ending is stored
  before the sandbox dies, which is what makes the terminal overlay reliable
  for the second viewer of a link.
- **The first README limitation is gone.** The remaining one about a stale
  approval screenshot is untouched: presence says the human is *there*, not
  that what they are looking at is still true.
