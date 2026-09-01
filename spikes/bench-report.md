# Bench report — handoff latency (N=30) and the complexity ratchet

Date: 2026-09-01. Harness: `e2e/bench.ts`. Raw data: `spikes/bench-results.json`.

Two deliverables in one pass:

1. Measured p50/p75/p99 for the five core latencies, from 30 real handoffs
   against the real Solari API.
2. Biome's `noExcessiveCognitiveComplexity` turned on as a **ratchet**, with the
   gate proven to fire.

Nothing in this report is modelled or extrapolated. Every number comes from a
wire event or a wall clock inside the bench process.

---

## 1. Percentiles

Percentile = nearest rank: sort ascending, take index `ceil(p * n) - 1`.
All values in **milliseconds**.

| metric              |   n | min  | p50  | p75  | p99  | max  |
| ------------------- | --: | ---: | ---: | ---: | ---: | ---: |
| `relayColdStartMs`  |  30 | 2555 | 2679 | 2731 | 2895 | 2895 |
| `stuckToVisibleMs`  |  30 | 3425 | 3532 | 3594 | 3746 | 3746 |
| `firstFrameMs`      |  30 |  570 |  644 |  664 |  679 |  679 |
| `inputRttMs`        | 150 |  176 |  186 |  191 |  284 |  286 |
| `handoffDurationMs` |  30 | 1936 | 2031 | 2065 | 2183 | 2183 |

What each one is:

- **`relayColdStartMs`** — `startRelay()` entry until the public preview URL
  answers. Straight out of the `HandoffEvent`. This is the floor under every
  handoff: 76 % of `stuckToVisibleMs` at p50.
- **`stuckToVisibleMs`** — `raiseHand()` call until the first screencast frame
  **arrives at the human**. Measured on the human's own WebSocket, not on the
  agent's. This is the honest end-to-end "agent stuck → human can see it"
  number and the one that belongs in the README.
- **`firstFrameMs`** — the same first frame, timed agent-side by the library
  (from handoff start, i.e. *after* the relay is up). The gap between the two is
  the relay + network leg, quantified below.
- **`inputRttMs`** — human → relay → human round trip (`{"type":"ping"}` →
  `{"type":"pong"}`, answered by the relay itself). 5 samples per run, pooled
  into one distribution of 150. This is the transport cost of a tap *before* the
  browser is involved; a real tap adds one more CDP round trip to us-west.
- **`handoffDurationMs`** — `durationMs` from the `HandoffEvent`: how long the
  handoff was live. With a scripted human this is the **machine floor** (frame
  wait + 5 pings + handback), not a human's pace. Do not quote it as "how long a
  handoff takes"; quote it as "handraise adds ~2 s of machine time around
  whatever the human does".

### Derived, from the same raw data

| derived quantity                                                | min  | p50  | p75  | p99  | max  |
| --------------------------------------------------------------- | ---: | ---: | ---: | ---: | ---: |
| relay + network leg (`stuckToVisible − relayColdStart − firstFrame`) |  188 |  213 |  239 |  425 |  425 |
| `raiseHand()` → URL exists (agent-side)                          | 2555 | 2680 | 2731 | 2895 | 2895 |
| URL exists → human's WebSocket open                              |  545 |  609 |  637 |  659 |  659 |
| frames sent per handoff                                          |    8 |    8 |    8 |    9 |    9 |
| bytes sent per handoff                                           | 55736 | 59568 | 60488 | 68096 | 68096 |

The p50 budget for "stuck → visible", added up: **2679 ms** relay cold start
+ **644 ms** first frame (agent-side) + **213 ms** relay/network leg
= **3532 ms**. The cold start is where the entire optimisation headroom is.

### One-line summary for the README

> Measured over 30 real handoffs (Germany → `api.getsolari.com`, 2026-09-01):
> agent stuck to human seeing the page **p50 3.5 s, p75 3.6 s, p99 3.7 s**;
> input round trip **p50 186 ms, p99 284 ms**. 30/30 succeeded.

---

## 2. Success and failure

| | |
| --- | --- |
| Runs requested | 30 |
| Runs completed | 30 |
| Successes (`outcome === "resolved"` **and** a frame reached the human) | 30 |
| Failures | 0 |
| **Failure rate** | **0.0 %** |
| Browser relaunches during the run | 0 |
| Agent-socket reconnects, summed over all runs | 0 |
| `storageState` captured | 30/30 |
| Total wall clock | 209.3 s (~7.0 s per run, incl. 1.5 s cooldown) |

There is nothing to explain away: no timeouts, no `disconnected`, no
`ConcurrencyLimitError`, no relay that failed to come up, not one warn or error
line from handraise's own logger across the whole run. Outcome histogram:
`{ resolved: 30 }`.

**Read the p99 with that in mind.** A p99 of 3746 ms over 30 successful runs
with a 0 % failure rate is a real number, but 30 samples put the p99 at the
second-highest observation — it is "the worst run I saw", not a tail estimate.
For a tail claim you need N in the hundreds. p50 and p75 are solid; treat p99 as
an upper observation, and say so if it goes in the README.

---

## 3. Metadata

| | |
| --- | --- |
| Date | 2026-09-01, 07:52–07:55 UTC |
| Measured from | Germany → default Solari endpoint (`api.getsolari.com`) |
| Runtime | Bun 1.4.0, darwin-arm64 |
| handraise | working tree at the time of the run (v0.1.0 + this bench) |
| Target page | `page.setContent()`, animated (CSS keyframes + a 100 ms JS counter) |
| Viewport | 1280 × 800 |
| Screencast profile | `DEFAULT_PROFILE` — quality 60, max 800 × 1400 |
| Handoff timeout | 60 000 ms (`raiseHand({ timeoutMs })`) |
| RTT samples | 5 per run, 150 total |
| Concurrency | strictly serial; exactly one sandbox (the relay) live at a time |
| Sandboxes before | 0 (verified with `spikes/s1/cleanup.ts`) |
| Sandboxes after | 0 (verified — `raiseHand` cleaned up every relay it created) |

---

## 4. How the harness works, and the two decisions worth knowing

`e2e/bench.ts`, run with `BENCH_N=30 bun --env-file=.env e2e/bench.ts`.

- **One browser session, reused.** Relaunched when it is older than 4 minutes,
  when `browser.isConnected()` is false, or when a run ends `disconnected` —
  the three triggers that follow from spikes/s4 (hard death ~10 min after
  creation, one measured at 319 s, sessions API reports the corpse as active).
  Both `browser.close()` and `solari.close()` on every swap and at the end,
  otherwise the process never exits.
- **The target page animates.** Chromium emits screencast frames only on repaint
  (spikes/s2). A static page would have made `firstFrameMs` unmeasurable.
- **Instrumentation is the library's own.** `relayColdStartMs`, `firstFrameMs`
  and `durationMs` are read from the `HandoffEvent` that handraise already emits
  through `onEvent`. Nothing was added to `src/`.
- **Failures are recorded, not fatal.** A failed run is logged and the bench
  continues; percentiles are computed over successes only, and the bench aborts
  itself if the failure rate goes above 20 % after at least 5 runs — better an
  analysed abort than a prettied-up average.

Two deliberate deviations from the brief, both visible in the file's header
comment:

1. **The scripted human is in `bench.ts`, not `openHandoffPage()` from
   `e2e/human-sim.ts`.** The relay keeps at most one socket per role
   (`peers` map in `src/relay/guest/server.js`, "a new one replaces the old"),
   so a second human socket would evict the first. Measuring `ping`/`pong` RTT
   therefore has to happen on the *same* socket that receives the frames, and
   `openHandoffPage()` does not surface pongs. The bench human speaks the
   identical wire protocol and imports `humanWebSocketUrl()` from `human-sim.ts`
   — which is exactly where the query-string trap lives (set `pathname`, keep
   `pt_token`). `human-sim.ts` was not modified.
2. **`inputRttMs` is the relay round trip, not a full tap-to-pixel round trip.**
   That is what the brief asked for, and it is the honest label: the relay
   answers `ping` itself, so the browser and CDP are not in this path. A real
   tap costs this plus one CDP round trip to the browser region.

### Gate-fire proof for the harness itself

A guard nobody has watched fire is untested (house SOP). The N=30 run never
triggered a relaunch — total wall clock was 209 s, under the 4-minute age
threshold — so the path was exercised deliberately: `BROWSER_MAX_AGE_MS`
temporarily lowered to 5 s, `BENCH_N=3`:

```
{"event":"bench_run","index":1,"ok":true,"outcome":"resolved",...}
{"event":"browser_relaunched","before":2}
{"event":"bench_run","index":2,"ok":true,"outcome":"resolved",...}
{"event":"browser_relaunched","before":3}
{"event":"bench_run","index":3,"ok":true,"outcome":"resolved",...}
{"event":"bench_done","completedN":3,"successes":3,"failures":0,"browserRelaunches":2,...}
```

The relaunch fires, and a handoff on a freshly launched session still resolves.
`BROWSER_MAX_AGE_MS` was restored to `4 * 60_000` and the N=30 results file was
restored from the real run afterwards.

**Still unproven:** the `disconnected` relaunch trigger and the >20 % abort
branch. Neither occurred in 33 real runs and neither can be forced without
touching `src/`. Worth an eye if a future run reports them.

---

## 5. Complexity ratchet (`biome.json`)

Biome 2.5.11. Rule: `lint/complexity/noExcessiveCognitiveComplexity`, option key
`maxAllowedComplexity` (confirmed via `biome explain`; default 15, range 1–254).

### What was added

```json
"complexity": {
  "noExcessiveCognitiveComplexity": {
    "level": "error",
    "options": { "maxAllowedComplexity": 59 }
  }
}
```

That is the only change to `biome.json`. **No production code was refactored.**

### Step 1 — measure

The rule was temporarily set to `maxAllowedComplexity: 1` so every function
reported its score. 39 files checked, 105 functions scoring above 1 (including
`e2e/bench.ts`). Highest first:

| value | file : line | function |
| ----: | --- | --- |
| **59** | `src/relay/guest/server.js:98` | the reader closure returned by `createReader` — the hand-rolled RFC6455 frame parser |
| **28** | `test-app/guest/app.js:354` | `route` (test app's HTTP router) |
| **22** | `src/relay/guest/server.js:218` | `route` (the relay's message router) |
| **22** | `src/relay/guest/server.js:292` | the `server.on("upgrade", …)` handler |
| **18** | `src/core/screencast.ts:88` | `jpegSize` (JPEG SOFn marker scan) |
| **16** | `src/relay/deploy.ts:178` | `kill` (retrying sandbox teardown) |
| **14** | `src/core/raise-hand.ts:144` | `runHandoff` |
| **13** | `e2e/ui.spec.ts:105` | `child.stdout.on("data", …)` |
| **11** | `src/core/raise-hand.ts:296` | `raiseHand` |
| **11** | `e2e/human-sim.ts:92` | `socket.on("message", …)` |
| **10** | `test-app/deploy.ts:102` | `createSandbox` |
| **9** | `src/core/raise-hand.ts:173` | `onHuman` |
| **8** | `src/core/input.ts:228` | the `apply` closure of `createInputTarget` |
| **8** | `src/relay/deploy.ts:129` | `waitForHealth` |
| **8** | `test-app/totp.ts:118` | `verifyTotp` |
| **7** | `src/relay/deploy.ts:102` | `createSandbox` |
| **7** | `test-app/guest/app.js:117` | `unsign` |
| **7** | `test-app/live-check.ts:23` | `absorb` |
| **7** | `test-app/app.test.ts:22` | `absorb` |
| **7** | `e2e/ui.spec.ts:128` | `openHumans` |

Everything else scores ≤ 6. The new `e2e/bench.ts` tops out at **9** (the
socket `message` handler), so the bench does not move the ceiling.

### Step 2 — set the ratchet

Threshold = today's maximum = **59**. The existing code is green; any *new*
function that scores 60 or more turns the gate red.

### Step 3 — fire proof

Threshold lowered to 58, `biome check .`:

```
src/relay/guest/server.js:98:18 lint/complexity/noExcessiveCognitiveComplexity
  × Excessive complexity of 59 detected (max: 58).
     96 │   let fragmentBytes = 0
     97 │   let fragmentOpcode = OP_TEXT
   > 98 │   return (chunk) => {
        │                  ^^^
Found 1 error.
→ exit code 1
```

Threshold restored to 59:

```
Checked 39 files in 14ms. No fixes applied.
Found 2 infos.
→ exit code 0
```

(The 2 infos are pre-existing and unrelated: the `$schema` pin at 2.0.0 versus
CLI 2.5.11, and the deprecated `linter.rules.recommended` field. Both were there
before this change.)

### Honest caveat, and a tighter variant that is already verified

59 is a weak ratchet. It is set by a single outlier — a hand-rolled WebSocket
frame reader — and the second-highest score in the whole repo is 28. At 59 a new
40-complexity function would sail through. That satisfies the letter of "no
regression past today's maximum" but not the spirit of "a ratchet, not a
decorative gate".

A tighter configuration that is **also green today** and bites at 28, with the
one genuine outlier declared as such:

```json
"complexity": {
  "noExcessiveCognitiveComplexity": {
    "level": "error",
    "options": { "maxAllowedComplexity": 28 }
  }
},
```

plus, at the top level of `biome.json`:

```json
"overrides": [
  {
    "includes": ["src/relay/guest/server.js"],
    "linter": {
      "rules": {
        "complexity": {
          "noExcessiveCognitiveComplexity": {
            "level": "error",
            "options": { "maxAllowedComplexity": 59 }
          }
        }
      }
    }
  }
]
```

Both halves were run, not guessed:

- global 28 + the override → `biome check .` exit **0** (green today)
- global 27 + the override → red on `test-app/guest/app.js:354` ("Excessive
  complexity of 28 detected (max: 27)"), exit **1**

The shipped config is the plain threshold of 59, as briefed. Swapping in the
tighter variant is a two-block paste and needs no code change. Supervisor's
call; I would take the tighter one.

### Post-launch backlog (do not do this before launch)

The list above is the backlog, in priority order. Three of them are worth real
attention after v0.1.0, and one is not:

1. `createReader` (59) — the RFC6455 parser in the guest relay. It is a state
   machine written as one closure. It is also the single most security-relevant
   function in the repo (it parses attacker-influenced bytes) and it is covered
   by `src/relay/relay.test.ts`. Splitting header-decode from
   payload-reassembly would roughly halve it. **Highest value.**
2. `route` (22) and the `upgrade` handler (22) in the same file — the upgrade
   handler mixes auth, origin checking, the handshake and the replay buffer.
   Four small functions, no behaviour change.
3. `jpegSize` (18) — a marker scan; the complexity is inherent to the format.
   Low value, leave it.
4. `runHandoff` (14) and `raiseHand` (11) — under Biome's own default of 15 and
   heavily commented. Leave them.

`test-app/**` and `e2e/**` scores are test-scaffolding, not shipped code.

---

## 6. Gate outputs (real, from this working tree)

```
$ ./node_modules/.bin/tsc --noEmit
→ exit 0   (no output; e2e/bench.ts is covered by tsconfig `include: ["src","e2e","test-app"]`)

$ ./node_modules/.bin/oxlint
→ exit 0   (no findings; e2e/ is linted, spikes/ is in ignorePatterns)

$ ./node_modules/.bin/biome check .
Checked 39 files in 14ms. No fixes applied.
Found 2 infos.
→ exit 0   (the 2 infos are the pre-existing $schema/`recommended` deprecations)

$ bun run test
$ bun test src/ test-app/ e2e/ui.spec.ts
bun test v1.4.0 (34cbb9a40)
 99 pass
 0 fail
 281 expect() calls
Ran 99 tests across 10 files. [6.63s]
→ exit 0
```

99 tests, unchanged. `bun run test` names its files explicitly, so `e2e/bench.ts`
is not picked up as a test — correct: it costs sandboxes and needs a live API
key.

Anti-slop specifics for `e2e/bench.ts`: no `any`, no `unknown` parameters or
returns, no runtime `typeof`, exactly one type assertion pair — the `JSON.parse`
of relay traffic and the patchright `Page`, both carrying a `SAFETY:` comment
that explains why the assertion holds.

---

## 7. package.json — recommended change (not applied)

`package.json` is out of scope for this agent. One script is worth adding:

```json
"bench": "bun --env-file=.env e2e/bench.ts"
```

Usage then: `bun run bench`, or `BENCH_N=5 bun run bench` for a smoke run.

Do **not** wire it into `prepublishOnly` or CI: it creates real sandboxes,
needs `SOLARI_API_KEY`, takes 3–4 minutes and would fight the 2-sandbox plan
limit with anything running in parallel.

---

## 8. Anomalies and observations

1. **Cold start dominates and is remarkably stable.** `relayColdStartMs` spans
   2555–2895 ms over 30 runs — a 340 ms spread, no outliers, no cold/warm
   bimodality. It is ~76 % of the p50 time-to-visible. Every millisecond of
   product work on "how fast does a human see the page" is really work on this
   number, which is why relay reuse / a warm pool is the p50 lever already
   parked for v0.2.
2. **The agent-side `firstFrameMs` (p50 644 ms) is not the number to publish.**
   It excludes the cold start that precedes it and the 213 ms relay leg that
   follows it. Published alone it would understate the real experience by 5×.
   `stuckToVisibleMs` is the honest headline.
3. **A bimodal tail in `inputRttMs`.** The distribution has two modes and almost
   nothing between them: 128 of 150 samples fall in 176–199 ms (89 of them in
   the single 180–189 ms bucket), 17 fall in 240–286 ms, and only 5 land in the
   40 ms gap between. The 20 s server-side WebSocket ping in the guest
   relay lands in the same window, so the most likely explanation is a ping
   colliding with the relay's own heartbeat write or with a screencast frame on
   the same socket. It is a ~100 ms occasional add on a 186 ms baseline — not a
   defect, but it is why p99 (284 ms) is 1.5× p50 (186 ms).
4. **Eight frames and ~60 KB per handoff.** With a scripted human who leaves
   after ~2 s. This is not a bandwidth measurement of a real session — spikes/s2
   measured 23–80 KB/s under continuous use, and that number still stands.
5. **The browser session survived all 30 runs (205.6 s at the last run's
   start).** No relaunch was needed. Consistent with s4's ~10 min hard lifetime,
   but note that this run never got close to it: a bench with N ≈ 60 would cross
   4 minutes and exercise the relaunch path for real.
6. **Zero reconnects, zero warn/error lines, 30/30 `storageState` captured.**
   The library's own reliability instrumentation stayed silent for the entire
   run. Worth quoting as a stability signal, given that all 30 runs also
   resolved.
7. **`handoffDurationMs` is a floor, not a duration.** ~2.0 s = frame wait
   + 5 pings + handback with a machine on the human end. A README that quotes
   it as "a handoff takes 2 seconds" would be wrong; the honest phrasing is
   "handraise's own overhead around the human is ~2 s".
