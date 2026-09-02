/**
 * `probeFocus` against a real Chromium, because there is nothing to test
 * otherwise: the whole module is one `page.evaluate` body, and a fake page
 * would only prove that the fake returns what the fake was told to return.
 * No Solari and no API key, so this is safe as a CI gate.
 *
 *   bun test src/core/focus.test.ts
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { type Browser, chromium, type Page } from "playwright-core"
import type { FocusKind } from "../relay/protocol"
import { probeFocus } from "./focus"

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
}, 30000)

afterAll(async () => {
  await browser.close()
})

/** A page with `html` in its body, at a fixed viewport so boxes are stable. */
async function open(html: string): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
  })
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>body { margin: 0 } input, select { box-sizing: border-box }</style>
    ${html}`)
  return page
}

/** The label `probeFocus` reports for the focused `#field` of `html`. */
async function labelOf(html: string): Promise<string | null> {
  const page = await open(html)
  await page.focus("#field")
  const probe = await probeFocus(page)
  await page.close()
  return probe.label
}

/** The kind `probeFocus` reports for the focused `#field` of `html`. */
async function kindOf(html: string): Promise<FocusKind> {
  const page = await open(html)
  await page.focus("#field")
  const probe = await probeFocus(page)
  await page.close()
  return probe.kind
}

test("a labelled input reports its box, its label text and its kind", async () => {
  const page = await open(`
    <label for="field">Password</label>
    <input id="field" type="password"
      style="position: absolute; left: 40px; top: 80px; width: 200px; height: 30px">`)
  await page.focus("#field")

  const probe = await probeFocus(page)
  await page.close()

  expect(probe.label).toBe("Password")
  expect(probe.rect).toEqual({ x: 40, y: 80, width: 200, height: 30 })
  expect(probe.kind).toBe("password")
})

test("nothing focused reports no rect and no label", async () => {
  const page = await open(`<p>Just some text.</p>`)

  const probe = await probeFocus(page)
  await page.close()

  // The page reports <body> as the active element; that is not a field.
  expect(probe).toEqual({ rect: null, label: null, kind: "text" })
})

test("a wrapping label wins over aria-label", async () => {
  expect(
    await labelOf(`<label>Confirmation code <input id="field"
      aria-label="otp" placeholder="123456"></label>`),
  ).toBe("Confirmation code")
})

test("aria-label wins over placeholder and name", async () => {
  expect(
    await labelOf(
      `<input id="field" aria-label="Card number" placeholder="1234 5678" name="cc">`,
    ),
  ).toBe("Card number")
})

test("an unlabelled field falls back to placeholder, then name, then type", async () => {
  expect(
    await labelOf(`<input id="field" placeholder="Street" name="s1">`),
  ).toBe("Street")
  expect(await labelOf(`<input id="field" name="street_line_1">`)).toBe(
    "street_line_1",
  )
  expect(await labelOf(`<input id="field" type="email">`)).toBe("email")
})

test("a long label is trimmed, collapsed and cut to 40 characters", async () => {
  const label = await labelOf(
    `<label for="field">   Enter   the six-digit code we just sent to your phone
     </label><input id="field">`,
  )
  expect(label).toBe("Enter the six-digit code we just sent to")
  expect(label?.length).toBe(40)
})

test("a zero-sized field has nothing to draw around", async () => {
  const page = await open(
    `<input id="field" style="width: 0; height: 0; border: 0; padding: 0">`,
  )
  await page.focus("#field")

  const probe = await probeFocus(page)
  await page.close()

  expect(probe).toEqual({ rect: null, label: null, kind: "text" })
})

test("the field's own value never leaves the page", async () => {
  const page = await open(`<input id="field" name="otp" value="314159">`)
  await page.focus("#field")

  const probe = await probeFocus(page)
  await page.close()

  // The human's OTP or password must not ride along in any field of the probe.
  expect(JSON.stringify(probe)).not.toContain("314159")
})

test("a closed page yields no focus instead of throwing", async () => {
  const page = await open(`<input id="field" aria-label="gone">`)
  await page.close()

  expect(await probeFocus(page)).toEqual({
    rect: null,
    label: null,
    kind: "text",
  })
})

/**
 * The kind exists so the phone can switch its own field to a numeric keypad
 * with `autocomplete="one-time-code"` — which is the difference between iOS
 * offering the SMS code and the human retyping it from another app. It is
 * derived from attributes only, never from the value, for the same reason the
 * label is.
 */
test("a password field is a password even when it is named like a code", async () => {
  // type wins over the name, or a "passcode" field would offer autofill from
  // Messages and put the human's password in a numeric keypad.
  expect(
    await kindOf(`<input id="field" type="password" name="passcode">`),
  ).toBe("password")
})

test("a one-time-code field is recognised by autocomplete, shape or name", async () => {
  expect(await kindOf(`<input id="field" autocomplete="one-time-code">`)).toBe(
    "otp",
  )
  // The shape of every SMS-code box: digits only, four to eight of them.
  expect(
    await kindOf(`<input id="field" inputmode="numeric" maxlength="6">`),
  ).toBe("otp")
  expect(
    await kindOf(`<label for="field">Verification code</label>
      <input id="field">`),
  ).toBe("otp")
  expect(await kindOf(`<input id="field" name="totp_token">`)).toBe("otp")
})

test("an ordinary field is text, and a long numeric field is not an OTP", async () => {
  expect(await kindOf(`<input id="field" type="email" name="email">`)).toBe(
    "text",
  )
  // A 16-digit card number is numeric and is not a one-time code.
  expect(
    await kindOf(`<input id="field" inputmode="numeric" maxlength="16"
      aria-label="Card number">`),
  ).toBe("text")
})
