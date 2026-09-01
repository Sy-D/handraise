# `npx handraise` — one-command demo CLI

**Status:** implemented, all offline gates green, package proof passed.
**Live smoke: NOT run — both Solari sandbox slots were held by the parallel
benchmark agent. Supervisor to re-run (command in §6).**

---

## 1. What was built

Three files added, one changed. Nothing else touched.

| File | Role |
|---|---|
| `src/cli.ts` (new) | The `bin`. Argument handling, portal deploy, browser launch, `raiseHand()`, TOTP ticker, summary, teardown. |
| `src/cli-guest.ts` (new) | The demo target: a one-page 2FA portal as a JS string, plus the RFC 6238 maths the terminal needs. |
| `src/cli.test.ts` (new) | 17 tests: RFC 6238 vectors, drift window, portal-source invariants. |
| `tsup.config.ts` (changed) | Second entry, `splitting: false`, `external: ["./index.js"]`, `dts` restricted to the library entry. |

Not touched: `package.json`, `README.md`, `CHANGELOG.md`, `demo/**`, `e2e/**`,
every other file under `src/`.

### The run, end to end

1. `--help` / `--version` / no `SOLARI_API_KEY` are answered before any network
   call. Missing key prints a three-line instruction pointing at
   `https://console.getsolari.com` and exits 1.
2. **Sandbox 1 — the demo target.** `startPortal()` creates a `base` sandbox
   with `lifecycle: { onTimeout: "kill" }`, writes `PORTAL_SERVER_JS` to
   `/opt/portal/app.mjs`, starts it with `nohup node … &` through `sh -c`, takes
   a `previewUrl(4100)` and polls `/healthz` on the **public** URL until it says
   `ok`. `ConcurrencyLimitError` is retried five times with backoff, with a line
   that says the account is at its limit.
3. **The browser.** `new Solari({ apiKey })`, `launch()`, `newContext()`,
   `newPage()` (the same SAFETY-commented `as Page` cast `demo/github-2fa.ts`
   uses), `goto(portal.url)`. The agent is now at the 2FA wall.
4. **Sandbox 2 — the relay.** `raiseHand(page, { reason: "This portal wants a
   TOTP code — solve it from your phone", timeoutMs })`. `raiseHand` creates and
   destroys this one itself. That is the two concurrent sandboxes the plan
   allows, hence the hard teardown everywhere.
5. **The code ticker.** Started from `raiseHand`'s `onUrl` callback and printed
   through a `setTimeout(…, 0)`. `raiseHand` calls `onUrl` and then
   `printHandoffQr` synchronously in the same tick, so deferring by one turn
   puts the code **under** the QR code — where a person looks after scanning —
   rather than above it. It reprints on the 30-second step boundary plus 300 ms
   of slack, not on a fixed 25 s interval: a code printed two seconds before it
   rolls over is a code the human types too late. The line says out loud what
   it is doing: `current code 123456 — you'll type this on your phone (good for
   28s)`.
6. **Summary and exit.**

| Outcome | Exit | Line |
|---|---|---|
| `resolved`, portal signed in | 0 | "the portal is signed in, and the agent has the session" |
| `resolved`, not signed in | 0 | "you handed back before the portal was signed in" |
| `timeout` | 0 | "nobody picked it up. Run it again and scan the code." |
| `aborted` | 0 | "you gave it back untouched" |
| `disconnected` | 1 | "the Solari browser session died mid-handoff" |
| no API key / portal never came up / any throw | 1 | the error message |

Plus a stats line (`relay up in 3.1s, 210 frames / 1.4 MB streamed, 12 inputs
from the phone`) from the `onEvent` wide event, and the cost footer:
`this demo used 2 sandboxes + 1 browser session for ~58s.`

### Teardown

A LIFO `Release[]` stack: `portal.kill` → `solari.close` → `browser.close`,
popped in reverse. It runs in a `finally` **and** from `SIGINT`/`SIGTERM`,
because a Ctrl-C during a handoff would otherwise leave a sandbox holding one
of the account's two slots until its idle timeout and block the next run.
Cleanup failures are printed, never swallowed, and one failure does not stop
the next release. The process ends with an explicit `process.exit(code)` after
flushing stdout — a demo that does not return the prompt is a bad demo, and a
piped stdout write is async and can be lost by a bare `process.exit`.

### Why `src/cli-guest.ts` exists

`test-app/` is the richer 2FA target but it is **not in the published package**
(`files` ships `dist` only). A reviewer running `npx handraise` downloads the
tarball and nothing else, so the demo carries its own target: one route, no
login step, no cookies, no session. `GET /` asks for six digits, `POST /`
verifies them (SHA-1, 30 s step, ±1 step, constant-time compare) and returns
the success page with `data-testid="signed-in"` — the exact selector `cli.ts`
looks for after handback. `GET /healthz` is what the deploy polls.

The server is written with quoted strings and `+`, never template literals:
every backtick and `${` would need hand-escaping to survive the TypeScript
template literal that holds it. A test asserts the emitted string contains
neither, so a botched escape fails the build instead of the sandbox.

Nothing is imported from `test-app/` or `demo/`. The TOTP logic is a fresh copy
in `cli-guest.ts`, pinned to the RFC vectors independently.

### Build notes

- **Shebang**: `#!/usr/bin/env node` is the first line of `src/cli.ts`; esbuild
  hoists it to the top of `dist/cli.js` and sets the executable bit
  (`-rwxr-xr-x` in the tarball). A tsup `banner` was rejected because it applies
  to every entry and would have put a shebang on `dist/index.js` too.
- **`splitting: false`**: with splitting on, esbuild would move shared code into
  a chunk and rewrite `dist/index.js` to import it — changing the published
  entry point for every existing consumer to save one file.
- **`external: ["./index.js"]`**: `dist/cli.js` keeps `import { raiseHand } from
  "./index.js"` and loads `dist/index.js` at runtime, instead of bundling a
  second 64 kB copy of the library into the tarball.
- **`dts: { entry: "src/index.ts" }`**: no `cli.d.ts`; nobody imports a `bin`.
- **Version**: read at runtime via `createRequire(import.meta.url)("../package.json")`.
  `../` is the package root from both `src/cli.ts` and `dist/cli.js`.

---

## 2. `dist/index.*` is byte-identical

The consumer entry point must not move. Measured before and after:

```
$ shasum -a 256 dist/index.js dist/index.d.ts          # BEFORE (baseline build)
9b3fcc6db9b0e074238678a127a49a0dc48690cce9e4ae9fe7d09a225f810e12  dist/index.js
27208d0788a80873aeab82c9ec4394f253895e84e3516ec568f83a6976ec5a9d  dist/index.d.ts

$ shasum -a 256 dist/index.js dist/index.d.ts          # AFTER
9b3fcc6db9b0e074238678a127a49a0dc48690cce9e4ae9fe7d09a225f810e12  dist/index.js
27208d0788a80873aeab82c9ec4394f253895e84e3516ec568f83a6976ec5a9d  dist/index.d.ts

$ cmp dist/index.js /tmp/handraise-dist-baseline/index.js && echo IDENTICAL
IDENTICAL
```

---

## 3. Tarball size, before and after

| | before | after | delta |
|---|---|---|---|
| packed | 29 393 B (29.4 kB) | 36 717 B (36.7 kB) | **+7 324 B** |
| unpacked | 86 143 B | 108 915 B | +22 772 B |
| files | 5 | 6 | +1 (`dist/cli.js`, 17 974 B) |

Full tarball contents after the change — no `.env`, no secret, no `test-app/`,
no `demo/`, no `spikes/`:

```
$ tar tzvf handraise-0.1.0.tgz
-rw-r--r--  1067   package/LICENSE
-rwxr-xr-x  17974  package/dist/cli.js      <- executable bit set
-rw-r--r--  64352  package/dist/index.js
-rw-r--r--  1972   package/package.json
-rw-r--r--  12731  package/README.md
-rw-r--r--  10770  package/dist/index.d.ts
```

---

## 4. Package proof (no live Solari needed)

Clean temp project, tarball installed as a dependency, peer `playwright-core`
auto-installed by npm.

```
$ mkdir -p /tmp/hr-consumer && cd /tmp/hr-consumer && npm init -y
$ npm i /…/handraise/handraise-0.1.0.tgz
added 10 packages, and audited 11 packages in 2s
found 0 vulnerabilities

$ ls node_modules            # peers resolved
@solarisdk  handraise  patchright-core  playwright-core  qrcode-terminal  ws

$ ls -l node_modules/.bin/handraise
lrwxr-xr-x  node_modules/.bin/handraise -> ../handraise/dist/cli.js

$ ./node_modules/.bin/handraise --version
0.1.0

$ npx handraise --help
handraise — hand a stuck cloud browser to a human on their phone.

Usage
  npx handraise             run the demo end to end
  npx handraise --help      show this text
  npx handraise --version   print the version
… (full text below in §7)

$ env -u SOLARI_API_KEY npx handraise
handraise needs a Solari API key.

  1. Create one at https://console.getsolari.com
  2. export SOLARI_API_KEY=sk-...
  3. npx handraise
exit=1

$ node -e 'import("handraise").then(m => console.log(Object.keys(m).join(", ")))'
consoleLogger, createNeedHumanTool, needHumanToolSpec, noopLogger, quietLogger, raiseHand
```

The last line matters twice: the library import is untouched, and because
`dist/cli.js` statically imports `./index.js`, `--help` running at all proves
the cross-file resolution inside the installed package works.

---

## 5. Gate outputs

```
$ bun run typecheck          # tsc --noEmit
(no output, exit 0)

$ bun run lint               # biome check . && oxlint && embed-guest --check
Checked 48 files in 19ms. No fixes applied.
Found 2 infos.                       <- pre-existing biome.json schema-version notes
(oxlint: no output — 0 errors, 0 warnings, anti-slop plugin active)
guest-source.ts is in sync with guest/server.js
exit 0

$ bun run test               # bun test src/ test-app/ e2e/ui.spec.ts
 141 pass
 0 fail
 425 expect() calls
Ran 141 tests across 12 files. [8.67s]

$ bun run build
ESM dist/cli.js   17.55 KB
ESM dist/index.js 62.84 KB
ESM ⚡️ Build success in 10ms
DTS ⚡️ Build success in 674ms
DTS dist/index.d.ts 10.48 KB

$ node dist/cli.js --help
handraise — hand a stuck cloud browser to a human on their phone.
…
```

**Test count:** 124 → 141. The 124 pre-existing tests are unchanged and still
pass; the 17 new ones are `src/cli.test.ts`. The brief asked for "124,
unverändert" — that holds for the existing suite, and the same brief asked for a
new test with a red proof, which necessarily raises the total.

One oxlint finding was hit and fixed during development, not suppressed:
`anti-slop/no-unknown-parameters` on `.catch((error: unknown) => …)` in
`releaseAll`. The annotation was dropped to match the contextual type the rest
of the codebase uses.

---

## 6. Live smoke — NOT RUN

Precondition from the brief: run it only if `bun --env-file=.env
spikes/s1/cleanup.ts` shows 0 running sandboxes.

```
$ bun --env-file=.env spikes/s1/cleanup.ts       # first check
{"sandboxId":"…vm_000946…","state":"running","template":"base","createdAt":"2026-09-01T11:10:39.781Z"…}
{"sandboxId":"…vm_000964…","state":"running","template":"base","createdAt":"2026-09-01T11:12:22.001Z"…}
→ 2 running (both plan slots held by the parallel benchmark agent)

$ … (re-checked once, ~5 minutes later)
→ 1 running
```

Both checks were read-only (`cleanup.ts` only kills with `--kill`, which was not
passed — nothing of the parallel agent's was disturbed).

The CLI needs **two** free slots: one for the portal, one for `raiseHand`'s
relay. One free slot is not enough, and taking it would have made the portal
succeed and the relay fail with `ConcurrencyLimitError` while also breaking the
parallel benchmark. Per the brief I did not wait in a retry loop.

**Supervisor: re-run this when the slots are free.**

```bash
cd /Users/simondoba/Documents/Projekte/Development/Projects/solaris-use-case/handraise
bun --env-file=.env spikes/s1/cleanup.ts        # expect 0 running
HANDRAISE_CLI_TIMEOUT_MS=20000 bun --env-file=.env src/cli.ts
# or against the built artifact:
HANDRAISE_CLI_TIMEOUT_MS=20000 SOLARI_API_KEY=… node dist/cli.js
```

Expected: portal boots (~5 s), browser launches (~5 s), QR code prints, the
`current code …` line prints under it, ~20 s later `handoff timed out after
20.0s — nobody picked it up`, then the stats line, then `this demo used 2
sandboxes + 1 browser session for ~35s`, exit 0. Afterwards
`bun --env-file=.env spikes/s1/cleanup.ts` must show **0 running**.

What *was* proven offline instead: the portal itself was booted locally on Node
and driven through its whole flow, which is the part the sandbox only transports.

```
$ node /tmp/hr-portal.mjs                  # PORTAL_SERVER_JS, written verbatim
{"evt":"listening","port":4199}
GET  /healthz              -> 200 "ok"
GET  /                     -> 200, data-testid="totp-form" / "totp-code" / "totp-submit"
POST / code=000000         -> 401  (wrong code re-renders the form)
POST / code=<live totp()>  -> 200, data-testid="verified" / "signed-in"
```

`node --check /tmp/hr-portal.mjs` also passes, so the hand-escaped string is
valid ESM before it ever reaches a sandbox.

---

## 7. Red proof for the new tests

Two deliberate breaks, both reverted immediately after.

### 7.1 The RFC 6238 parameters

`const STEP_SECONDS = 30` → `60` in `src/cli-guest.ts`:

```
$ bun test src/cli.test.ts
(fail) totp > matches every RFC 6238 SHA-1 vector [0.89ms]
  error: expect(received).toBe(expected)
  at src/cli.test.ts:75

(fail) verifyTotp > rejects two steps of drift [0.26ms]
  error: expect(received).toBe(expected)
  Expected: false
  Received: true
  at src/cli.test.ts:135

 15 pass
 2 fail
```

### 7.2 The selector the CLI depends on

`<h1 data-testid="signed-in">` → `<h1 data-testid="done">` in the portal HTML:

```
$ bun test src/cli.test.ts
(fail) portal server source > carries the markers the CLI and the reviewer depend on
  error: expect(received).toContain(expected)
  Expected to contain: "data-testid=\"signed-in\""
  at src/cli.test.ts:155

 16 pass
 1 fail
```

That second one is the interesting gate: `reachedSignedIn()` in `cli.ts` and the
HTML in `cli-guest.ts` are two files that must agree on one string, and nothing
else in the build would notice if they stopped agreeing.

### After reverting both

```
$ bun test src/cli.test.ts
 17 pass
 0 fail
 67 expect() calls
```

One test was red on its first run for the right reason and was **fixed in the
test, not the code**: `msUntilNextCode(1_700_000_000_000)` returned 10 000, not
30 000, because that timestamp is not on a 30-second boundary
(1 700 000 000 000 mod 30 000 = 20 000). The assertion now uses
1 700 000 010 000, which is.

---

## 8. Open items for the supervisor

1. **Live smoke** — §6. The only unverified path is the real Solari one:
   sandbox deploy, browser launch, QR, teardown.
2. **README / CHANGELOG** — the brief reserves these. Worth adding: a
   `npx handraise` quickstart, the `HANDRAISE_CLI_TIMEOUT_MS` knob, and the
   note that the CLI needs two free sandbox slots.
3. **`handraise-0.1.0.tgz`** was deleted from the repo root after the proof; it
   is not in `.gitignore`, so regenerate with `npm pack` rather than committing
   one.
4. Nothing here was committed.
