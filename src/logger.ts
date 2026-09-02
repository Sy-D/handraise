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
 * Full structured logging: `debug`/`info` to stdout, `warn`/`error` to stderr,
 * so the wide event and the diagnostics land where a log collector expects
 * them. Opt-in — pass `logger: consoleLogger` to get the one `handoff` JSON
 * line per handoff.
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

/**
 * The default: a library should not write to stdout uninvited. Warnings and
 * errors still reach stderr because they describe failure paths the caller
 * would otherwise debug blind; `debug`/`info` — including the per-handoff wide
 * event — are dropped. Pass `consoleLogger` (or your own sink) to collect them,
 * or use `onEvent` for just the wide event.
 */
export const quietLogger: Logger = {
  debug() {},
  info() {},
  warn(event, fields) {
    consoleLogger.warn(event, fields)
  },
  error(event, fields) {
    consoleLogger.error(event, fields)
  },
}

/**
 * Wrap a logger so a failure in it can never end a handoff.
 *
 * `Logger` is the caller's object: a pino instance over a closed transport, a
 * socket that went away, a sink that decided a field was unserialisable, a
 * shipper whose methods are `async` and reject. Most
 * of handraise's log calls sit inside a `catch` or a promise callback on the
 * failure path, where a throw would either escape `raiseHand` after a human
 * has already been shown the URL or reject a promise nobody is awaiting — and
 * an unhandled rejection ends the agent's process. A broken logger may cost a
 * log line. It may not cost the browser session.
 *
 * Wrapping once, where the logger enters handraise, beats a try/catch at every
 * call site: it also covers the calls made by everything the logger is passed
 * on to.
 */
export function safeLogger(inner: Logger): Logger {
  const swallow = (write: () => void): void => {
    try {
      // Two throws to contain, not one. `write()` covers the synchronous
      // throw *and* the throwing property getter, because the method is read
      // inside this call. The declared return type is `void`, but TypeScript
      // accepts an `async` method there, so what actually comes back may be a
      // promise — one nobody holds, whose rejection ends the process. The
      // handler below is attached in the same tick it is created, so the
      // rejection is already spoken for before the runtime looks.
      const result = write()
      // `Promise.resolve` adopts a promise and wraps anything else, so a
      // logger that returns `undefined` costs one resolved microtask.
      Promise.resolve(result).catch(() => undefined)
    } catch {
      // Nothing to report this with — the reporter is what broke.
    }
  }
  return {
    debug: (event, fields) => swallow(() => inner.debug(event, fields)),
    info: (event, fields) => swallow(() => inner.info(event, fields)),
    warn: (event, fields) => swallow(() => inner.warn(event, fields)),
    error: (event, fields) => swallow(() => inner.error(event, fields)),
  }
}
