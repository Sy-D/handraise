#!/usr/bin/env node

/**
 * `npx handraise` — the whole product in one command, with nothing to set up.
 *
 * A reviewer with a Solari API key and no clone of this repo runs it and gets,
 * in about fifteen seconds, a QR code in the terminal. They scan it, land on a
 * live view of a cloud browser stuck at a 2FA wall, type six digits with their
 * thumbs, tap "Hand back to agent", and watch the agent continue.
 *
 * What it stands up, and why there are two sandboxes:
 *
 *   1. The demo target. A one-page 2FA portal (src/cli-guest.ts), deployed into
 *      a Solari sandbox so the cloud browser has a real public site to fail on.
 *      `test-app/` would have been the richer target, but it is not in the
 *      published package — the CLI has to carry its own.
 *   2. The relay. `raiseHand()` creates and destroys this one itself; it is the
 *      public address the phone connects to.
 *
 * That is exactly the two concurrent sandboxes the plan allows, which is why
 * every path here — including Ctrl-C — tears them down.
 *
 * The terminal prints the TOTP code the portal expects, refreshed as it rolls
 * over. That is deliberate and it is said out loud in the output: this demo
 * shows the handoff mechanics, not secret-keeping. The interesting part is that
 * a human types the code on a phone into a browser running in someone else's
 * cloud, and the agent keeps the session afterwards.
 */

import { createRequire } from "node:module"
import { Solari } from "@solarisdk/browser"
import {
  ConcurrencyLimitError,
  type Sandbox,
  SolariClient,
} from "@solarisdk/sdk"
import type { Page } from "playwright-core"
import {
  generatePortalSecret,
  msUntilNextCode,
  PORTAL_PORT,
  PORTAL_SERVER_JS,
  totp,
} from "./cli-guest.js"
import type { HandoffEvent, HandoffResult } from "./index.js"
import { raiseHand } from "./index.js"

/** How long the demo waits for a human. Overridable, mainly so smoke tests are quick. */
const DEFAULT_HANDOFF_TIMEOUT_MS = 4 * 60_000

const PORTAL_DIR = "/opt/portal"
const PORTAL_LOG = "/var/log/portal.log"
/** Comfortably longer than the handoff budget; `onTimeout: kill` frees the slot. */
const PORTAL_SANDBOX_TIMEOUT_MS = 15 * 60_000
/** Cold start measured at ~3s (spikes/s1-report.md); this is a generous ceiling. */
const PORTAL_READY_TIMEOUT_MS = 45_000
const PORTAL_POLL_MS = 250
/** The plan allows two concurrent sandboxes, so a busy account is a queue. */
const CREATE_ATTEMPTS = 5

/**
 * Reprint the code a beat after it rolls over, not on a fixed 25s interval:
 * a code printed two seconds before the step boundary is a code the human
 * types too late.
 */
const CODE_REPRINT_SLACK_MS = 300

const HELP = `handraise — hand a stuck cloud browser to a human on their phone.

Usage
  npx handraise             run the demo end to end
  npx handraise --help      show this text
  npx handraise --version   print the version

What happens
  handraise deploys a one-page 2FA portal into a Solari sandbox and opens it in
  a Solari cloud browser. The agent gets as far as the code prompt and stops.
  A QR code appears here; scan it, type the six digits on your phone, then tap
  "Hand back to agent". The agent carries on with the session you signed in.

  The six digits are printed in this terminal, refreshed as they roll over.
  The demo shows the handoff mechanics, not secret-keeping.

Environment
  SOLARI_API_KEY             required — https://console.getsolari.com
  HANDRAISE_CLI_TIMEOUT_MS   how long to wait for you. Default 240000 (4 min).

Exit codes
  0   you handed back or aborted, or nobody scanned before the timeout
  1   something broke: no API key, a sandbox never came up, the session died

Library docs: https://github.com/Sy-D/handraise`

const MISSING_KEY = `handraise needs a Solari API key.

  1. Create one at https://console.getsolari.com
  2. export SOLARI_API_KEY=sk-...
  3. npx handraise`

// SAFETY: this is our own package.json, one directory above both src/cli.ts and
// dist/cli.js, and npm guarantees it has a string `version`.
const pkg = createRequire(import.meta.url)("../package.json") as {
  version: string
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const seconds = (ms: number): string => (ms / 1000).toFixed(1)

/** Flush stdout before exiting: a piped stdout write is async and can be lost. */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write("", () => resolve())
  })
}

function handoffTimeoutMs(): number {
  const raw = process.env.HANDRAISE_CLI_TIMEOUT_MS
  if (!raw) return DEFAULT_HANDOFF_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `handraise: ignoring HANDRAISE_CLI_TIMEOUT_MS=${raw} — not a positive number.`,
    )
    return DEFAULT_HANDOFF_TIMEOUT_MS
  }
  return parsed
}

// ------------------------------------------------------------ the portal ----

interface Portal {
  /** Public preview URL, `?pt_token=` included — the browser needs it. */
  url: string
  /** Base32 secret the portal booted with; the terminal prints its codes. */
  secret: string
  /** Destroy the sandbox. Idempotent, safe from a `finally`. */
  kill: () => Promise<void>
}

/**
 * Put a path on the preview URL while keeping its query string.
 * `new URL(path, previewUrl)` drops `?pt_token=` and earns a 401
 * (spikes/s1-report.md §4.3) — the single easiest hour to lose here.
 */
function previewPath(previewUrl: string, pathname: string): string {
  const url = new URL(previewUrl)
  url.pathname = pathname
  return url.toString()
}

async function createSandbox(client: SolariClient): Promise<Sandbox> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.sandboxes.create({
        template: "base",
        timeoutMs: PORTAL_SANDBOX_TIMEOUT_MS,
        // Kill, not pause: a paused sandbox keeps holding one of the two slots
        // (spikes/s4-report.md §4), and the portal holds nothing worth keeping.
        lifecycle: { onTimeout: "kill" },
      })
    } catch (error) {
      if (
        !(error instanceof ConcurrencyLimitError) ||
        attempt >= CREATE_ATTEMPTS
      )
        throw error
      console.log(
        `handraise: your account is at its sandbox limit; retrying (${attempt}/${CREATE_ATTEMPTS})…`,
      )
      await sleep(Math.min(2000 * 2 ** (attempt - 1), 10_000))
    }
  }
}

/** Poll the public URL, because that is the path the cloud browser will take. */
async function waitForPortal(url: string): Promise<void> {
  const healthz = previewPath(url, "/healthz")
  const deadline = Date.now() + PORTAL_READY_TIMEOUT_MS
  for (;;) {
    try {
      const response = await fetch(healthz, { cache: "no-store" })
      if (response.ok && (await response.text()) === "ok") return
    } catch {
      // Not routable yet; the retry below is the whole mechanism.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the demo portal did not answer within ${PORTAL_READY_TIMEOUT_MS}ms`,
      )
    }
    await sleep(PORTAL_POLL_MS)
  }
}

/** Boot the 2FA portal in a fresh sandbox and return once it answers publicly. */
async function startPortal(apiKey: string): Promise<Portal> {
  const secret = generatePortalSecret()
  const sandbox = await createSandbox(new SolariClient({ apiKey }))
  try {
    await sandbox.connect()
    await sandbox.commands.run("sh", { args: ["-c", `mkdir -p ${PORTAL_DIR}`] })
    await sandbox.files.write(`${PORTAL_DIR}/app.mjs`, PORTAL_SERVER_JS)
    // `commands.run` is not a shell and waits for exit, so background the server
    // through `sh -c` and give the fork a beat to bind. The secret is base32, so
    // no quote can appear in it; the quotes are for a shell that word-splits.
    const started = await sandbox.commands.run("sh", {
      args: [
        "-c",
        `PORT=${PORTAL_PORT} TOTP_SECRET='${secret}' nohup node ${PORTAL_DIR}/app.mjs >${PORTAL_LOG} 2>&1 & sleep 0.3; echo started`,
      ],
    })
    if (started.exitCode !== 0) {
      throw new Error(
        `the demo portal failed to start: ${started.stderr ?? ""}`,
      )
    }
    const preview = await sandbox.previewUrl(PORTAL_PORT)
    await waitForPortal(preview.url)
    return { url: preview.url, secret, kill: () => sandbox.kill() }
  } catch (error) {
    await sandbox.kill().catch(() => undefined)
    throw error
  }
}

// -------------------------------------------------------- terminal output ----

/**
 * Print the code the portal expects, and reprint it each time it rolls over.
 *
 * The first print is deferred by a turn on purpose. `raiseHand()` calls
 * `onUrl` and then prints the QR code synchronously in the same tick, so a
 * `setTimeout(…, 0)` scheduled from `onUrl` reliably lands *under* the QR
 * code — where a person looks after scanning it — instead of above it.
 */
function startCodeTicker(secret: string): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = (): void => {
    if (stopped) return
    const validForMs = msUntilNextCode()
    console.log(
      `handraise: current code ${totp(secret)} — you'll type this on your phone (good for ${Math.round(validForMs / 1000)}s)`,
    )
    timer = setTimeout(tick, validForMs + CODE_REPRINT_SLACK_MS)
  }
  timer = setTimeout(tick, 0)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/** The portal's success page carries this marker; nothing else on it does. */
async function reachedSignedIn(page: Page): Promise<boolean> {
  try {
    return (await page.locator('[data-testid="signed-in"]').count()) > 0
  } catch {
    // A dead browser session cannot answer. That is reported as the outcome.
    return false
  }
}

/** The closing lines, and the exit code that goes with them. */
function summarise(
  result: HandoffResult,
  signedIn: boolean,
  event: HandoffEvent | undefined,
  elapsedMs: number,
): number {
  const took = `after ${seconds(result.durationMs)}s`
  if (result.outcome === "resolved") {
    console.log(
      signedIn
        ? `\nhandoff resolved ${took} — the portal is signed in, and the agent has the session.`
        : `\nhandoff resolved ${took} — you handed back before the portal was signed in.`,
    )
  } else if (result.outcome === "timeout") {
    console.log(
      `\nhandoff timed out ${took} — nobody picked it up. Run it again and scan the code.`,
    )
  } else if (result.outcome === "aborted") {
    console.log(`\nhandoff aborted ${took} — you gave it back untouched.`)
  } else {
    console.error(
      `\nhandoff ended as disconnected ${took} — the Solari browser session died mid-handoff.`,
    )
  }
  if (event) {
    console.log(
      `relay up in ${seconds(event.relayColdStartMs)}s, ${event.framesSent} frames / ` +
        `${Math.round(event.bytesSent / 1024)} KB streamed, ${event.inputsApplied} inputs from the phone.`,
    )
  }
  console.log(
    `this demo used 2 sandboxes + 1 browser session for ~${Math.round(elapsedMs / 1000)}s.`,
  )
  return result.outcome === "disconnected" ? 1 : 0
}

// ------------------------------------------------------------- the demo -----

type Release = () => Promise<void>

/** Tear down in reverse order of creation, and never let one failure hide another. */
async function releaseAll(releases: Release[]): Promise<void> {
  for (let release = releases.pop(); release; release = releases.pop()) {
    await release().catch((error) => {
      console.error(`handraise: cleanup failed — ${String(error)}`)
    })
  }
}

async function runDemo(apiKey: string, releases: Release[]): Promise<number> {
  const startedAt = Date.now()
  console.log("handraise: booting a 2FA portal in a Solari sandbox…")
  const portal = await startPortal(apiKey)
  releases.push(portal.kill)

  console.log("handraise: launching a Solari cloud browser…")
  const solari = new Solari({ apiKey })
  releases.push(() => solari.close())
  const browser = await solari.launch()
  releases.push(() => browser.close())
  const context = await browser.newContext()
  // SAFETY: `@solarisdk/browser` returns patchright-core's Page, a Playwright
  // fork with the runtime surface handraise uses; the declarations differ only
  // in optional-property variance. demo/ and e2e/ drive this same cast.
  const page = (await context.newPage()) as Page
  await page.goto(portal.url)
  console.log(
    "handraise: the agent is at the 2FA wall and cannot go further on its own.",
  )

  let event: HandoffEvent | undefined
  let stopTicker: () => void = () => undefined
  const result = await raiseHand(page, {
    reason: "This portal wants a TOTP code — solve it from your phone",
    timeoutMs: handoffTimeoutMs(),
    onUrl: () => {
      stopTicker = startCodeTicker(portal.secret)
    },
    onEvent: (handoff) => {
      event = handoff
    },
  })
  stopTicker()

  return summarise(
    result,
    await reachedSignedIn(page),
    event,
    Date.now() - startedAt,
  )
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP)
    return 0
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(pkg.version)
    return 0
  }
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    console.error(MISSING_KEY)
    return 1
  }

  const releases: Release[] = []
  // Ctrl-C during a handoff would otherwise leave a sandbox holding one of the
  // account's two slots until its idle timeout, blocking the next run.
  const onSignal = (): void => {
    console.log("\nhandraise: interrupted — releasing the sandboxes…")
    void releaseAll(releases)
      .then(flushStdout)
      .finally(() => process.exit(130))
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  try {
    return await runDemo(apiKey, releases)
  } catch (error) {
    console.error(
      `\nhandraise: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    await releaseAll(releases)
  }
}

const code = await main(process.argv.slice(2))
await flushStdout()
// Explicit: a Solari browser can leave a socket behind, and a demo that does
// not return the prompt is a bad demo.
process.exit(code)
