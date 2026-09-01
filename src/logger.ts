/**
 * A pluggable structured logger.
 *
 * handraise emits one context-rich wide event per handoff (see `HandoffEvent`
 * in ./events.ts) plus a handful of narrow warn/error lines on the failure
 * paths. Everything goes through this interface so a caller can send it to
 * their own sink; the default writes JSON lines to the console.
 *
 * The methods take an `event` name (a stable, low-cardinality string you can
 * group by) and a bag of high-cardinality `fields`. Never put a secret in
 * `fields`: no `pt_token`, no API key, no frame bytes, no typed characters.
 */

/**
 * Wide-event fields. This is the serialisation boundary itself — the values are
 * handed straight to the sink (JSON for `consoleLogger`), so `unknown` is the
 * honest value type here rather than a leak of an unparsed input.
 */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the logger *is* the I/O boundary these fields cross; they are serialised, never read back as a domain value.
export type LogFields = Record<string, unknown>

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

type Level = "debug" | "info" | "warn" | "error"

/** One JSON line: level, event, a timestamp, then the caller's fields. */
function line(level: Level, event: string, fields?: LogFields): string {
  return JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...fields,
  })
}

/**
 * The default. `debug`/`info` go to stdout, `warn`/`error` to stderr, so the
 * wide event and the diagnostics land where a log collector expects them.
 */
export const consoleLogger: Logger = {
  debug(event, fields) {
    console.log(line("debug", event, fields))
  },
  info(event, fields) {
    console.log(line("info", event, fields))
  },
  warn(event, fields) {
    console.error(line("warn", event, fields))
  },
  error(event, fields) {
    console.error(line("error", event, fields))
  },
}

/** Swallows everything. For tests, or to silence handraise entirely. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
