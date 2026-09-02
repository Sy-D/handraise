# 0007 — Channels: an in-process hook, not a second WebSocket client

- **Status:** accepted
- **Date:** 2026-09-02

## Context

Approval mode (ADR [0006](0006-approval-mode.md)) made the handoff small enough
to fit in a chat message: one screenshot, one sentence, two answers. That is
also where approvals actually happen — nobody watches a terminal for a QR code
at 23:00, and the last consequence of that ADR was left open on purpose:
"notifying a chat channel with the screenshot and two buttons … belongs to the
channel adapters, not to this library".

So handraise needs a seam that a `handraise-telegram` or `handraise-slack`
package can sit on. What already existed does not carry an approval:

- **`onUrl` and the QR code** deliver a link and nothing else.
- **`webhookUrl`** POSTs `{ url, reason, mode, action, sessionId }`. It is
  one-way by construction, it has no picture, and getting an answer back would
  mean the caller runs a public callback endpoint.

An adapter needs three things a link cannot give it: the screenshot bytes, the
handoff id, and a way to send the answer back into a `raiseHand` call that is
already awaiting.

## Decision

**One optional array of in-process objects**, notified once per handoff:

```ts
await raiseHand(page, { mode: "approval", reason, action, channels: [telegram({ … })] })

interface HandoffChannel { notify(handoff: ChannelHandoff): void | Promise<void> }
```

`ChannelHandoff` is a discriminated union on `mode`, exactly as
`RaiseHandOptions` is. A takeover carries `handoffId`, `url`, `reason` and
`mode` — there is nothing to decide and no still image worth sending, because
the human has to drive. An approval additionally carries the `action`, the
`screenshot` as the decoded JPEG the phone is looking at, and `answer()`.

Four properties, each of them load-bearing.

**`notify` is called when there is something to send, from inside the
handoff.** In takeover mode that is as soon as the relay is up, before the
screencast starts. In approval mode it is after `captureApprovalFrame`, because
a message with the link but without the picture is the webhook that already
exists. That is why the call sits in `runHandoff` and not next to `onUrl` in
`raiseHand`.

**A channel cannot break or delay a handoff.** `notify` is not awaited, and a
synchronous throw and a rejected promise are the same thing: one
`logger.warn("channel_failed", { error })`. A chat API that is down must cost
the caller a notification, never a browser session — the same rule `onUrl`,
`onEvent` and `webhookUrl` already follow.

**`answer()` settles through the same path a relay `approve` takes.** Both go
through one `answerHandoff(outcome, via)` guarded by the flag the first settle
sets, so the first answer wins whoever gives it, the relay still receives the
usual `ended` message (the phone shows its ending), and nothing about the
settled handoff changes: no `storageState` capture, no input, no second wide
event. The wide event grows one field, `answeredVia: "relay" | "channel"`, set
on `approved` and `denied` only.

**`answer()` returns a boolean, not void and not a throw.** An approval sent to
a phone and a chat channel at the same time is *meant* to be answerable twice;
losing that race is the ordinary case, not an error. The adapter has to render
it — Telegram edits its message to "already decided elsewhere" — and a `false`
is the smallest thing that says so. A throw would mean writing a `try` around
the happy path for a routine outcome; `void` would leave the adapter unable to
tell a decision from a no-op.

## Alternatives

- **The adapter as a second human WebSocket client.** Rejected, and this is the
  decisive one: the relay accepts exactly one human peer and a new one replaces
  the old, so an adapter that connected would throw the phone off the handoff.
  It would also arrive with neither the screenshot bytes nor the `handoffId`
  until the relay replayed them, i.e. a round trip through infrastructure that
  is already holding the same data in-process, and it would need the bearer URL
  handed to it anyway. The in-process hook is smaller and more honest: an
  adapter is a listener, not a second human.
- **Extend `webhookUrl` with a callback URL for the answer.** Rejected: it
  makes every adapter a public HTTP endpoint the caller has to host and secure,
  which is precisely the thing "no server to host" says handraise does not ask
  for. (Slack does need one for its interactivity endpoint — that is Slack's
  constraint, and it is why Telegram, which long-polls, is the first adapter.)
- **Ship a Telegram client inside handraise.** Rejected: a bot token, a chat id
  and a vendor's API shape in the core, for a feature most callers do not use.
  The generic hook is ~90 lines; the vendor code lives in its own package with
  its own release cycle, and a second one cannot break the first.
- **`answer()` returns a promise that resolves when the relay has acknowledged
  the ending.** Rejected as premature: the adapter needs to know whether it won
  the race, which is knowable synchronously, not whether the phone's socket got
  the message, which it cannot act on either way.
- **A `channel` singular option.** Rejected for no reason beyond arithmetic: an
  approval that goes to Telegram *and* pages an on-call is one array today
  instead of a breaking change later.

## Consequences

- **`HandoffEvent` gains an optional `answeredVia`.** Additive; absent on every
  outcome that is not an answer, so nothing that reads the event has to change.
- **The screenshot is decoded once per approval that has channels.** It is held
  base64 for the wire; a channel gets `Buffer.from(data, "base64")` — the same
  bytes, not a second screenshot of a page that may have moved on. Callers with
  no channels pay nothing.
- **Whoever holds the channel holds the decision.** A chat channel has members,
  and any of them can press Approve. That is the same trust boundary the bearer
  URL always had, moved somewhere more comfortable — an adapter's README has to
  say so, and `handraise-telegram`'s does.
- **A channel has no signal that the handoff ended.** `answer()` returning
  `false` tells an adapter it lost a race; nothing tells it about a timeout or
  a dead session, so a long-polling adapter has to bound its own wait. A
  `settled` promise on `ChannelHandoff` is the clean fix and is deliberately
  not in this ADR: it is worth designing once, when the second adapter shows
  what it needs, rather than guessing from one.
