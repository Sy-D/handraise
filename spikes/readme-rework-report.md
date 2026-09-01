# README rework — structure report

Scope: `README.md` only. Nothing committed. `demo/` untouched (referenced only).

## Structure: old → new

| # | Old | New |
|---|---|---|
| 1 | Title + bold positioning line | Title + **one sentence** |
| 2 | Badges | Badges |
| 3 | 4-line "your agent already knows" paragraph | Clip placeholder |
| 4 | Clip placeholder | `npm install handraise` |
| 5 | `SOLARI_API_KEY` note | Quickstart (tightened) |
| 6 | Quickstart | QR / hand-back / API-key line (3 lines, merged) |
| 7 | QR paragraph | **Three bullets** (session · phone · no server) |
| 8 | How it works | Demo pointers (`demo/try.ts`, `demo/github-2fa.ts`) |
| 9 | Install | **What this actually is** (new) |
| 10 | Getting notified | Give it to your LLM agent *(moved up)* |
| 11 | Give it to your LLM agent | How it works |
| 12 | API | Getting notified |
| 13 | What happens when things die | API *(unchanged)* |
| 14 | Security | What happens when things die *(+ table)* |
| 15 | Measured | How this compares *(moved up)* |
| 16 | Verified how | Security |
| 17 | How this compares | Measured |
| 18 | Limitations (v1) | Verified how |
| 19 | Contributing | Limitations (v1) |
| 20 | — | Contributing |

Rationale for the two moves: the LLM-agent section is the product story and now
sits directly after the positioning, before the architecture. Security /
Measured / Verified how are the depth part and moved behind "How this compares",
so a reviewer meets the honest competitive framing before the proof section.

## New sentences inserted

1. **Headline (one sentence).** "When your agent gets stuck on a Solari cloud
   browser, let it ask a human — then continue from the exact same session."
   Deviation from the brief: "Solari" folded into the sentence instead of
   dropped, so the runtime is visible in the first line.
2. **Three bullets** after the quickstart: same browser session / works from any
   phone, nothing to install there / no server to host (handoff UI on a Solari
   sandbox created and destroyed around the call).
3. **`## What this actually is`** — the positioning anchor: "handraise is a
   resumable interrupt primitive for autonomous agents — the live view is just
   the implementation. The product is *interrupt → human resolution → resume*. A
   live view shows you a browser; handraise gives the agent a typed outcome it
   can branch on, and a session that survives the detour."
4. **`demo/agent.ts` pointer** in the LLM section: "a real agent loop where the
   model itself decides to call `needHuman` when it hits the 2FA wall — run it
   with `DEMO_SIM=1` for the scripted version."
5. **Two classes of interrupt** paragraph: *capability gap* (2FA, captcha,
   unfamiliar UI) vs *authority boundary* (approval before an irreversible
   step); both the same call today with a different `reason`.
6. **Demo pointers** after the bullets: `demo/try.ts` and `demo/github-2fa.ts`.
7. **Failure matrix** (5 rows) above the existing prose in "What happens when
   things die".

## Failure matrix — provenance

Every row is already carried by prose below it or by shipped code:

| Row | Backed by |
|---|---|
| Human never shows → clean `timeout`, relay destroyed | prose bullet 1 |
| Browser session dies → `disconnected`, not an exception | prose bullet 2 |
| WebSocket drops → 20s heartbeats, reconnect, last frame replayed | prose bullet 4 |
| Agent process killed → sandbox lifecycle kill, no orphaned URL | prose bullet 3 |
| Link holder tries agent role → `401` | Security §2 **and** `src/relay/guest/server.js:323` (verified: `role === "agent"` without the secret writes `HTTP/1.1 401 Unauthorized`) |

## Shortened / merged (no substance removed)

- Head: 4-line intro paragraph dropped — its content is now the headline plus
  bullet 1. Standalone `## Install` section folded into the head as a fenced
  `npm install handraise` block.
- Quickstart: 18 → 12 lines. The `if (result.outcome === "resolved") { ... }`
  block became a trailing comment.
- "Your phone needs nothing installed" paragraph merged into the last sentence
  of "How it works" (bullet 2 already carries the claim).
- Failure prose: "Human never shows up" and "Human hits Abort" merged into one
  bullet (identical cleanup path).
- "How this compares", handraise bullet: dropped the `npm install` / "handoff UI
  runs on Solari" / "no second account" restatement — established three times
  above by then. The comparison, the vendor list and the honest trade-off
  paragraph are unchanged.

## Untouched

API reference tables, Security, Measured (every number verbatim), Verified how,
How this compares (vendor list + trade-off), Limitations, Contributing, the
mermaid diagram, and both existing code blocks — the `ai`-SDK
`needHumanToolSpec` / `jsonSchema<NeedHumanInput>` sample is byte-identical.

## Gates

- Markdown valid: 10 code fences (even), 4 well-formed tables, clean `#`/`##`
  hierarchy.
- `./node_modules/.bin/biome check README.md` → "These paths were provided but
  ignored: README.md". README is outside `files.includes` in `biome.json`, so it
  cannot turn Biome red.
- `biome check .` repo-wide has **one** pre-existing error, not from this work:
  `demo/.session.json` (missing trailing newline). It is a gitignored runtime
  artifact of the demo run and lives in the parallel agent's file set.

## Length

269 lines / 2008 words, vs 253 / 1805 before: **+16 lines**.

The head is materially shorter, but the six required additions are ~260 words on
their own. Getting under 253 total would have meant deleting Security, Measured
or Verified how prose — which the brief forbids. Everything that could be cut as
redundancy was cut (see above); the remainder is substance. Flagging rather than
trimming further.
