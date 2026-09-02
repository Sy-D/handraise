# 0006 — Approval mode: one screenshot, a hold on yes

- **Status:** accepted
- **Date:** 2026-09-02

## Context

Two different things stop an agent, and until now they were the same call.

A **capability gap** is "I can't do this": a 2FA prompt, a captcha, a page the
model does not understand. The human has to take the browser, do the thing, and
give it back. That is what `raiseHand` has always done.

An **authority boundary** is "I may not do this": submit the payment, send the
mail, delete the bucket. The agent knows exactly how. It is not allowed to
decide alone. Handing the browser over to get a yes is the wrong shape — it
gives away control of a live session to answer a question, it needs a
screencast and an input path that nobody uses, and it cannot work in a chat
channel, which is where approvals actually happen.

Both were reachable before this ADR by writing a different `reason`, which left
the outcome (`resolved`) unable to say whether the human had agreed or merely
looked.

## Decision

**A second mode on the same call**, selected by `mode: "approval"`, with
`action` required alongside it:

```ts
await raiseHand(page, { reason })                                  // takeover
await raiseHand(page, { mode: "approval", reason, action })        // approval
```

The type is a discriminated union, so `raiseHand(page, { reason })` compiles
exactly as before and `mode: "approval"` will not compile without an `action`.
`HandoffOutcome` grows by `approved` and `denied`; takeover can produce
`resolved` and `aborted`, approval the two new ones, and both can end in
`timeout` or `disconnected`.

Three decisions follow from the shape of the question.

**One screenshot, not a screencast.** An approval is about a moment — the page
as the agent left it. The frame is a single JPEG taken with `page.screenshot`,
sent as the existing `frame` message so the phone's letterbox, zoom and pan
maths do not change. No CDP session is opened at all: no screencast, no input
target, no focus probe, no `storageState` capture. The human's answer costs one
frame instead of 23–80 KB/s, and the same one frame is what a chat channel can
carry as an attachment.

**The relay owns the mode, and enforces it.** The relay process is started as a
takeover relay or an approval relay (argv, never a message) and routes only
that mode's human messages: `tap`, `char`, `key`, `clear`, `scroll`, `handback`
and `abort` in takeover; `approve` and `deny` in approval. Everything else from
the human side is dropped, and the page is served with the mode baked into its
`<body>`. Hiding a button is not a restriction — the human's WebSocket is
reachable from any HTTP client. `runHandoff` applies the same rule a second
time, so a relay that is not the one this version shipped still cannot make an
approval settle as `resolved`.

**Deny is one tap; approve takes the 700 ms hold.** This is the inversion of
takeover mode, where "Hand back" is a tap and "I can't do this" is the hold. In
a takeover the irreversible answer is giving up. In an approval the
irreversible answer is yes: the money moves, the mail goes, the bucket is gone.
So the cost of the gesture moves to the side that carries the consequence, and
the safe answer stays as cheap as possible. The hold's progress fill is
monochrome rather than the interface's one red, which stays reserved for
destructive things.

## Alternatives

- **A separate function (`requestApproval`).** Rejected: it duplicates the
  whole relay lifecycle, the QR, the webhook, the wide event and the timeout
  contract for a difference that is one branch wide, and it splits the tool
  surface an LLM has to choose from into two tools instead of one parameter.
- **`action` as an optional field on the existing options.** Rejected: an
  approval without a named step puts a blank question on a phone. The type
  system can prevent that, so it does.
- **Reuse `resolved`/`aborted` for the two answers.** Rejected: a caller
  branching on `resolved` would treat a denial as success in takeover code that
  was never written with approvals in mind. New meanings get new names.
- **Send the screencast anyway and just hide the controls.** Rejected: it pays
  the streaming cost for a still image, keeps an input path alive that must
  never fire, and makes the relay's refusal a matter of the phone's UI rather
  than the server's routing.
- **Approve as a tap, deny behind the hold** (symmetry with takeover).
  Rejected: it puts the guard on the answer that changes nothing and leaves the
  irreversible one a thumb-brush away.
- **A confirm dialog on approve** instead of the hold. Rejected for the reason
  0.3.0 already rejected it for the give-up button: a dialog costs a screen and
  trains people to dismiss it, while the hold is the confirmation.

## Consequences

- **`HandoffOutcome` has six members.** Existing `switch` statements still
  compile and still branch identically; only code that exhaustively matches the
  union has to add two arms, and only if it ever asks for approvals.
- **`HandoffEvent` carries `mode`.** Which outcomes, frame counts and input
  counts are possible follows from it, so the one wide event per handoff stays
  self-describing: an approval reports `framesSent: 1`, `inputsApplied: 0` and
  `storageStateCaptured: false` by construction.
- **An approval leaves the page untouched.** The agent continues on the same
  page it stopped on, with nothing injected, so the caller can carry out the
  approved action itself and know exactly what it is acting on.
- **The human message set stays closed and is now mode-scoped.** The relay also
  stopped forwarding non-text frames from the human side and unknown message
  types, both of which were previously relayed and then ignored by the agent.
- **The phone is one page in two modes.** Two footers and one `data-mode`
  attribute, rather than a second page to keep in sync with the first.
- Not covered here: notifying a chat channel with the screenshot and two
  buttons. That is the point of the single frame, and it belongs to the channel
  adapters, not to this library.
