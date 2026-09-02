/**
 * Which field on the remote page the human is typing into.
 *
 * The phone shows a live JPEG, so a caret is a few grey pixels the human will
 * not find on a 6-inch screen. This module answers the two questions the
 * mobile UI needs — *where* is the focused field, and *what is it called* — so
 * it can draw a ring around it and label the keyboard bar.
 *
 * Two platform facts shape the implementation (docs/measurements/03-cdp-input-injection.md):
 *
 * 1. `page.evaluate` runs in an **isolated world**. Page globals are not
 *    readable, but the DOM is shared, so `document.activeElement` and
 *    `getBoundingClientRect()` are exactly right and nothing else is needed.
 * 2. The remote page is hostile by assumption — it is whatever site the agent
 *    got stuck on. So the probe reads structure (labels, attributes) and never
 *    the field's `value`: that value is the human's password or OTP, and it
 *    must not leave the page.
 *
 * The probe never throws. It is called opportunistically after input, and the
 * Solari session can die or navigate mid-call; "no focus" is the honest answer
 * to every one of those, and it is one the phone can render.
 */
import type { Page } from "playwright-core"

import type { FocusKind, FocusRect } from "../relay/protocol"

export interface FocusProbe {
  /** The focused field's box in CSS viewport pixels, or null if there is none. */
  rect: FocusRect | null
  /** A human-readable field name, or null when nothing is focused. */
  label: string | null
  /** What the field takes, so the phone can pick its own keyboard for it. */
  kind: FocusKind
}

/** Nothing is focused. Also the state the phone starts in, before any probe. */
export const NO_FOCUS: FocusProbe = { rect: null, label: null, kind: "text" }

/**
 * Runs inside the remote page. Self-contained on purpose: `page.evaluate`
 * serialises this function and re-parses it over there, so it can close over
 * nothing from this module.
 */
function readFocus(): FocusProbe {
  /** Long enough for "Confirmation code", short enough for a phone's bar. */
  const MAX_LABEL_CHARS = 40
  /** What every SMS-code box looks like: digits only, four to eight of them. */
  const OTP_MIN_LENGTH = 4
  const OTP_MAX_LENGTH = 8
  const OTP_WORDS = /otp|one.?time|verification|2fa|totp|code/i
  const tidy = (text: string | null | undefined): string =>
    (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS)

  const element = document.activeElement
  // A page with nothing focused reports `body` (or, before the first paint,
  // `documentElement`). Neither is a field the human is typing into.
  if (
    !element ||
    element === document.body ||
    element === document.documentElement
  ) {
    return { rect: null, label: null, kind: "text" }
  }

  const box = element.getBoundingClientRect()
  // A hidden or collapsed element is focusable but has nothing to draw around.
  if (box.width <= 0 || box.height <= 0) {
    return { rect: null, label: null, kind: "text" }
  }

  const id = element.getAttribute("id")
  const forLabel = id
    ? document.querySelector(`label[for="${CSS.escape(id)}"]`)
    : null

  // Attributes only, in the order a person would read them. `value` is
  // deliberately absent: it is the secret the human came here to type.
  const label =
    [
      tidy(forLabel?.textContent),
      tidy(element.closest("label")?.textContent),
      tidy(element.getAttribute("aria-label")),
      tidy(element.getAttribute("placeholder")),
      tidy(element.getAttribute("name")),
      tidy(element.getAttribute("type")),
      tidy(element.tagName.toLowerCase()),
    ].find((candidate) => candidate.length > 0) ?? null

  // Attributes again, for the same reason: the phone needs to know it is
  // holding a password or an SMS code, and the one thing that must never be
  // consulted to find that out is what has been typed into it.
  const maxLength = Number(element.getAttribute("maxlength") ?? "0")
  const named = [
    element.getAttribute("name") ?? "",
    id ?? "",
    element.getAttribute("aria-label") ?? "",
    forLabel?.textContent ?? "",
    element.closest("label")?.textContent ?? "",
  ].join(" ")
  const numericAndShort =
    element.getAttribute("inputmode") === "numeric" &&
    maxLength >= OTP_MIN_LENGTH &&
    maxLength <= OTP_MAX_LENGTH

  let kind: FocusKind = "text"
  // `type` first and alone: a field called "passcode" that takes a password is
  // a password. Getting that order wrong would put a secret into a numeric
  // keypad and offer to autofill it from Messages.
  if (element.getAttribute("type") === "password") kind = "password"
  else if (
    (element.getAttribute("autocomplete") ?? "").includes("one-time-code") ||
    numericAndShort ||
    OTP_WORDS.test(named)
  ) {
    kind = "otp"
  }

  return {
    // Whole pixels: the phone scales these down by 4x or more, so a fraction
    // buys nothing and only makes the change-detection noisier.
    rect: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
    label,
    kind,
  }
}

/**
 * Ask the remote page what is focused. One round trip, never throws: a dead
 * session, a navigation mid-call or a page that refuses evaluation all come
 * back as `NO_FOCUS`.
 */
export async function probeFocus(page: Page): Promise<FocusProbe> {
  try {
    return await page.evaluate(readFocus)
  } catch {
    return NO_FOCUS
  }
}
