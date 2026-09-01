/**
 * The demo the clip is made of: the agent does the boring part, you do the one
 * step a machine should not fake.
 *
 *   bun --env-file=.env --env-file=demo/.env demo/github-2fa.ts
 *
 * Put a throwaway GitHub account in `demo/.env` (gitignored, never
 * committed — copy demo/.env.example):
 *
 *   GITHUB_USER=...
 *   GITHUB_PASSWORD=...
 *
 * The agent opens the login page, types the credentials, and stops at the 2FA
 * prompt. A QR code appears; scan it, type the six digits on your phone, tap
 * "Hand back to agent", and the agent carries on signed in.
 *
 * Run it a second time and it skips the whole login: the first run saves the
 * session the handoff earned to `demo/.session.json` (gitignored — it holds
 * live cookies). Delete that file to do the handoff again.
 */
import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright-core"
import { raiseHand } from "../src/index"

const SESSION_FILE = new URL("./.session.json", import.meta.url).pathname
const LOGIN_URL = "https://github.com/login"
const HOME_URL = "https://github.com/"

const user = process.env.GITHUB_USER
const password = process.env.GITHUB_PASSWORD

async function readSession(): Promise<string | undefined> {
  const file = Bun.file(SESSION_FILE)
  return (await file.exists()) ? SESSION_FILE : undefined
}

/** Signed-in GitHub always exposes the user menu; the login page never does. */
async function isSignedIn(page: Page): Promise<boolean> {
  return (
    (await page.locator('[data-login], nav[aria-label="User menu"]').count()) >
    0
  )
}

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY ?? "" })
const browser = await solari.launch()

try {
  const saved = await readSession()
  const context = saved
    ? await browser.newContext({ storageState: saved })
    : await browser.newContext()
  // SAFETY: `@solarisdk/browser` returns patchright-core's Page, a Playwright
  // fork with the runtime surface handraise uses; the declarations differ only
  // in optional-property variance. The e2e drives this same cast.
  const page = (await context.newPage()) as Page

  if (saved) {
    await page.goto(HOME_URL)
    if (await isSignedIn(page)) {
      console.log(
        "\nsigned in with the session the last handoff earned — no 2FA this time.",
      )
      console.log(`delete ${SESSION_FILE} to run the handoff again.\n`)
      process.exit(0)
    }
    console.log("saved session is stale; logging in again.\n")
  }

  if (!user || !password) {
    console.error(
      "Set GITHUB_USER and GITHUB_PASSWORD in .env (use a throwaway account).",
    )
    process.exit(1)
  }

  await page.goto(LOGIN_URL)
  await page.locator("#login_field").fill(user)
  await page.locator("#password").fill(password)
  await page
    .locator('input[type="submit"], button[type="submit"]')
    .first()
    .click()
  await page.waitForLoadState("domcontentloaded")

  if (await isSignedIn(page)) {
    console.log("signed in without a second factor — nothing to hand off.")
    process.exit(0)
  }

  console.log(`agent stopped at: ${page.url()}`)

  const result = await raiseHand(page, {
    reason: "GitHub is asking for a 2FA code",
    timeoutMs: 4 * 60_000,
    onEvent: (event) =>
      console.log(
        `\nhandoff ${event.outcome} in ${event.durationMs}ms — relay up in ${event.relayColdStartMs}ms, ` +
          `${event.framesSent} frames / ${Math.round(event.bytesSent / 1024)} KB, ` +
          `${event.inputsApplied} inputs`,
      ),
  })

  if (result.outcome !== "resolved") {
    console.error(`\nhandoff ended as ${result.outcome} — not signed in.`)
    process.exit(1)
  }

  await page.waitForLoadState("domcontentloaded")
  console.log(
    (await isSignedIn(page))
      ? "\nsigned in. the agent is driving again."
      : `\nhanded back, now at ${page.url()}`,
  )

  if (result.storageState) {
    await Bun.write(SESSION_FILE, JSON.stringify(result.storageState, null, 2))
    console.log(
      `saved the session to ${SESSION_FILE} — run this again and it skips the 2FA.`,
    )
  }
} finally {
  await browser.close()
  await solari.close()
}
