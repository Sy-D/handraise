# Benchmarks

Three questions, three harnesses, three raw data files. All of them run against
the live Solari API — no mocks, no simulated network, no modelled numbers. Every
figure in the README comes from the JSON next to this file.

| File | Harness | Question |
|---|---|---|
| [`handoff-latency.json`](handoff-latency.json) | [`e2e/bench.ts`](../e2e/bench.ts) | What does a handoff cost in wall-clock time? |
| [`rescue-rate.json`](rescue-rate.json) | [`e2e/rescue-bench.ts`](../e2e/rescue-bench.ts) | How many blocked workflows get done at all? |
| [`mixed-workload.json`](mixed-workload.json) | [`e2e/mixed-bench.ts`](../e2e/mixed-bench.ts) | What does each kind of interrupt cost, side by side? |

## Reproducing

They all need a `SOLARI_API_KEY` in `.env` and they all consume real sandboxes.
The plan they were measured on allows two concurrent sandboxes, so nothing else
may run alongside — check with `bun --env-file=.env scripts/cleanup-sandboxes.ts`
before and after. A run that collides with another one fails with "Too many
concurrent sessions" and says so in its JSON, rather than quietly reporting
slower numbers.

```sh
bun run bench                      # latency, N=30, ~3.5 min
BENCH_N=5 bun run bench            # a short run

bun run bench:rescue               # rescue rate, 2×20 runs, ~7 min
RESCUE_N=3 bun run bench:rescue    # a short run

bun run bench:mixed                # mixed workload, 20 runs, ~9 min
MIXED_N=4 bun run bench:mixed      # a short run
```

Each writes its JSON back into this directory, overwriting the committed file.

## Handoff latency — 30 handoffs, 30 resolved

30 consecutive real handoffs, run one at a time, one fresh relay sandbox each,
with a scripted human on the public WebSocket. Measured from Germany against
the default (us-west) endpoint on 2026-09-01. **30/30 resolved, zero
reconnects, zero failures, zero leaked sandboxes.**

| Metric | p50 | p75 | worst |
|---|---|---|---|
| `stuckToVisibleMs` — `raiseHand()` → first frame at the human | 3532 | 3594 | 3746 |
| `relayColdStartMs` — sandbox create → public URL answering | 2679 | 2731 | 2895 |
| `firstFrameMs` — same frame, timed agent-side | 644 | 664 | 679 |
| `inputRttMs` — human → relay → human, 150 samples | 186 | 191 | 286 |
| `handoffDurationMs` — whole handoff live, scripted human | 2031 | 2065 | 2183 |

All values in milliseconds. `stuckToVisibleMs` is the honest end-to-end number:
it is measured on the human's socket, not the agent's. Cold start is ~75% of
it, which is why a warm-relay option is the next performance lever.

At N=30 the right-hand column is the worst observation, not a fitted p99. The
input round trip sits on the network RTT floor from Germany to the us-west edge
— the relay itself adds nothing measurable; pass `baseUrl` to co-locate the
relay with your region. `handoffDurationMs` is the machine floor of a handoff,
not a human's reading pace.

## Rescue rate — 19 of 20 blocked workflows completed

One workflow run 2×20 times against one live portal with a real RFC 6238 TOTP
wall: sign in, reach the account page. The arms are interleaved (baseline i,
handraise i, baseline i+1, …) so both see the same browser ages, the same
network minute and the same app state.

| | completed | median handoff |
|---|---|---|
| baseline — no human, no access to the shared secret | 0/20 | — |
| with handraise | **19/20** | 5490 ms |

The 0/20 baseline is a design fact, not a crippled agent: it submits the form,
scrapes the page for a code, reloads and retries, and it never touches the
shared secret, because a six-digit code derived from a secret the agent was
never given is not guessable. The 5.5 s is a scripted human — the machine floor
again. The one failure was the platform's ~10 min session death landing
mid-handoff; handraise reported `disconnected` rather than claiming success.

What may be claimed from this, and nothing wider: *of N workflows blocked on a
human-only wall, handraise rescued X*. It is deliberately not a completion rate
over a mixed workload — that number would depend entirely on how many blockers
you assume, which is a modelling choice rather than a measurement.

The counting is load-bearing rather than decorative, and that is testable:
`RESCUE_FAULT=invert-completed bun run bench:rescue` inverts the completion
test, and the table must then read 20/20 for the baseline and 0/20 for
handraise.

## Mixed workload — 20 of 20 workflows completed, and what each mode cost

The first two benches ask about one mode. This one runs both against the same
Aurora Bank instance, interleaved (takeover, approval, takeover, …), on
2026-09-02. Two interrupts, two prices:

- **takeover** — the agent signs in with the credentials it has and stops at a
  real TOTP wall it cannot pass. A scripted human on the public WebSocket taps
  the field, types the code, presses Enter and hands back.
- **approval** — the agent is signed in and not stuck at all. It fills a
  transfer form and stops before submitting, because moving money is not its
  decision. A scripted human sees one screenshot and the action in words, and
  answers. Every fourth approval is denied (2 of 10 here).

| | completed | time to visible p50 / p75 | handoff p50 / p75 | frames | bytes | inputs | relay-sandbox s |
|---|---|---|---|---|---|---|---|
| takeover | 10/10 | 4923 / 5809 ms | 6621 / 7011 ms | 14 | 142 KB | 8 | 11.0 |
| approval | 10/10 | 5089 / 5381 ms | 2091 / 2293 ms | 1 | 25 KB | 0 | 5.5 |

All per-handoff figures are medians over the runs that completed. `time to
visible` is `raiseHand()` → the first frame arriving on the human's socket, the
same measurement as the latency bench, so the two modes are comparable and both
carry the same relay cold start (3211 ms takeover, 3068 ms approval, at p50).
`frames` and `bytes` are what the agent put on the wire: an approval is one
screenshot, 25 KB of base64 payload, and it injects nothing into the page —
`inputsApplied` is 0 by construction, not by luck. `relay-sandbox s` is wall-clock from `raiseHand()` to
the promise settling, which covers creating the sandbox, the handoff and
destroying it: the closest thing to a bill.

A denied approval counts as completed, and that is a deliberate choice: the
workflow reached a decision and the agent obeyed it. The bench asserts the money
did not move — for a denial it requires that no transfer receipt exists on the
page — so "completed" means the mechanism delivered an answer, not that the
answer was yes.

What may be claimed from this, and nothing wider: on this workload, an approval
costs one frame where a takeover costs a stream, and both modes delivered their
workflows at the rates in the table. It is **not** a claim about the mix a real
fleet sees. The 50/50 split is this harness's choice; multiply the per-mode
costs by your own mix. Nor is the takeover stream a fixed cost — it grows with
how long the human takes, and this human is a script that finishes in about
7 seconds. An approval's one frame does not grow at all.

One more thing the numbers do not say: in the approval arm the agent signs
itself in with the shared secret. That sign-in is setup, not the interrupt being
measured — the interrupt is the transfer, which comes after. Only the takeover
arm is barred from the secret, because there the wall is the whole test.

The counting is load-bearing rather than decorative, and that is testable:
`MIXED_FAULT=invert-completed bun run bench:mixed` inverts the completion test,
and both modes must then read 0 of N.

## Reading the raw files

Each file carries a `meta` block (date, N, platform, where it was measured
from, the timeouts in force) next to the aggregates and every individual run.
Failures are recorded as failures and never dropped; percentiles are over the
successes, with the failure rate reported separately.

The platform measurements these benchmarks stand on — transport, screencast,
input injection and session lifetime — are in
[`docs/measurements/`](../docs/measurements/).
