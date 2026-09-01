# `demo/agent.ts` — the autonomous run

The gap the other demos leave: `demo/github-2fa.ts` and the e2e both call
`raiseHand` from a line of code a human wrote. They prove the *mechanism*. They
do not prove the *claim* — "your agent already knows when it's stuck". This demo
does: the model gets four tools, one of which is `needHuman`, and nothing in the
file decides when the handoff happens.

---

## 1. What it does

1. Deploys the Aurora Bank test app (`test-app/deploy.ts`) into a Solari sandbox
   and gets a public URL, a user, a password and the app's TOTP secret.
2. Launches a Solari cloud browser, sets a 1280×800 viewport, navigates to the
   app.
3. Hands the task to a real LLM through `generateText` with four tools:

   | tool | input | what it does |
   |---|---|---|
   | `readPage` | `{}` | URL + `document.body.innerText` + one line per control (selector, kind, label). **No field values.** Truncated to 2 000 chars. |
   | `fill` | `{ selector, value }` | `page.locator(selector).fill(value)` |
   | `click` | `{ selector }` | `page.locator(selector).click()` + `waitForLoadState` |
   | `needHuman` | `{ reason }` | `createNeedHumanTool(page, …)` → `raiseHand` |

   Every `execute` returns `"error: …"` as a string instead of throwing, so a bad
   selector is something the model reacts to rather than a crashed run.
4. The model logs in, lands on `/totp`, and finds a six-digit field it has no way
   to fill. It calls `needHuman` with its own wording. The QR appears **because
   the model asked for it**.
5. A human (or, with `DEMO_SIM=1`, a scripted finger) types the code and hands
   back. The model re-reads the page and finishes.
6. The script asserts `[data-testid="signed-in"]` exists, prints a summary, and
   kills the sandbox, the browser and the Solari client in `finally`.

Exit code is 1 unless the account page was reached **and** a handoff actually
resolved. A run where the model brute-forces its way through without raising its
hand is a failed run — that is the behaviour under test.

### What is scripted and what is not

`DEMO_SIM=1` replaces the phone with `e2e/human-sim.ts`: a separate WebSocket
client that speaks the public `role=human` protocol over the real relay — it
opens the handoff page, waits for a real screencast frame, taps the code field in
frame coordinates, types the digits one message at a time, presses Enter and
hands back. The LLM, the sandbox, the browser and the relay are untouched. Only
the finger is scripted, and the file header says so.

The TOTP code is printed to the terminal in interactive mode (and reprinted every
30 s while the handoff is open, because a code expires). This is our own test
app, deployed sixty seconds earlier by this same script — the secret is not a
credential anybody is protecting. The point being demonstrated is the handoff
mechanic.

---

## 2. The AI SDK v7 API actually used

Verified against `node_modules/ai@7.0.87` and
`@ai-sdk/provider-utils` declarations, not against training memory.

```ts
import { generateText, jsonSchema, type LanguageModel, stepCountIs, tool } from "ai"
```

| thing | v7 fact |
|---|---|
| `generateText({ model, system, prompt, tools, stopWhen, onStepEnd })` | `model: LanguageModel`; `stopWhen?: Arrayable<StopCondition<…>>`, default `isStepCount(1)` |
| `stepCountIs(n)` | exported as `isStepCount as stepCountIs` — the alias is real, both work |
| `tool({ description, inputSchema, execute })` | overload with `execute` returns `ExecutableTool<…>`; `execute: (input, options) => …`, so a one-parameter function is fine |
| `jsonSchema<T>(schema)` | re-exported from `@ai-sdk/provider-utils`; takes a `JSONSchema7`. It **accepts the `as const` `needHumanToolSpec.inputSchema` unchanged** — verified with a throwaway file, so the README snippet typechecks as written |
| step callback | `onStepFinish` still exists but is `@deprecated`; the current name is **`onStepEnd`**, same payload (`StepResult<TOOLS>`). This demo uses `onStepEnd` |
| step payload | `step.text`, `step.staticToolCalls`, `step.staticToolResults` — the `static*` arrays are the ones that narrow on `toolName`, which is what makes typed per-tool logging possible without casts |
| result | `result.steps`, `result.staticToolCalls`, `result.text` |
| Anthropic | `anthropic("claude-opus-5")` — `claude-opus-5` is a literal member of `AnthropicModelId` in `@ai-sdk/anthropic@4.0.46` |
| OpenRouter | `createOpenAICompatible({ name, baseURL, apiKey }).chatModel(id)` from `@ai-sdk/openai-compatible@3.0.41`; returns `LanguageModelV4`, assignable to `LanguageModel` |

### Provider selection

`chooseModel()` picks, in order:

1. `ANTHROPIC_API_KEY` → `anthropic(DEMO_MODEL ?? "claude-opus-5")`
2. `OPENROUTER_API_KEY` → OpenRouter at `https://openrouter.ai/api/v1`,
   `chatModel(DEMO_MODEL ?? "anthropic/claude-opus-4.5")`
3. neither → one message pointing at `demo/.env`, exit 1

`DEMO_MODEL` overrides the id for whichever provider wins; for OpenRouter that is
any id it serves. A wrong id fails with the provider's own error, which is clear
enough. The chosen provider and model are logged in one line
(`handing the task to openrouter:anthropic/claude-opus-4.5 — nothing below is scripted.`).

### Two type frictions worth knowing

- **`NodeListOf<Element>` is not iterable** under this `tsconfig` (`lib` has
  `DOM` but not `DOM.Iterable`). `Array.from(...)` inside `page.evaluate`, not
  spread.
- **`let x: T | null = null` assigned only inside a callback narrows to `never`**
  at later top-level reads. The scripted-human promise and the handoff outcome
  therefore live on a small `RunState` object; property reads re-widen after any
  call.

### Repo-specific lint frictions

- anti-slop `no-unknown-parameters` forbids a `function message(error: unknown)`
  helper. The repo convention is to inline
  `error instanceof Error ? error.message : String(error)`, which is what this
  file does (same as `test-app/deploy.ts`, `e2e/bench.ts`).
- anti-slop `no-conditional-empty-object-spread` rules out
  `...(SIM ? { onUrl } : {})`. `onUrl` is therefore always set and only its body
  differs.

---

## 3. Live run

**Blocked on a key.** At the time of writing, `demo/.env` has both
`ANTHROPIC_API_KEY=` and `OPENROUTER_API_KEY=` empty, and the root `.env` holds
only `SOLARI_API_KEY`. No run was started: a run against an empty key burns a
sandbox pair and proves nothing, and there is no mock path in this file by
design.

Everything below the model call — the test app, the relay, the screencast, the
human protocol — is the same path the shipped e2e (`bun run test:e2e`) drives,
and this demo reuses its `human-sim.ts` client verbatim.

To finish the verification, put one key in `demo/.env` and run:

```
bun --env-file=.env spikes/s1/cleanup.ts        # expect zero running sandboxes
DEMO_SIM=1 bun --env-file=.env --env-file=demo/.env demo/agent.ts
```

Pass criteria, in order:

1. the transcript shows `→ needHuman: …` that **the model** produced,
2. `✋ agent raised its hand: <reason>` prints,
3. `scripted human taps in NNNNNN`,
4. `handoff resolved in Ns`,
5. `account page   reached — Signed in as ada`,
6. `cleaned up.` and exit code 0,
7. `bun --env-file=.env spikes/s1/cleanup.ts` lists nothing running.

<!-- TRANSCRIPT: paste the live-run output here once a key exists. -->

---

## 4. Gates

| gate | command | result |
|---|---|---|
| types | `./node_modules/.bin/tsc --noEmit` | clean |
| anti-slop | `./node_modules/.bin/oxlint` | clean, zero warnings |
| format/lint | `./node_modules/.bin/biome check demo/agent.ts` | clean |
| unit + UI | `bun run test` | 124 pass, 0 fail, 358 assertions, 11 files |

Note on `biome check .` across the whole repo: it also scans
`demo/.session.json`, a gitignored runtime artefact of `demo/github-2fa.ts` that
has no trailing newline. That failure is unrelated to this work and is being
handled by removing the file from Biome's scope. `biome check demo/agent.ts` is
clean.

---

## 5. How to demo it

**Live, with your phone** — the version for the clip:

```
bun --env-file=.env --env-file=demo/.env demo/agent.ts
```

The terminal shows the model reading the page, filling the login form (the
password is masked as `•••••••` in the log), submitting — and then stopping. A QR
code appears with the model's own sentence above it. Scan it, type the six digits
the terminal is printing for you, tap **Hand back to agent**. The model re-reads
the page and reports it is signed in.

**Self-verifying, no phone** — the version for CI or a dry run:

```
DEMO_SIM=1 bun --env-file=.env --env-file=demo/.env demo/agent.ts
```

Same run, but `e2e/human-sim.ts` plays the human over the real relay. Exit code 0
means the model raised its hand on its own, the handoff resolved, and the account
page was reached.

Both need two free Solari sandbox slots (test app + relay), which is the entire
$20 plan allowance. Check first:

```
bun --env-file=.env spikes/s1/cleanup.ts          # list
bun --env-file=.env spikes/s1/cleanup.ts --kill   # list and kill strays
```
