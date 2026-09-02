/**
 * Deploy the test app (test-app/guest/app.js) into a Solari sandbox and hand
 * back a publicly reachable URL, so a Solari cloud browser can surf to it.
 *
 * The e2e uses this as its 2FA target:
 *
 *   const app = await startTestApp({ apiKey: process.env.SOLARI_API_KEY! })
 *   try {
 *     // drive a browser to app.url, log in with app.user / app.pass,
 *     // then type totp(app.totpSecret) into the 2FA form.
 *   } finally {
 *     await app.kill()
 *   }
 *
 * Always kill in a `finally`: the test plan allows two concurrent sandboxes and
 * a leaked one blocks the next run for its whole idle timeout.
 */

import { randomBytes } from "node:crypto"
import { SolariClient } from "@solarisdk/sdk"
import QRCode from "qrcode"
import { GUEST_APP_JS } from "./guest-source"
import { generateTotpSecret } from "./totp"

/** The in-guest port the test app listens on, and the port we ask a preview for. */
export const TEST_APP_PORT = 4000
const APP_DIR = "/opt/testapp"
const LOG_PATH = "/var/log/testapp.log"
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const READY_TIMEOUT_MS = 60_000
const CREATE_ATTEMPTS = 6

export interface TestAppHandle {
  /** Public preview URL, including the `?pt_token=` the first request needs. */
  url: string
  /**
   * The link inside the QR code on `/qr`, which `/verified` accepts and
   * nothing else does. The QR-passthrough e2e asserts that the human's phone
   * was handed exactly this string.
   */
  verifyUrl: string
  /** Base32 TOTP secret the app was booted with. Feed it to totp() from ./totp.ts. */
  totpSecret: string
  user: string
  pass: string
  /** The sandbox id, for stray cleanup and log correlation. */
  sandboxId: string
  /** Destroy the sandbox. Idempotent; safe to call from a `finally`. */
  kill(): Promise<void>
}

export interface StartTestAppOptions {
  apiKey: string
  /** Sandbox idle timeout. Default: 10 minutes. */
  timeoutMs?: number
  /** Username the app accepts. Default: "ada". */
  user?: string
  /** Password the app accepts. Default: "solaris". */
  pass?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build a URL on the preview host while keeping `?pt_token=`.
 *
 * `new URL("/healthz", previewUrl)` drops the query string and earns a 401.
 * See docs/measurements/01-preview-transport.md §5.1.
 */
export function previewPath(previewUrl: string, pathname: string): string {
  const url = new URL(previewUrl)
  url.pathname = pathname
  return url.toString()
}

/**
 * The link a scanned code leads to: the app's own `/verified`, carrying both
 * the preview token the proxy needs and the one-time token the app checks.
 */
function verifyLink(previewUrl: string, token: string): string {
  const url = new URL(previewUrl)
  url.pathname = "/verified"
  url.searchParams.set("token", token)
  return url.toString()
}

/** Single-quote a value for `sh -c`, so a password with spaces cannot break out. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function waitForHealthz(url: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  const healthz = previewPath(url, "/healthz")
  let attempts = 0
  let lastStatus = 0
  while (Date.now() < deadline) {
    attempts++
    try {
      const response = await fetch(healthz, { redirect: "manual" })
      lastStatus = response.status
      await response.text()
      if (response.status === 200) return attempts
    } catch {
      lastStatus = 0
    }
    await sleep(250)
  }
  throw new Error(
    `test app never became healthy (last status ${lastStatus}, ${attempts} attempts)`,
  )
}

/**
 * Create a sandbox, retrying the plan's concurrency limit.
 *
 * Two sandboxes may run at once; a sibling test holding both slots answers with
 * 429 ConcurrencyLimitError. That is a queue, not a failure.
 */
async function createSandbox(client: SolariClient, timeoutMs: number) {
  let delayMs = 2_000
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.sandboxes.create({ template: "base", timeoutMs })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const isConcurrency = /429|concurren/i.test(message)
      if (!isConcurrency || attempt >= CREATE_ATTEMPTS) throw error
      await sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 20_000)
    }
  }
}

/** Boot the test app in a fresh sandbox and wait until it answers publicly. */
export async function startTestApp(
  options: StartTestAppOptions,
): Promise<TestAppHandle> {
  const user = options.user ?? "ada"
  const pass = options.pass ?? "solaris"
  const totpSecret = generateTotpSecret()
  const sandbox = await createSandbox(
    new SolariClient({ apiKey: options.apiKey }),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )

  try {
    await sandbox.connect()
    await sandbox.commands.run("sh", { args: ["-c", `mkdir -p ${APP_DIR}`] })
    await sandbox.files.write(`${APP_DIR}/app.mjs`, GUEST_APP_JS)

    const env = [
      `PORT=${TEST_APP_PORT}`,
      `TOTP_SECRET=${shellQuote(totpSecret)}`,
      `APP_USER=${shellQuote(user)}`,
      `APP_PASS=${shellQuote(pass)}`,
    ].join(" ")
    // `commands.run` is not a shell and it blocks until exit, so background the
    // server through `sh -c` and give it a beat to bind before sh exits.
    const started = await sandbox.commands.run("sh", {
      args: [
        "-c",
        `${env} nohup node ${APP_DIR}/app.mjs >${LOG_PATH} 2>&1 & sleep 0.3; echo started`,
      ],
    })
    if (started.exitCode !== 0) {
      throw new Error(`failed to start test app: ${started.stderr ?? ""}`)
    }

    const { url } = await sandbox.previewUrl(TEST_APP_PORT)
    await waitForHealthz(url, READY_TIMEOUT_MS)

    // Only now is there an absolute link to put in a QR code, so the code is
    // rendered here and written beside the app rather than being baked into
    // it: the app has no dependencies and no encoder of its own.
    const verifyToken = randomBytes(9).toString("base64url")
    const verifyUrl = verifyLink(url, verifyToken)
    await sandbox.files.write(
      `${APP_DIR}/qr.json`,
      JSON.stringify({
        token: verifyToken,
        // The default margin, which is the specification's four-module quiet
        // zone. A narrower one is the first thing a decoder loses.
        png: await QRCode.toDataURL(verifyUrl, { scale: 6 }),
      }),
    )

    return {
      url,
      verifyUrl,
      totpSecret,
      user,
      pass,
      sandboxId: sandbox.id,
      kill: () => sandbox.kill(),
    }
  } catch (error) {
    await sandbox.kill().catch(() => undefined)
    throw error
  }
}
