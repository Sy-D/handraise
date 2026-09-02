/**
 * Drives test-app/guest/app.js exactly the way the e2e will: a real `node`
 * process on a free local port, the full login -> TOTP -> /account flow over
 * `fetch`, with redirects followed by hand so the cookies are visible.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { totp } from "./totp"

const APP_PATH = new URL("./guest/app.js", import.meta.url).pathname
const USER = "grace"
const PASS = "hopper 1906"
/** Fixed, so a failure is reproducible; the app never sees it in plain text. */
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"

let baseUrl = ""
let app: ReturnType<typeof Bun.spawn> | undefined

/** Cookie jar: `fetch` has none, and the whole flow is cookie-carried. */
class CookieJar {
  private readonly cookies = new Map<string, string>()

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair = ""] = raw.split(";")
      const equals = pair.indexOf("=")
      if (equals === -1) continue
      const name = pair.slice(0, equals).trim()
      const value = pair.slice(equals + 1).trim()
      if (value === "" || /max-age=0/i.test(raw)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  header(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ")
  }

  names(): string[] {
    return [...this.cookies.keys()]
  }
}

async function request(
  jar: CookieJar,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie !== "") headers.set("cookie", cookie)
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    redirect: "manual",
    headers,
  })
  jar.absorb(response)
  return response
}

function form(fields: readonly (readonly [string, string])[]): RequestInit {
  return {
    method: "POST",
    body: new URLSearchParams(fields.map(([k, v]) => [k, v])),
  }
}

/** A 6-digit code that is guaranteed to be outside the app's +/-1 step window. */
function wrongCode(): string {
  const now = Date.now()
  const accepted = new Set(
    [-1, 0, 1].map((drift) => totp(SECRET, { atMs: now + drift * 30_000 })),
  )
  for (let n = 0; n < 1000; n++) {
    const candidate = String(n).padStart(6, "0")
    if (!accepted.has(candidate)) return candidate
  }
  throw new Error("every candidate collided with an accepted code")
}

/** Log in and land on the TOTP step. Returns the jar holding the pending cookie. */
async function loginToTotpStep(): Promise<CookieJar> {
  const jar = new CookieJar()
  const response = await request(
    jar,
    "/login",
    form([
      ["username", USER],
      ["password", PASS],
    ]),
  )
  expect(response.status).toBe(303)
  return jar
}

beforeAll(async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") })
  const port = probe.port
  await probe.stop(true)
  baseUrl = `http://127.0.0.1:${port}`

  app = Bun.spawn(["node", APP_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      TOTP_SECRET: SECRET,
      APP_USER: USER,
      APP_PASS: PASS,
    },
    stdout: "ignore",
    stderr: "inherit",
  })

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const ok = await fetch(`${baseUrl}/healthz`)
      .then((response) => response.status === 200)
      .catch(() => false)
    if (ok) return
    await Bun.sleep(50)
  }
  throw new Error("test app did not become healthy within 10s")
})

afterAll(() => {
  app?.kill()
})

test("GET /healthz answers 200 ok", async () => {
  const response = await fetch(`${baseUrl}/healthz`)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("ok")
})

test("GET / serves a POST login form that needs no JavaScript", async () => {
  const response = await fetch(baseUrl)
  const html = await response.text()
  expect(response.status).toBe(200)
  expect(html).toContain('method="post"')
  expect(html).toContain('action="/login"')
  expect(html).toContain('name="username"')
  expect(html).toContain('name="password"')
  expect(html).not.toContain("<script")
})

test("POST /login rejects a wrong password without issuing a cookie", async () => {
  const jar = new CookieJar()
  const response = await request(
    jar,
    "/login",
    form([
      ["username", USER],
      ["password", "not the password"],
    ]),
  )
  const html = await response.text()
  expect(response.status).toBe(401)
  expect(html).toContain('data-testid="error"')
  expect(html).toContain("Wrong username or password")
  expect(jar.names()).toEqual([])
})

test("POST /login rejects a wrong username", async () => {
  const jar = new CookieJar()
  const response = await request(
    jar,
    "/login",
    form([
      ["username", "hopper"],
      ["password", PASS],
    ]),
  )
  expect(response.status).toBe(401)
  expect(jar.names()).toEqual([])
})

test("POST /login accepts the credentials and redirects to the TOTP step", async () => {
  const jar = await loginToTotpStep()
  expect(jar.names()).toEqual(["hr_pending"])
})

test("GET /totp shows exactly one code input", async () => {
  const jar = await loginToTotpStep()
  const response = await request(jar, "/totp")
  const html = await response.text()
  expect(response.status).toBe(200)
  expect(html).toContain('data-testid="totp-code"')
  expect(html.match(/name="code"/g)).toHaveLength(1)
  expect(html).toContain('method="post"')
})

test("GET /totp without a pending cookie bounces back to the login page", async () => {
  const response = await fetch(`${baseUrl}/totp`, { redirect: "manual" })
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/")
})

test("POST /totp rejects a code from outside the tolerance window", async () => {
  const jar = await loginToTotpStep()
  const response = await request(jar, "/totp", form([["code", wrongCode()]]))
  const html = await response.text()
  expect(response.status).toBe(401)
  expect(html).toContain("That code is not valid")
  expect(jar.names()).toEqual(["hr_pending"])
})

test("POST /totp rejects a code for a different secret", async () => {
  const jar = await loginToTotpStep()
  const other = totp("MZXW6YTBOI======MZXW6YTBOI======")
  const response = await request(jar, "/totp", form([["code", other]]))
  expect(response.status).toBe(401)
})

test("the correct code signs the session in and /account proves it", async () => {
  const jar = await loginToTotpStep()
  const code = totp(SECRET)

  const verified = await request(jar, "/totp", form([["code", code]]))
  expect(verified.status).toBe(303)
  expect(verified.headers.get("location")).toBe("/account")
  expect(jar.names()).toEqual(["hr_session"])

  const account = await request(jar, "/account")
  const html = await account.text()
  expect(account.status).toBe(200)
  expect(html).toContain('data-testid="signed-in"')
  expect(html).toContain(`Signed in as ${USER}`)
})

test("GET /account without a session bounces back to the login page", async () => {
  const response = await fetch(`${baseUrl}/account`, { redirect: "manual" })
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/")
})

test("a forged session cookie is rejected", async () => {
  const forged = Buffer.from(
    JSON.stringify({ user: USER, exp: Date.now() + 60_000 }),
  ).toString("base64url")
  const response = await fetch(`${baseUrl}/account`, {
    redirect: "manual",
    headers: { cookie: `hr_session=${forged}.notavalidsignature` },
  })
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/")
})

test("POST /logout clears the session", async () => {
  const jar = await loginToTotpStep()
  await request(jar, "/totp", form([["code", totp(SECRET)]]))
  expect(jar.names()).toEqual(["hr_session"])

  const response = await request(jar, "/logout", { method: "POST" })
  expect(response.status).toBe(303)
  expect(jar.names()).toEqual([])
})

/** Sign in the whole way, so the jar holds a session cookie. */
async function signIn(): Promise<CookieJar> {
  const jar = await loginToTotpStep()
  await request(jar, "/totp", form([["code", totp(SECRET)]]))
  expect(jar.names()).toEqual(["hr_session"])
  return jar
}

test("GET /transfer without a session bounces back to the login page", async () => {
  const response = await fetch(`${baseUrl}/transfer`, { redirect: "manual" })
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe("/")
})

test("GET /transfer serves an amount and a payee behind the session", async () => {
  const jar = await signIn()
  const response = await request(jar, "/transfer")
  const html = await response.text()
  expect(response.status).toBe(200)
  expect(html).toContain('data-testid="transfer-amount"')
  expect(html).toContain('data-testid="transfer-payee"')
  expect(html).toContain('data-testid="transfer-submit"')
  expect(html).toContain('method="post"')
})

test("POST /transfer rejects an amount that is not money", async () => {
  const jar = await signIn()
  const response = await request(
    jar,
    "/transfer",
    form([
      ["amount", "twelve"],
      ["payee", "Acme GmbH"],
    ]),
  )
  const html = await response.text()
  expect(response.status).toBe(400)
  expect(html).toContain("Enter an amount")
  expect(jar.names()).toEqual(["hr_session"])
})

test("POST /transfer rejects an empty payee", async () => {
  const jar = await signIn()
  const response = await request(
    jar,
    "/transfer",
    form([
      ["amount", "12430.00"],
      ["payee", "   "],
    ]),
  )
  expect(response.status).toBe(400)
  expect(await response.text()).toContain("Enter a payee name")
})

test("a submitted transfer shows up on the account page", async () => {
  const jar = await signIn()
  const sent = await request(
    jar,
    "/transfer",
    form([
      ["amount", "12430.00"],
      ["payee", "Acme GmbH"],
    ]),
  )
  expect(sent.status).toBe(303)
  expect(sent.headers.get("location")).toBe("/account")

  const account = await request(jar, "/account")
  const html = await account.text()
  expect(html).toContain('data-testid="transfer-done"')
  expect(html).toContain("Sent EUR 12430.00 to Acme GmbH")
})

test("an account page with no transfer shows no transfer receipt", async () => {
  const jar = await signIn()
  const html = await (await request(jar, "/account")).text()
  expect(html).not.toContain('data-testid="transfer-done"')
  expect(html).toContain('data-testid="transfer-link"')
})

test("an unknown path is a 404 page", async () => {
  const response = await fetch(`${baseUrl}/nope`)
  expect(response.status).toBe(404)
  expect(await response.text()).toContain('data-testid="not-found"')
})
