# The rescue bench — how many workflows survive a human-only wall?

Date: 2026-09-01 · Script: `e2e/rescue-bench.ts` · Raw data: `spikes/rescue-results.json`

```
RESCUE_N=20 bun --env-file=.env e2e/rescue-bench.ts
```

## The result

| | completed | median human time |
|-------------------------------|-----------|-------------------|
| baseline (no human available) |      0/20 |                 — |
| with handraise                |     19/20 |             5.5 s |

**The one sentence that may be said out loud:**

> Of 20 workflows blocked on a human-only wall, handraise rescued 19. The
> baseline rescued none. Median time from `raiseHand()` to the agent being
> unblocked: 5.5 s.

**The sentence that may not.** There is no "completion rate" here. A number
like "our agents go from 60 % to 95 %" needs an assumed mix of blockers, and
that mix is a modelling choice, not a measurement. This bench measures one
thing: what happens at the wall. Everything before and after the wall is
identical in both arms, on purpose.

## Design

One workflow, run 40 times against one real Aurora Bank instance
(`test-app/`, deployed into a Solari sandbox): **sign in and reach the account
page.** Every run hits the same wall — a real RFC 6238 TOTP prompt (SHA-1,
30 s step, ±1 step tolerance), verified server-side in the guest app.

Both arms are identical up to the wall: `goto`, fill username, fill password,
click submit, wait for the code field.

**baseline arm — an automation with no human.** It does not have the shared
secret and never reads `app.totpSecret`. It tries what an automation can
actually try, in order, and every attempt is recorded per run:

1. `submit-empty` — submit the form with what it has, which is nothing.
2. `scrape-page` — read `document.body.innerText` and look for a six-digit
   code. Some 2FA flows really do print one. This one does not; all 20 runs
   recorded `scrape-page:none-found`.
3. `reload-and-retry` — the standard "maybe that was a hiccup" retry.

Then it stops and the workflow is checked. Expected: 0/20.

**This is not a strawman baseline, it is the only possible one.** The code is
an HMAC of a secret the agent was never given. There is no cleverer prompt, no
better model and no retry policy that produces it. Letting the baseline read
`totpSecret` would be measuring a test fixture, not an agent.

**handraise arm.** At the same wall: `raiseHand({ qr: false })`, then a
scripted human that talks only the public wire protocol (`e2e/human-sim.ts`,
the same client the e2e uses — a separate WebSocket, no back door into
handraise's modules). It waits for a frame, taps the code field in frame
pixels, types the current code one character per message, presses Enter and
hands back.

**Completion is the same test in both arms**, and it is about the job, not
about a render: the page URL ends in `/account` **and**
`[data-testid="signed-in"]` contains the username. For the handraise arm the
handoff must additionally have reported `outcome === "resolved"`.

Deliberate choices worth naming:

- **A deterministic script, not an LLM.** The claim is about the mechanism.
  A model's mood is not part of it, and would only add variance nobody can
  reproduce.
- **The arms are interleaved** (baseline 1, handraise 1, baseline 2, …) so both
  see the same browser ages, the same network minute and the same test-app
  state. Running all 20 of one arm first would confound the arm with the clock.
- **Fresh page and cleared cookies per run**, so no run inherits the session an
  earlier rescue earned.
- **One test-app sandbox** is held for the whole bench; each handoff takes the
  second slot the plan allows. `spikes/s1/cleanup.ts` reported an empty list
  before the run and an empty list after it.
- **One browser session**, relaunched at 4 minutes (Solari sessions die hard and
  the sessions API still calls the corpse "active" — `spikes/s4-report.md`).

## What "median human time" is, exactly

5.5 s is `HandoffEvent.durationMs`: `raiseHand()` called → handoff settled.
It contains the relay cold start (~2.7 s, `spikes/bench-report.md`), the first
frame reaching the phone, the tap, the six characters, Enter, the navigation
and the handback.

The narrower number — first frame at the human → handback sent, i.e. the time
a person is actually holding the phone — has a median of **4.2 s**. Both are in
`spikes/rescue-results.json`.

Neither is how long a *human* takes. A scripted human types at 60 ms per
character and never looks for their phone. **This is the machine floor of the
handoff, not a measurement of human latency**, and it should be quoted that
way. What the bench does prove about time is that handraise adds seconds of
mechanism, not minutes.

Distribution over the 19 rescued runs (ms):

| metric | min | median | max |
|---|---|---|---|
| handoff `durationMs` | 5261 | 5490 | 5575 |
| first frame → handback | 3987 | 4206 | 4284 |

For context, from the same runs: reaching the wall took a median of 1082 ms,
and the baseline's three futile strategies took a median of 2860 ms.

## The one failure

19/20, not 20/20. Run 12 of the handraise arm failed and is reported, not
dropped:

```json
{"event":"rescue_failure","index":12,"reachedWall":true,
 "handoffOutcome":"disconnected","error":null,"browserAgeMs":213726}
```

What happened: the human tapped, typed and pressed Enter normally, but the
page never reached `/account` — the Solari **browser session died mid-handoff**,
at a session age of about 240 s. handraise noticed the dead connection and
settled the handoff as `disconnected`; the bench relaunched the browser and
carried on.

Two honest notes on it:

- **The failure is the cloud browser's hard lifetime, not the handoff.** It is
  the behaviour recorded in `spikes/s4-report.md`, and handraise classified it
  correctly instead of reporting a success.
- **The 4-minute relaunch guard is not generous enough.** This session died at
  ~4.0 min, earlier than the 319 s previously measured. The guard fired once
  during this run (after run 12) and that was reactive, not preventive. A guard
  at 3 minutes would probably have avoided this failure. Left as-is here so the
  bench reports the platform as it actually behaves.

Failure accounting, kept separate from the headline as it should be:

- baseline: 20 runs, 20 reached the wall, 0 completed. No infrastructure
  failures — every baseline run got a fair chance and lost at the wall.
- handraise: 20 runs, 20 reached the wall, 19 completed, 1 `disconnected`.
- Total wall clock: 419.6 s. One browser relaunch. Two sandbox slots, never
  more.

## Red proof — the counting is load-bearing

`RESCUE_FAULT=invert-completed` inverts the completion test and nothing else.
Run at N=2:

```
RESCUE_N=2 RESCUE_FAULT=invert-completed bun --env-file=.env e2e/rescue-bench.ts

|                               | completed | median human time |
|-------------------------------|-----------|-------------------|
| baseline (no human available) |       2/2 |                 — |
| with handraise                |       0/2 |                 — |
```

The table becomes obviously wrong — the baseline "solves" a TOTP prompt it
cannot solve — while the underlying runs show the mechanism worked
(`"handoffOutcome":"resolved","handoffDurationMs":5373`). So the numbers in the
headline table come from the completion test, not from a constant. The fault
was then removed and the real N=20 run produced the table above.

## Gates

All run at the repository root, after the bench script was written:

| gate | command | result |
|---|---|---|
| types | `bunx tsc --noEmit` | exit 0, no output (`e2e/` is in `include`) |
| oxlint | `bunx oxlint` | exit 0, no findings |
| biome | `bunx biome check .` | exit 0 — "Checked 48 files. Found 2 infos" |
| tests | `bun run test` | 124 pass, 0 fail, 358 expect() calls |

The two biome infos are pre-existing notices about `biome.json` itself (schema
version 2.0.0 vs CLI 2.5.11, and the deprecated `recommended` field). They are
not caused by this change and no file outside the three listed below was
touched.

## Files

- `e2e/rescue-bench.ts` — the bench (new)
- `spikes/rescue-results.json` — raw data: meta, per-arm summaries, all 40 runs
- `spikes/rescue-report.md` — this file

Nothing is committed.

## For the supervisor — putting the number in the README

The claim to copy, verbatim:

> **19 of 20 workflows blocked on a real TOTP prompt were rescued.** The same
> agent without a human rescued 0 of 20. Median time from `raiseHand()` to the
> agent being unblocked: 5.5 s (scripted human — the mechanism's floor, not a
> person's pace). One failure, a Solari browser session that died mid-handoff
> and was reported as `disconnected`.
> `RESCUE_N=20 bun --env-file=.env e2e/rescue-bench.ts` ·
> raw data in `spikes/rescue-results.json`

Three things to keep if the wording is shortened:

1. **"of workflows blocked on a human-only wall"** — the qualifier is the
   claim. Without it the sentence turns into a completion rate over a workload
   nobody measured.
2. **0/20, stated as a design fact.** The baseline cannot know the code. Write
   it as "an agent with no human cannot pass a TOTP prompt — that is the point,
   not a benchmark artefact", so no reader thinks the baseline was crippled.
3. **The scripted-human caveat on 5.5 s.** Quoting it as human latency would be
   the one dishonest reading available in this data set.

Do not merge these numbers with `spikes/bench-report.md`'s latency percentiles
into a single table. That bench answers "what does a handoff cost"; this one
answers "does the job get done". They share a mechanism, not a metric.
