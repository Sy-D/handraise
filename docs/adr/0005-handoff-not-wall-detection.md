# 0005 — handraise is the handoff mechanism, not the wall detection

- **Status:** accepted
- **Date:** 2026-09-01

## Context

A human-in-the-loop tool has two halves: **noticing** the agent is stuck (a 2FA
wall, a captcha, an unfamiliar dialog), and **doing something about it** (getting a
human onto the live session and back off). It is tempting to build both.

But "is the agent stuck?" is an open-ended problem with no clean boundary — it
depends on the site, the task, the agent's own plan, and what counts as progress.
The one component that already has all of that context is the agent's LLM: it knows
it failed the same step three times, or that it cannot answer what the page is
asking. Detection belongs where the context is.

## Decision

**handraise is only the handoff muscle.** The agent decides when it is stuck and
calls `raiseHand(page, opts)` explicitly. To make that easy for LLM agents, the
library exports a ready-made **`needHuman` tool** (`createNeedHumanTool`,
`needHumanToolSpec`, plain JSON Schema) that a framework like the Vercel AI SDK can
hand to the model, so the model itself chooses when to call for a human.

Wall detection is deliberately out of scope for v1.

## Alternatives

- **A built-in wall-detection heuristic or LLM classifier.** Rejected: it is an
  unbounded research problem, it would duplicate judgment the calling agent's model
  already has better context for, and getting it wrong (false handoffs, missed
  walls) would undermine trust in the part that does work. Shipping the handoff
  reliably beats shipping detection unreliably.

## Consequences

- The public surface is small and honest: `raiseHand` plus the `needHuman` tool
  export. The tool returns `{ outcome, summary, durationMs }`, where `summary` is a
  sentence the model can act on.
- The agent — or its LLM — owns the decision to raise a hand. handraise makes the
  hand-raise trivial once that decision is made.
- Wall-detection heuristics are an explicit "contributions welcome" area, alongside
  a Python port and richer agent-framework tool exports.
