# Docs work — report

Date: 2026-09-01. Scope: docs only (ADRs, CHANGELOG, README additions). No
`src/`, `.github/`, `package.json`, `test-app/`, `e2e/`, or `spikes/` code
touched. Not committed — supervisor commits.

## Files created

- `docs/adr/0001-websocket-live-view-transport.md`
- `docs/adr/0002-relay-in-solari-sandbox.md`
- `docs/adr/0003-no-keep-alive-five-minute-wait.md`
- `docs/adr/0004-separate-agent-secret-closed-message-set.md`
- `docs/adr/0005-handoff-not-wall-detection.md`
- `docs/adr/README.md` (index table + format note)
- `CHANGELOG.md` (Keep a Changelog, SemVer, single `[0.1.0] - 2026-09-01` entry)

## Files edited

- `README.md` — added badge row (CI / npm / MIT) under the tagline; added a
  "How this compares" section before "Limitations (v1)"; added `logger`,
  `onEvent`, `baseUrl` rows to the `raiseHand` options table.

## ADR rationale (one line each), grounded in sources

- **0001** WebSocket transport. From spike S1: WS, SSE, HTTP polling all pass the
  preview proxy; WS is lowest-latency and bidirectional on one port. Rejected
  polling (frame age = latency + interval) and SSE (needs a second channel).
  Consequence: 60 s idle cut (close 1006) → 20 s heartbeat + reconnect.
- **0002** Relay in a Solari sandbox behind port-preview. Adopter hosts nothing;
  the preview URL is the handoff link. Rejected local server + tunnel, Tailscale
  (needs a tailnet), direct CDP (would expose the API key). S1: ~3 s cold start,
  Node 18 in `base` template, one of 2 sandbox slots.
- **0003** No keep-alive, 5-min default wait, storageState capture. From spike
  S4: browser sessions die hard ~10 min from creation, activity changes nothing,
  the sessions API reports dead sessions as "active". Rejected keep-alive pinger
  and long waits. Consequence: `disconnected` outcome, connection-only liveness,
  relaunch via profile.
- **0004** Separate agent secret + closed human message set. From the security
  review (blocker): the preview token authorizes any path, so a link holder could
  claim the agent role and read OTP/keystrokes. Fix: `randomUUID` secret on the
  agent URL only, `Origin` refused, human limited to mouse/keyboard/scroll/
  handback/abort.
- **0005** Handoff mechanism, not wall detection. Detection is unbounded and the
  agent's LLM has the context; rejected built-in heuristics. Consequence:
  `needHuman` tool export; detection is "contributions welcome".

## README additions detail

- Badges: exact URLs from the task (npm badge renders after first publish — ok).
- "How this compares": fair, non-disparaging framing vs Browserbase Live View,
  Cloudflare Browser Rendering, Scrapfly, AuthLoop — they are hosted platform
  features of their clouds; handraise is a small open library bringing the same
  handoff to Solari (which has no native browser live view), UI runs on Solari.
  No false claims about competitors.
- Options table: `logger`, `onEvent`, `baseUrl` wording matches the stated
  contract; these are implemented by a parallel agent and are part of 0.1.0.

## Facts checked against the code / sources

- `HandoffOutcome = "resolved" | "aborted" | "timeout" | "disconnected"` — matches
  `src/types.ts` and README. CHANGELOG and ADRs use the same values.
- `logger` / `onEvent` / `baseUrl` are NOT yet in `src/types.ts` (parallel agent
  in flight). Documented per the task's stated contract; verify names/types match
  once that agent lands.
- Cloudflare product referenced as "Browser Rendering" (its current name) rather
  than the task's "Browser Run" — safer, avoids a wrong product name.

## Gates

- Biome scopes only `src/**`, `e2e/**`, `test-app/**`, `*.json` (see `biome.json`),
  so the markdown is outside its file set — `biome check` does not process these
  files and cannot go red on them. Confirmed by running it: 0 files processed.
- Markdown is valid; README code blocks unchanged and consistent with the API.

## Open points

- The CI badge assumes `.github/workflows/ci.yml` (owned by the parallel `.github`
  agent). If the workflow file is named differently, update the badge URL.
- Confirm `logger` / `onEvent` / `HandoffEvent` / `baseUrl` names and types once
  the parallel `src/` agent lands, and reconcile the README options table if they
  differ.
- The `[0.1.0]` compare/tag link points at `v0.1.0` — valid only after that tag
  and release exist.
