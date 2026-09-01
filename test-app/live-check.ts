/**
 * Live proof: deploy the test app into a real Solari sandbox and drive the whole
 * login -> TOTP -> /account flow from outside, through the public preview URL.
 *
 *   bun --env-file=.env test-app/live-check.ts
 *
 * `fetch` has no cookie jar and does not carry cookies across redirects, so the
 * jar and the redirect chain are both handled by hand — and every URL keeps its
 * `?pt_token=`, because a non-browser client never gets the `__pt_preview`
 * cookie granted to it (spikes/s1-report.md §5.2).
 *
 * Prints one JSON line of timings and exits non-zero if any step is wrong.
 */
import { previewPath, startTestApp } from "./deploy"
import { msUntilNextStep, totp } from "./totp"

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey)
  throw new Error("SOLARI_API_KEY is not set (use: bun --env-file=.env ...)")

const cookies = new Map<string, string>()

function absorb(response: Response): void {
  for (const raw of response.headers.getSetCookie()) {
    const [pair = ""] = raw.split(";")
    const equals = pair.indexOf("=")
    if (equals === -1) continue
    const name = pair.slice(0, equals).trim()
    const value = pair.slice(equals + 1).trim()
    if (value === "" || /max-age=0/i.test(raw)) cookies.delete(name)
    else cookies.set(name, value)
  }
}

async function call(
  baseUrl: string,
  path: string,
  body?: URLSearchParams,
): Promise<Response> {
  const headers = new Headers()
  if (cookies.size > 0) {
    headers.set(
      "cookie",
      [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    )
  }
  const init: RequestInit = body
    ? { method: "POST", body, headers, redirect: "manual" }
    : { method: "GET", headers, redirect: "manual" }
  const response = await fetch(previewPath(baseUrl, path), init)
  absorb(response)
  return response
}

function check(
  label: string,
  actual: string | number,
  expected: string | number,
): void {
  if (actual !== expected)
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
}

const startedAt = Date.now()
const app = await startTestApp({ apiKey, timeoutMs: 5 * 60_000 })
const bootMs = Date.now() - startedAt

try {
  const loginPageAt = Date.now()
  const loginPage = await call(app.url, "/")
  const loginHtml = await loginPage.text()
  check("GET / status", loginPage.status, 200)
  check(
    "GET / has a POST form",
    String(loginHtml.includes('method="post"')),
    "true",
  )

  const loginAt = Date.now()
  const login = await call(
    app.url,
    "/login",
    new URLSearchParams([
      ["username", app.user],
      ["password", app.pass],
    ]),
  )
  await login.text()
  check("POST /login status", login.status, 303)
  check("POST /login location", String(login.headers.get("location")), "/totp")

  const totpPage = await call(app.url, "/totp")
  const totpHtml = await totpPage.text()
  check("GET /totp status", totpPage.status, 200)
  check(
    "GET /totp has one code input",
    String((totpHtml.match(/name="code"/g) ?? []).length),
    "1",
  )

  const wrong = await call(
    app.url,
    "/totp",
    new URLSearchParams([["code", "000000"]]),
  )
  await wrong.text()
  check("POST /totp with a bad code", wrong.status, 401)

  // A code minted right before a step boundary can expire in flight.
  if (msUntilNextStep() < 2_000) await Bun.sleep(msUntilNextStep() + 100)
  const codeAt = Date.now()
  const verified = await call(
    app.url,
    "/totp",
    new URLSearchParams([["code", totp(app.totpSecret)]]),
  )
  await verified.text()
  check("POST /totp status", verified.status, 303)
  check(
    "POST /totp location",
    String(verified.headers.get("location")),
    "/account",
  )

  const account = await call(app.url, "/account")
  const accountHtml = await account.text()
  check("GET /account status", account.status, 200)
  check(
    "account has the assertable heading",
    String(accountHtml.includes('data-testid="signed-in"')),
    "true",
  )
  check(
    "account names the user",
    String(accountHtml.includes(`Signed in as ${app.user}`)),
    "true",
  )

  console.log(
    JSON.stringify({
      evt: "live_check_passed",
      sandboxId: app.sandboxId,
      previewHost: new URL(app.url).host,
      coldStartMs: bootMs,
      loginPageMs: loginAt - loginPageAt,
      loginToTotpMs: codeAt - loginAt,
      verifyToAccountMs: Date.now() - codeAt,
      totalMs: Date.now() - startedAt,
    }),
  )
} catch (error) {
  console.error("live check FAILED:", error)
  process.exitCode = 1
} finally {
  await app.kill()
  console.log(
    JSON.stringify({ evt: "sandbox_killed", sandboxId: app.sandboxId }),
  )
}
