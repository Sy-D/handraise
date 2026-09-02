/**
 * The other half of handraise, in one run:
 *
 *   bun --env-file=.env demo/approval.ts   # only needs the Solari key
 *
 * The agent is not stuck here. It has filled in a payment it is not allowed to
 * submit on its own, so it asks. Scan the QR code, read the amount off the
 * screenshot, and answer: Deny is one tap, Approve takes a 700ms hold. The
 * browser stays with the agent either way — nothing is injected into the page.
 */
import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright-core"
import { raiseHand } from "../src/index"

/** A payment the agent has filled in and stopped in front of. */
const PAYMENT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Acme — Confirm payment</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #111; }
  main { max-width: 520px; margin: 64px auto; background: #fff; border: 1px solid #e3e5e8; border-radius: 12px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 24px; }
  dl { display: grid; grid-template-columns: 140px 1fr; gap: 12px 16px; margin: 0 0 28px; }
  dt { color: #6b7280; } dd { margin: 0; font-weight: 600; }
  .total { font-size: 28px; }
  button { font: inherit; font-weight: 600; padding: 12px 20px; border-radius: 8px; border: 0; background: #111; color: #fff; }
</style></head>
<body><main>
  <h1>Confirm payment</h1>
  <dl>
    <dt>Payee</dt><dd>Acme GmbH</dd>
    <dt>IBAN</dt><dd>DE02 1203 0000 0000 2020 51</dd>
    <dt>Reference</dt><dd>Invoice 2026-0417</dd>
    <dt>Amount</dt><dd class="total">EUR 12,430.00</dd>
  </dl>
  <button type="button">Submit payment</button>
</main></body></html>`

const ACTION = "Submit the EUR 12,430.00 payment to Acme GmbH"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY ?? "" })

const browser = await solari.launch()
try {
  // SAFETY: `@solarisdk/browser` returns patchright-core's Page, a Playwright
  // fork with the identical runtime surface handraise uses (goto, context(),
  // screenshot). The declarations differ only in optional-property variance
  // under exactOptionalPropertyTypes; the e2e drives this same cast.
  const page = (await browser.newPage()) as Page
  await page.setContent(PAYMENT)

  const result = await raiseHand(page, {
    mode: "approval",
    reason: "The agent may not move money without a human",
    action: ACTION,
    timeoutMs: 4 * 60_000,
  })

  console.log(
    `\n${result.outcome} after ${Math.round(result.durationMs / 1000)}s — ` +
      (result.outcome === "approved"
        ? "the agent would submit the payment now."
        : "the agent leaves the payment unsubmitted."),
  )
} finally {
  await browser.close()
  await solari.close()
}
