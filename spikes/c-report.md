# C — the deterministic 2FA target app

Agent C, 2026-09-01. Everything below was run; no number in this file is an
estimate.

**Status: done and green.** The app boots in a real Solari sandbox in ~3.1 s,
serves a public login → TOTP → account flow, and a scripted client outside the
sandbox completed that flow twice end to end. 33 local tests pass. All four
gates are clean on `test-app/`.

---

## 1. What exists

| Path | Lines | What it is |
|---|---|---|
| `test-app/guest/app.js` | 477 | **Source of truth.** The portal. Node 18, ES modules, zero dependencies. |
| `test-app/guest-source.ts` | 482 | Generated. `app.js` as one exported string. |
| `test-app/embed-app.ts` | 48 | `app.js` → `guest-source.ts`. Has a `--check` mode for CI. |
| `test-app/deploy.ts` | 167 | `startTestApp()`: sandbox → upload → boot → public URL. |
| `test-app/totp.ts` | 137 | RFC 6238 TOTP in TypeScript, `node:crypto`, no npm package. |
| `test-app/totp.test.ts` | 144 | RFC 6238 Appendix B vectors + round-trips. |
| `test-app/app.test.ts` | 263 | The whole flow against a real local `node` process. |
| `test-app/live-check.ts` | 159 | The live sandbox proof. Re-runnable: `bun --env-file=.env test-app/live-check.ts`. |
| `test-app/tsconfig.json` | 4 | `extends ../tsconfig.json`, `include: ["."]` — see §6. |

### The app

`Aurora Bank`, a small server-rendered portal. One inline `<style>` block, a
card on a grey background, blue brand dot, tabular-numeric code field. It does
not look like 1998 and it does not look like a framework demo either.

| Route | Behaviour |
|---|---|
| `GET /` | Login form. `method="post"`, `action="/login"`. |
| `POST /login` | Correct → `303 /totp` + signed `hr_pending` cookie. Wrong → `401` + `data-testid="error"`. |
| `GET /totp` | **One** input, `name="code"`, `data-testid="totp-code"`. No pending cookie → `303 /`. |
| `POST /totp` | RFC 6238 (SHA-1, 30 s step, ±1 step) → `303 /account` + `hr_session`, pending cleared. Wrong → `401`. |
| `GET /account` | `<h1 data-testid="signed-in">Signed in as <user></h1>`. No session → `303 /`. |
| `POST /logout` | Clears the session → `303 /`. |
| `GET /healthz` | `200 ok`, text/plain. |

Config by env: `PORT` (4000), `TOTP_SECRET` (base32), `APP_USER` (`ada`),
`APP_PASS` (`solaris`).

Details worth knowing:

* **Zero `<script>` tags.** A test asserts that. Every form is a real POST, so
  the flow survives a browser that has not hydrated anything — the house rule
  about credential forms needing `method="post"` is not a suggestion here, it is
  the whole design.
* **Cookies are HMAC-SHA256 signed** with a 32-byte random key minted at boot,
  `HttpOnly`, `SameSite=Lax`, and `Secure` **when `x-forwarded-proto: https`** —
  which is what the preview edge sends, so the sandbox gets `Secure` and local
  http tests still work. Payload is `{ user, exp }`; a forged cookie is rejected
  (tested).
* **Constant-time everywhere it matters.** Credentials and codes compare with
  `crypto.timingSafeEqual`, the username/password checks do not short-circuit,
  and all three TOTP windows are always evaluated.
* **One wide JSON log line per request** to stdout (`evt`, `method`, `path`,
  `status`, `duration_ms`, `credentials_ok`, `code_ok`, `user`, `ua`). Never a
  password, never a code. In the sandbox it lands in `/var/log/testapp.log` —
  read it with `sandbox.commands.run("sh", { args: ["-c", "cat /var/log/testapp.log"] })`
  when a run confuses you.

---

## 2. The bug the RED test found (and it was a real one)

The brief asked for a deliberately red test first. The deliberate failure was
`const code = wrongCode()` in the success test — but the run never got that far,
because the app would not start at all:

```
ReferenceError: require is not defined in ES module scope
This file is being treated as an ES module because it has a '.js' file extension
and .../handraise/package.json contains "type": "module".
```

The repo is `"type": "module"`. `/opt/testapp` in the sandbox has no
`package.json`, so the same `.js` file is CommonJS *there* and ESM *here*. The
app would have worked in the sandbox and been impossible to test locally — the
exact shape of bug the fourth verification stage exists to catch, found on the
first real run.

**Fix:** the guest app is ESM, and `deploy.ts` uploads it as `app.mjs`. `.mjs`
is unambiguous in both worlds. No `package.json` shim needed, nothing in the
repo root touched.

Then the intended red appeared, cleanly:

```
196 | test("the correct code signs the session in and /account proves it", async () => {
198 |   const code = wrongCode() // DELIBERATE RED
201 |   expect(verified.status).toBe(303)
error: expect(received).toBe(expected)
Expected: 303   Received: 401
(fail) the correct code signs the session in and /account proves it
 13 pass  1 fail
```

Swapping `wrongCode()` for `totp(SECRET)` turned it green with nothing else
changed. The assertion is therefore known to be load-bearing, not decorative.

A second gate got the same treatment. I dropped a fixture with an `unknown`
parameter into `test-app/` to confirm oxlint actually covers the directory:

```
test-app/__slop_fixture.ts:1:29: error anti-slop(no-unknown-parameters):
  Parameter `value` leaves input unparsed.
```

It fires. Fixture deleted.

---

## 3. Gate output (real)

```
$ bun test-app/embed-app.ts --check
guest-source.ts is up to date

$ bunx tsc --noEmit -p test-app
(no output, exit 0)

$ bunx oxlint            # repo-wide; .oxlintrc.json does not ignore test-app
(no output, exit 0)

$ bunx biome check --config-path=/tmp/biome-testapp test-app
Checked 9 files in 26ms. No fixes applied.   (no errors, no warnings, no infos)

$ bun test test-app/
 33 pass
 0 fail
 106 expect() calls
Ran 33 tests across 2 files. [74.00ms]
```

`totp.test.ts` covers all six RFC 6238 Appendix B SHA-1 rows at 8 digits
(`T=59 → 94287082` … `T=20000000000 → 65353130`) and asserts the 6-digit code
equals the last six digits of each, which is what `bin mod 10^d` guarantees.
Plus: base32 encode against the known `GEZDGNBVGY3TQOJQ…` constant, byte
round-trips at every length 1–24, the ±1 step window accepted, ±2 rejected,
another secret's code rejected, malformed input rejected without throwing, and a
counter above 2^32 to exercise the high word of the HOTP message.

`app.test.ts` spawns a real `node` on a free port and drives 14 cases: healthz,
the JS-free login form, wrong password, wrong username, successful login,
the single code input, `/totp` without a pending cookie, an out-of-window code,
a code for a *different* secret, the happy path to `data-testid="signed-in"`,
`/account` without a session, a forged session cookie, logout, and a 404.

**Two failures belong to other agents, not to me** (both pre-existing, neither
touched):

* `bunx biome check .` → `src/types.ts format` — the `RaiseHand` type alias is
  longer than the 80-column default. One `biome check --write` fixes it.
* `bunx tsc --noEmit` at the root was failing on `src/relay/relay.test.ts` while
  I worked; it is clean now, so someone fixed it.

---

## 4. The live sandbox proof

`bun --env-file=.env test-app/live-check.ts`, twice, against the real API. Full
flow driven from my laptop through the public preview URL — manual redirects,
manual cookie jar, `pt_token` re-appended to every request (a non-browser client
never gets the `__pt_preview` grant). Both runs killed their sandbox in
`finally`; `spikes/s1/cleanup.ts` afterwards listed nothing.

```json
{"evt":"live_check_passed","previewHost":"e9ce060e3ce261e55054-4000.preview.getsolari.com",
 "coldStartMs":3114,"loginPageMs":266,"loginToTotpMs":575,"verifyToAccountMs":376,"totalMs":4331}
{"evt":"live_check_passed","previewHost":"73537f2deda9fc0ff880-4000.preview.getsolari.com",
 "coldStartMs":3065,"loginPageMs":186,"loginToTotpMs":647,"verifyToAccountMs":372,"totalMs":4270}
```

| Measure | Run 1 | Run 2 |
|---|---|---|
| `startTestApp()` — create → first public `/healthz` 200 | **3114 ms** | **3065 ms** |
| `GET /` through the preview URL | 266 ms | 186 ms |
| login + `GET /totp` + one rejected code | 575 ms | 647 ms |
| correct code → `303` → `GET /account` | 376 ms | 372 ms |
| whole thing, cold sandbox to signed in | 4331 ms | 4270 ms |

Cold start matches S1's 2925 ms for a bare echo server; the extra ~150 ms is the
`mkdir` and the slightly larger upload. `/healthz` answered on the **first** poll
both times.

Checks the live run makes, all passed: `GET /` is 200 and contains
`method="post"`; `POST /login` is `303` to `/totp`; `/totp` contains exactly one
`name="code"`; `000000` is rejected with `401`; the computed code gives `303` to
`/account`; `/account` is 200 and contains both `data-testid="signed-in"` and
`Signed in as <user>`.

---

## 5. Handover to Agent B (the e2e)

```ts
import { startTestApp } from "../test-app/deploy"
import { msUntilNextStep, totp } from "../test-app/totp"

const app = await startTestApp({ apiKey: process.env.SOLARI_API_KEY! })
try {
  // app.url   — public, carries ?pt_token=… ; give it to the cloud browser as-is
  // app.user  — "ada"      (override with { user })
  // app.pass  — "solaris"  (override with { pass })
  // app.totpSecret — random base32, fresh per start
  // app.sandboxId  — for log correlation / stray cleanup

  await page.goto(app.url)                       // first request MUST carry the token
  await page.fill('[data-testid="username"]', app.user)
  await page.fill('[data-testid="password"]', app.pass)
  await page.click('[data-testid="login-submit"]')
  // -> now on /totp: this is where the agent calls raiseHand()

  // the scripted "human", typing through the handoff UI:
  if (msUntilNextStep() < 5_000) await Bun.sleep(msUntilNextStep() + 100)
  const code = totp(app.totpSecret)              // 6 digits, string, zero-padded

  await page.waitForSelector('[data-testid="signed-in"]')  // the e2e's assertion
} finally {
  await app.kill()                               // never optional
}
```

Nine things that will otherwise cost you an hour each:

1. **`app.url` already contains `?pt_token=`. Navigate to it verbatim.** The
   browser's *first* request to that host must carry the token; after that the
   `__pt_preview` cookie carries everything, including form POSTs and redirects.
   If you need another path, use the exported `previewPath(app.url, "/totp")` —
   `new URL("/totp", app.url)` silently drops the query and earns a 401.
2. **A TOTP code lives at most 30 s and the app tolerates ±1 step (~90 s total).**
   A human handoff that takes longer than that will fail on a stale code, and it
   will look like a handraise bug. Compute the code *when the human types it*,
   not when the handoff opens. `msUntilNextStep()` is exported for exactly this.
3. **Selectors are stable and named**: `username`, `password`, `login-submit`,
   `totp-code`, `totp-submit`, `signed-in`, `verified`, `error`, `logout`,
   `login-form`, `totp-form`, `not-found`. Assert on
   `[data-testid="signed-in"]`; its text is `Signed in as <user>`.
4. **The code field is one input, not six boxes.** Deliberate: the scripted human
   types six characters into one field. No per-digit focus juggling.
5. **`kill()` in a `finally`, always.** Two concurrent sandboxes on this plan,
   and your e2e will want one for the target app *and* one for the handraise
   relay — that is the whole budget. A leak blocks the next run for the full
   idle timeout. `startTestApp` already retries `429 ConcurrencyLimitError` with
   exponential backoff (6 attempts, 2 s → 20 s), so a busy sibling is a queue,
   not a failure, but it does mean start-up can take much longer than 3 s when
   slots are contended. Budget for it in the e2e timeout.
6. **The sandbox timeout is a rolling idle window** and defaults to 10 minutes
   here (`{ timeoutMs }` to change it). A handoff where a human reads their phone
   is idle time. If the e2e pauses for minutes, extend it.
7. **A failed run's first diagnostic is `/var/log/testapp.log`** in the sandbox —
   one JSON line per request, including `credentials_ok` and `code_ok`. That
   answers "did the human's code even arrive, and was it wrong?" in one look.
8. **Wrong credentials and wrong codes answer `401`, not `200`.** If you add a
   crawl that asserts "zero 4xx", exclude the deliberate-failure steps.
9. **The app is the *target*, not the product.** It is intentionally boring.
   Do not assert on its copy beyond the testids above.

---

## 6. Two one-line changes for the supervisor

Neither is mine to make (I own `test-app/**` only), both are trivial:

1. **`tsconfig.json`** — `include` is `["src", "e2e"]`, so the root
   `bunx tsc --noEmit` does not see `test-app/`. I added `test-app/tsconfig.json`
   (`extends ../tsconfig.json`) so `bunx tsc --noEmit -p test-app` works today,
   and Agent B's e2e will drag `test-app/*.ts` into the root check transitively
   as soon as it imports `startTestApp`. Adding `"test-app"` to the root
   `include` makes that explicit rather than accidental.
2. **`biome.json`** — `files.includes` is `["src/**", "e2e/**", "*.json"]`, so
   `biome check .` skips `test-app/` entirely. My files are already formatted and
   linted against exactly the repo's rules (via a copy of the config, because the
   real one ignores the path), so adding `"test-app/**"` to `includes` costs
   nothing and changes no file.

Also worth adding to CI once it exists: **`bun test-app/embed-app.ts --check`**.
It fails when `guest-source.ts` is stale — the one way this design can silently
deploy yesterday's app.

Nothing is committed; that is yours after review.
