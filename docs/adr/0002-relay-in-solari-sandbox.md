# 0002 — Run the relay in a Solari sandbox behind port-preview

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The human's phone needs a public URL to open the live view. handraise is a
library an agent developer drops into an existing script, so the hard constraint
is: **the adopter must host nothing.** No server to deploy, no tunnel to run, no
second account to create. Whatever serves the handoff UI has to appear on demand
and disappear when the handoff ends.

Solari already gives every sandbox a public, tokenized port preview
(`*.preview.getsolari.com`). Spike S1 confirmed the preview proxy forwards
WebSockets, that cold start from `create()` to a 200 through the public URL is
~2.9 s, and that the `base` template ships Node 18 — so the relay needs no install
step, just one `.js` file written and run.

## Decision

When the agent raises its hand, handraise **boots a Solari sandbox, writes a
zero-dependency Node relay into it, and exposes it through Solari's port preview.**
The public preview URL is the handoff link. The same `SOLARI_API_KEY` that runs
the agent's browser runs the escape hatch. The handoff UI itself runs on Solari.

## Alternatives

- **Local server + a tunnel (ngrok / cloudflared).** Rejected: it is setup
  friction the adopter has to own (install a tunnel binary, manage its auth), it
  does not use Solari, and it reads as a hobby workaround rather than a Solari
  build.
- **Headscale / Tailscale.** Rejected as an adoption killer: the user would need
  their own tailnet and a device joined to it before the phone could reach the
  session. Too much standing infrastructure for a drop-in library.
- **Point the phone straight at the CDP endpoint.** Rejected on security: the CDP
  endpoint is bound to the Solari API key, so exposing it to a phone browser would
  put the key on the device. The relay exists precisely so the key never leaves
  the agent process.

## Consequences

- **A handoff consumes one of the plan's two sandbox slots** (S1/S4: the sandbox
  pool cap on the test plan is 2, enforced with HTTP 429
  `ConcurrencyLimitExceeded`). Two concurrent handoffs is the plan-tier ceiling;
  handraise creates and destroys one sandbox per handoff.
- **Cold start is ~3 s** from "agent is stuck" to "phone can load the page" (S1:
  2925 ms `create()` → first 200; the first poll already returned 200). The
  transport is not the bottleneck — the human looking at their phone is.
- **The relay ships as a string constant, no npm install on the critical path.**
  The `base` template's Node 18 runs a raw RFC6455 server (~70 lines of stdlib),
  removing a network dependency from the boot path.
- **The relay sandbox is destroyed on every exit path**, including errors, before
  `raiseHand` returns — one handoff, one sandbox, no orphaned public URL. (The
  strength of that guarantee is tracked separately; see the security review
  follow-ups.)
- Follow-up: because a handoff burns a scarce slot, a future multi-handoff design
  would share one relay across handoffs rather than create one each time.
