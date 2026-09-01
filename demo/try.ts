/**
 * Try handraise yourself, no setup beyond the API key:
 *
 *   bun --env-file=.env demo/try.ts   # braucht nur den Solari-Key
 *
 * A cloud browser opens the GitHub login page and immediately raises its
 * hand. Scan the QR code with your phone, and the live session appears in
 * your mobile browser — tap the form, type into it, scroll. Tap "Hand back
 * to agent" when you are done and watch the script finish with the outcome
 * and the handoff's wide event.
 */
import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright-core"
import { raiseHand } from "../src/index"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY ?? "" })

const browser = await solari.launch()
try {
  // SAFETY: `@solarisdk/browser` returns patchright-core's Page, a Playwright
  // fork with the identical runtime surface handraise uses (goto, context(),
  // newCDPSession). The declarations differ only in optional-property
  // variance under exactOptionalPropertyTypes; the e2e drives this same cast.
  const page = (await browser.newPage()) as Page
  await page.goto("https://github.com/login")
  console.log("browser is on", page.url())

  const result = await raiseHand(page, {
    reason: "Try it: drive this login page from your phone, then hand back.",
    timeoutMs: 4 * 60_000,
    // handraise itself is quiet: it writes nothing to stdout unless you ask.
    // `onEvent` is that ask — one wide event per handoff. Printed compactly
    // here; pass `logger: consoleLogger` instead for full JSON log lines.
    onEvent: (event) =>
      console.log(
        `\nhandoff ${event.outcome} in ${event.durationMs}ms — relay up in ${event.relayColdStartMs}ms, ` +
          `first frame ${event.firstFrameMs ?? "n/a"}ms, ${event.framesSent} frames / ` +
          `${Math.round(event.bytesSent / 1024)} KB, ${event.inputsApplied} inputs, ` +
          `${event.reconnects} reconnects`,
      ),
  })

  console.log(
    `\noutcome: ${result.outcome} after ${Math.round(result.durationMs / 1000)}s`,
  )
  if (result.storageState) {
    console.log(
      `storageState captured: ${result.storageState.cookies.length} cookies`,
    )
  }
} finally {
  await browser.close()
  await solari.close()
}
