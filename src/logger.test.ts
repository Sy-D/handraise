/**
 * The two shipped loggers. `consoleLogger` writes one structured JSON line per
 * call and never throws; `noopLogger` swallows everything. Both are on the hot
 * path of every handoff, so a throw here would break a handoff.
 *
 *   bun test src/
 */
import { afterEach, expect, test } from "bun:test"

import {
  consoleLogger,
  type LogFields,
  type Logger,
  noopLogger,
  quietLogger,
} from "./logger"

/** The console methods, captured so a test can restore them. */
const realLog = console.log
const realError = console.error

afterEach(() => {
  console.log = realLog
  console.error = realError
})

/** One decoded line the logger emitted, so a test can assert on its shape. */
interface Captured {
  stream: "out" | "err"
  parsed: LogFields
}

/** Redirect both console streams into an array of parsed JSON lines. */
function capture(): Captured[] {
  const lines: Captured[] = []
  console.log = (text: string) => {
    // SAFETY: consoleLogger.debug/info write exactly one JSON string; this test
    // owns the only calls made while the capture is installed.
    lines.push({
      stream: "out",
      parsed: JSON.parse(text) as LogFields,
    })
  }
  console.error = (text: string) => {
    // SAFETY: as above, for consoleLogger.warn/error.
    lines.push({
      stream: "err",
      parsed: JSON.parse(text) as LogFields,
    })
  }
  return lines
}

test("consoleLogger writes one JSON line per call with level, event and fields", () => {
  const lines = capture()
  consoleLogger.info("handoff", { outcome: "resolved", framesSent: 12 })

  expect(lines).toHaveLength(1)
  expect(lines[0]?.stream).toBe("out")
  expect(lines[0]?.parsed).toMatchObject({
    level: "info",
    event: "handoff",
    outcome: "resolved",
    framesSent: 12,
  })
  // A timestamp is always present, so every line is orderable on its own. It is
  // an ISO string, so the date/time separator is a cheap proof it is there.
  expect(String(lines[0]?.parsed.ts)).toContain("T")
})

test("consoleLogger routes debug/info to stdout and warn/error to stderr", () => {
  const lines = capture()
  consoleLogger.debug("d")
  consoleLogger.info("i")
  consoleLogger.warn("w")
  consoleLogger.error("e")

  expect(lines.map((entry) => `${entry.stream}:${entry.parsed.level}`)).toEqual(
    ["out:debug", "out:info", "err:warn", "err:error"],
  )
})

test("consoleLogger tolerates a call with no fields", () => {
  const lines = capture()
  expect(() => consoleLogger.info("bare")).not.toThrow()
  expect(lines[0]?.parsed).toMatchObject({ level: "info", event: "bare" })
})

test("noopLogger swallows every level and writes nothing", () => {
  const lines = capture()
  expect(() => {
    noopLogger.debug("d", { a: 1 })
    noopLogger.info("i", { b: 2 })
    noopLogger.warn("w")
    noopLogger.error("e")
  }).not.toThrow()
  expect(lines).toHaveLength(0)
})

test("both loggers satisfy the same interface", () => {
  // A compile-time check made runtime: swapping one for the other is the whole
  // point of the pluggable logger.
  const loggers: Logger[] = [consoleLogger, noopLogger]
  expect(loggers).toHaveLength(2)
})

test("quietLogger drops debug/info but forwards warn/error — the library default stays off stdout", () => {
  const lines = capture()
  quietLogger.debug("d")
  quietLogger.info("handoff", { outcome: "resolved" })
  quietLogger.warn("w", { detail: 1 })
  quietLogger.error("e")

  expect(lines.filter((l) => l.stream === "out")).toHaveLength(0)
  const err = lines.filter((l) => l.stream === "err")
  expect(err).toHaveLength(2)
  expect(err[0]?.parsed.event).toBe("w")
  expect(err[1]?.parsed.event).toBe("e")
})
