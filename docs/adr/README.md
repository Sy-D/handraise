# Architecture Decision Records

These records capture the load-bearing decisions behind handraise and why the
alternatives were rejected. Each one is distilled from measurements against the
real Solari API (written up in [`../measurements/`](../measurements/), with the
benchmark data in [`../../benchmarks/`](../../benchmarks/)) and from the
pre-publish security review — they document the history, they do not invent it.

| # | Decision | Status | Grounded in |
|---|---|---|---|
| [0001](0001-websocket-live-view-transport.md) | WebSocket as the live-view transport | accepted | [Measurement 01](../measurements/01-preview-transport.md) |
| [0002](0002-relay-in-solari-sandbox.md) | Run the relay in a Solari sandbox behind port-preview | accepted | Measurements [01](../measurements/01-preview-transport.md), [04](../measurements/04-browser-session-lifetime.md) |
| [0003](0003-no-keep-alive-five-minute-wait.md) | No browser keep-alive, 5-minute default wait, storageState capture | accepted | [Measurement 04](../measurements/04-browser-session-lifetime.md) |
| [0004](0004-separate-agent-secret-closed-message-set.md) | Agent role via a separate secret, and a closed human message set | accepted | Security review |
| [0005](0005-handoff-not-wall-detection.md) | handraise is the handoff mechanism, not the wall detection | accepted | Scope decision |
| [0006](0006-approval-mode.md) | Approval mode: one screenshot, a hold on yes | accepted | Scope decision |

## Format

Every ADR states **Status**, **Context** (why a decision was needed), **Decision**
(what was decided), **Alternatives** (what was rejected and why), and
**Consequences** (trade-offs and follow-up work).
