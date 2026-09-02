/**
 * The LLM-facing surface. Everything here is what a model reads or is bound
 * by — the schema it fills in and the one refusal the tool makes on its own.
 *
 *   bun test src/tool.test.ts
 */
import { expect, test } from "bun:test"
import type { Page } from "playwright-core"

import { createNeedHumanTool, needHumanToolSpec } from "./tool"

/**
 * A page the tool must never reach: every test here stops before `raiseHand`.
 */
// SAFETY: the refusal under test happens before the page is touched, so no
// member of Page is ever read from this object.
const UNUSED_PAGE = {} as Page

test("the spec offers both modes and names the choice between them", () => {
  const { properties, required } = needHumanToolSpec.inputSchema
  expect(properties.mode.enum).toEqual(["takeover", "approval"])
  // `action` stays optional in the schema: the tool, not JSON Schema, is what
  // rejects an approval without one, and its message tells the model how.
  expect(required).toEqual(["reason"])

  // The description has to make the difference decidable by a model that has
  // only this text — "cannot" versus "not allowed to".
  expect(needHumanToolSpec.description).toContain("cannot do it yourself")
  expect(needHumanToolSpec.description).toContain("not allowed to decide alone")
})

test("an approval without an action is refused, and says what is missing", async () => {
  const needHuman = createNeedHumanTool(UNUSED_PAGE)

  const asking = needHuman({
    mode: "approval",
    reason: "I may not move money without a human",
  })

  // Silently downgrading to a takeover would put a blank question on a phone
  // and hand the browser over instead of asking about a step.
  await expect(asking).rejects.toThrow(/needHuman: mode "approval" needs an/)
})

test("a takeover call needs no action and is the default", () => {
  const spec = needHumanToolSpec.inputSchema.properties
  expect(spec.mode.description).toContain("default")
  expect(spec.action.description).toContain('Required with mode "approval"')
})
