/**
 * The error contract itself: the class, the guard, and the promise that every
 * code is reachable from a test rather than only from a type.
 *
 *   bun test src/errors.test.ts
 */
import { expect, test } from "bun:test"

import {
  HandraiseError,
  type HandraiseErrorCode,
  isHandraiseError,
} from "./errors"

/**
 * Where each code is triggered for real. This is a type-level gate, not an
 * assertion: adding a member to `HandraiseErrorCode` without adding a line
 * here fails `tsc`, which is the cheapest way to keep "every code has a test"
 * true after the next feature.
 */
const COVERED_BY = {
  missing_api_key: "handoff.test.ts — a handoff with no key is refused",
  invalid_mode: "handoff.test.ts — an unknown mode is refused",
  empty_action:
    "handoff.test.ts and tool.test.ts — a blank approval action is refused",
  invalid_option:
    "handoff.test.ts — a humanGoneGraceMs below the floor, and an infinite one",
  browser_unusable: "handoff.test.ts — a closed or orphaned page is refused",
  relay_start_failed: "deploy.test.ts — an unreachable gateway",
  concurrency_limit: "deploy.test.ts — a gateway at its session cap",
  relay_not_ready: "deploy.test.ts — a public URL that never answers",
} satisfies Record<HandraiseErrorCode, string>

test("every code names the test that triggers it", () => {
  for (const [code, where] of Object.entries(COVERED_BY)) {
    expect(where).toContain(".test.ts")
    expect(code).not.toContain(" ")
  }
})

test("a handraise error carries its code, its name and its cause", () => {
  const cause = new Error("EAI_AGAIN api.getsolari.com")
  const error = new HandraiseError(
    "relay_start_failed",
    "the relay sandbox could not be started",
    { cause },
  )

  expect(error).toBeInstanceOf(Error)
  expect(error).toBeInstanceOf(HandraiseError)
  expect(error.code).toBe("relay_start_failed")
  // The name is what an unhandled rejection prints, and what a log line keeps.
  expect(error.name).toBe("HandraiseError")
  expect(String(error)).toStartWith("HandraiseError:")
  // Nothing is swallowed by the wrapping.
  expect(error.cause).toBe(cause)
  expect(error.stack ?? "").toContain("HandraiseError")
})

test("the guard narrows a caught value and refuses everything else", () => {
  expect(isHandraiseError(new HandraiseError("missing_api_key", "x"))).toBe(
    true,
  )
  // A plain Error carrying the same words is not the same thing: without the
  // class there is no code to branch on.
  expect(isHandraiseError(new Error("handraise: no API key"))).toBe(false)
  expect(isHandraiseError("missing_api_key")).toBe(false)
  expect(isHandraiseError(null)).toBe(false)

  // The point of the guard: a catch binding is `unknown`, and `code` has to be
  // readable off it without a cast.
  try {
    throw new HandraiseError("missing_api_key", "no key")
  } catch (error) {
    if (!isHandraiseError(error)) throw new Error("the guard did not narrow")
    expect(error.code).toBe("missing_api_key")
  }
})
