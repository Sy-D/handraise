/**
 * Stand up a handraise relay: one Solari sandbox running `guest/server.js`,
 * reachable from any phone through the sandbox's public preview URL.
 *
 * The sandbox exists only to be a public address with a WebSocket on it. It
 * never touches the browser session, and it holds no state worth recovering —
 * if it dies, the handoff dies, and that is the correct behaviour.
 */
import { randomUUID } from "node:crypto"

import {
  ConcurrencyLimitError,
  GatewayError,
  type Sandbox,
  SolariClient,
} from "@solarisdk/sdk"

import { HandraiseError, isHandraiseError } from "../errors"
import { type Logger, quietLogger } from "../logger"
import type { HandoffMode } from "../types"
import { GUEST_SERVER_JS } from "./guest-source"
import { RELAY_PORT } from "./protocol"

const GUEST_DIR = "/opt/relay"
const GUEST_PATH = `${GUEST_DIR}/server.mjs`
const GUEST_LOG = "/var/log/relay.log"

/** Idle window for the sandbox. Comfortably longer than raiseHand's 5 min default. */
const DEFAULT_TIMEOUT_MS = 20 * 60_000

/**
 * The preview `pt_token` lives one hour (docs/measurements/01-preview-transport.md §3). A sandbox
 * that outlives its token would hand the phone and the agent an unannounced
 * 401 mid-handoff, so cap the idle window below that. A cleaner fix is to
 * re-mint the token via `previewUrl()`; for v1 the cap is enough.
 */
const MAX_TIMEOUT_MS = 55 * 60_000

/** Cold start measured at ~2.9s (docs/measurements/01-preview-transport.md); 30s is a generous ceiling. */
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 250

/** The test plan allows 2 concurrent sandboxes; a parallel agent run will collide. */
const CREATE_ATTEMPTS = 6

/**
 * `kill()` destroys the sandbox and, with it, the public relay URL. A swallowed
 * failure would leave that URL — and its last frame — reachable until the idle
 * timeout, so a transient failure is retried before it is surfaced.
 */
const KILL_ATTEMPTS = 4

export interface StartRelayOptions {
  apiKey: string
  /**
   * What the relay lets the human do: drive the browser (`takeover`, the
   * default) or answer one question (`approval`). It is baked into the guest
   * process at boot, so the human's socket cannot talk it into the other set.
   */
  mode?: HandoffMode
  /** Sandbox idle window in ms. Default: 20 minutes. */
  timeoutMs?: number
  /** Gateway base URL. Defaults to the SDK's `https://api.getsolari.com`. */
  baseUrl?: string
  /** Where deploy diagnostics go. Defaults to `quietLogger` (warn/error only). */
  logger?: Logger
}

export interface RelayHandle {
  /** Public page for the human. Carries the `pt_token` that grants the cookie. */
  humanUrl: string
  /**
   * `wss://…/ws?role=agent&pt_token=…&k=…` — a non-browser client keeps no
   * cookie, and `k` is the secret that proves this side is the agent.
   */
  agentWsUrl: string
  /** Time from `startRelay()` entry to the public URL answering, in ms. */
  coldStartMs: number
  /** Destroy the sandbox. Idempotent; safe to call from a `finally`. */
  kill(): Promise<void>
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Put a path (and optionally a role) on the preview URL while keeping its query
 * string. `new URL(path, previewUrl)` drops `?pt_token=` and earns a 401 — the
 * single easiest way to lose an hour here (docs/measurements/01-preview-transport.md §4.3).
 */
function relayUrl(
  previewUrl: string,
  path: string,
  role?: "agent" | "human",
): string {
  const url = new URL(previewUrl)
  url.pathname = path
  if (role) url.searchParams.set("role", role)
  return url.toString()
}

/** The gateway normally returns the token inside the URL; belt and braces if it stops. */
function withToken(previewUrl: string, token: string | undefined): string {
  const url = new URL(previewUrl)
  if (token && !url.searchParams.has("pt_token"))
    url.searchParams.set("pt_token", token)
  return url.toString()
}

/** `?pt_token=<value>`, in any case, with `:` or whitespace as it is proxied around. */
const TOKEN_PARAM = /pt_token\s*[=:]\s*[^&;\s"'<>]+/gi

/**
 * A `pt_`-prefixed value, wherever it appears. Kept for the identifiers that
 * do carry that prefix; it is *not* the preview credential's shape.
 * Deliberately without `\b`: a percent-encoded `=` ends in a word character,
 * so a word boundary would not match there.
 */
const TOKEN_VALUE = /pt_[A-Za-z0-9._~-]{16,}/g

/**
 * The ways a dot arrives once something has escaped the text around it: a
 * percent-encoded path, an HTML error page. Both nets below key on the JWT's
 * two dots, so an encoded one is the cheapest way past either.
 */
const ENCODED_DOTS = ["%2E", "%2e", "&#46;"]

/** One base64url segment of a JWT, at the length a real one has. */
const JWT_SEGMENT = "[A-Za-z0-9_-]{20,}"

/** The separator between two of them, literal or escaped. */
const JWT_DOT = `(?:\\.|${ENCODED_DOTS.join("|")})`

/**
 * The credential's real grammar: three base64url segments separated by dots.
 * The preview token is a ~362-character JWT
 * (docs/measurements/01-preview-transport.md §3), so this is the rule that
 * catches it bare in prose — "invalid preview token eyJhbGci…" — or behind a
 * `%3D` neither rule above can see.
 */
const TOKEN_JWT = new RegExp(
  `${JWT_SEGMENT}${JWT_DOT}${JWT_SEGMENT}${JWT_DOT}${JWT_SEGMENT}`,
  "g",
)

/**
 * Short enough to be an accident rather than a credential. Blanking every
 * occurrence of a two-character `token` would shred the message instead of
 * redacting it, and an empty one would match everywhere.
 */
const MIN_TOKEN_LENGTH = 16

/**
 * Take the preview token out of anything that becomes an error message.
 *
 * Every URL handraise polls carries `?pt_token=…`, a live bearer credential
 * for the relay. A gateway or proxy that echoes the request URI in its error
 * body — a common default on 401 and 404, and common percent-encoded inside a
 * `?next=` parameter — would otherwise put that token into an exception
 * message, and exception messages end up in log aggregators.
 *
 * Pass `token` wherever the exact credential is known (it is, everywhere the
 * URL is at hand): that value and its percent-encoded form are removed by
 * comparison, which no proxy can outrun by inventing another way to quote it.
 * The three patterns are the net for the text where it is not known — the
 * credential's shape guessed from the outside, which is exactly the guess that
 * once let a real token through. Exported for `deploy.test.ts`.
 */
export function redactPreviewToken(text: string, token?: string): string {
  let redacted = text
  if (token !== undefined && token.length >= MIN_TOKEN_LENGTH) {
    for (const form of tokenForms(token))
      redacted = redacted.replaceAll(form, "[redacted]")
  }
  return redacted
    .replace(TOKEN_PARAM, "pt_token=[redacted]")
    .replace(TOKEN_VALUE, "pt_[redacted]")
    .replace(TOKEN_JWT, "[redacted]")
}

/**
 * The written forms of one exact value.
 *
 * A Set because a token made only of unreserved characters — a JWT is —
 * survives `encodeURIComponent` unchanged, so most of these collapse into one.
 * The dot variants are the ones that do not: `encodeURIComponent` leaves a dot
 * alone, and a proxy that escapes the whole path does not.
 */
function tokenForms(token: string): Set<string> {
  const written = [token, encodeURIComponent(token)]
  const forms = new Set(written)
  for (const form of written)
    for (const dot of ENCODED_DOTS) forms.add(form.replaceAll(".", dot))
  return forms
}

/**
 * The credential this URL carries, so it can be redacted by value instead of
 * by grammar. Returns nothing for a string that is not a URL: there is simply
 * no known token then, and the patterns above still apply.
 */
function previewTokenOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).searchParams.get("pt_token") ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The gateway's parsed error body. Named through the class that carries it
 * because the SDK does not export the type on its own.
 */
type GatewayErrorBody = NonNullable<GatewayError["body"]>

/** A `GatewayError` seen through the one field made of the gateway's own words. */
interface WithBody {
  body?: GatewayErrorBody
}

/**
 * The same body with every string in it redacted, shape unchanged.
 *
 * Through JSON rather than field by field: `code`, `error` and `message` are
 * what the type declares today, and the field a future gateway release puts
 * the request URI in is the one worth covering in advance. A body that
 * references itself makes this throw, which `redactedCause` catches.
 */
function redactedBody(
  body: GatewayErrorBody,
  token: string | undefined,
): GatewayErrorBody {
  // SAFETY: this re-parses text serialised one call earlier; redaction only
  // ever replaces a run of characters inside a JSON string value, so the
  // document is still the same shape.
  return JSON.parse(
    redactPreviewToken(JSON.stringify(body), token),
  ) as GatewayErrorBody
}

/**
 * How far a `cause` chain is followed. Deeper than any chain the SDK, undici
 * or this package builds, and finite, which is the point.
 */
const MAX_CAUSE_DEPTH = 8

/**
 * Replace one property with a redacted value, keeping the descriptor the
 * original had.
 *
 * A plain assignment onto an `Object.create` clone makes the property own and
 * *enumerable*. On a real `Error`, `message`, `stack` and `cause` are none of
 * those, and a consumer that does `JSON.stringify(error.cause)` into a log
 * payload would suddenly ship the whole stack.
 */
function redefine<T>(target: Error, key: string, value: T): void {
  const existing = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, {
    value,
    writable: existing?.writable ?? true,
    enumerable: existing?.enumerable ?? false,
    configurable: true,
  })
}

/**
 * What an error says, for a message being built out of it.
 *
 * Reading it runs the caller's code: `toString` reads `name` and `message`,
 * and either can be a getter that throws. A throw here would replace a coded
 * error with a raw one — the failure class this module exists to remove — so
 * an error that will not say what it is says that instead.
 */
function sentenceOf(cause: unknown): string {
  try {
    return String(cause)
  } catch {
    return "an error that could not be read"
  }
}

/**
 * The sentence and nothing else, for an error that cannot be copied.
 *
 * Reached when reading the original runs a getter that throws, or when its
 * body references itself. A partial copy would be worse than this one: it
 * would carry fields nothing has redacted.
 */
function unreadableCause(error: Error, token: string | undefined): Error {
  return new Error(redactPreviewToken(sentenceOf(error), token))
}

/**
 * A copy of an error with the credential out of everything foreign in it.
 *
 * `cause` exists so a caller keeps the original — `cause instanceof
 * ConcurrencyLimitError`, `cause.status === 429` — so the copy is built from
 * the prototype and the full property descriptors, and only the text is
 * rewritten: `message`, `stack`, a `GatewayError`'s parsed `body`, and
 * recursively the chain hanging off `cause` (`new Error(msg, { cause })`
 * installs that one non-enumerable, which is how a copy made by assignment
 * loses undici's root `ECONNREFUSED`). Without any of this a clean outer
 * message buys nothing: `console.error(error)`, pino's error serialiser and
 * every crash reporter print the whole chain.
 *
 * Descriptors are copied, not read: an accessor stays an accessor and is never
 * invoked here. That keeps a foreign getter from running inside a `catch`
 * whose job is to produce a coded error — at the price of not redacting what
 * such a getter would return, which nothing in the dependency tree has.
 */
function redactedCause(error: Error, token?: string): Error {
  return redactedChain(error, token, new Set(), 0)
}

/** One link, plus the `seen` set and the depth that make the recursion end. */
function redactedChain(
  error: Error,
  token: string | undefined,
  seen: Set<Error>,
  depth: number,
): Error {
  // A chain that points back at itself, or one deeper than any real chain.
  if (seen.has(error) || depth > MAX_CAUSE_DEPTH)
    return unreadableCause(error, token)
  seen.add(error)
  try {
    // SAFETY: `Object.create` returns a new object with `error`'s own
    // prototype, so it is an instance of the same class; the descriptors below
    // give it the same own properties, enumerable or not.
    const clone = Object.create(Object.getPrototypeOf(error)) as Error &
      WithBody
    Object.defineProperties(clone, Object.getOwnPropertyDescriptors(error))
    redefine(clone, "message", redactPreviewToken(error.message, token))
    if (error.stack !== undefined)
      redefine(clone, "stack", redactPreviewToken(error.stack, token))
    if (clone.body !== undefined)
      redefine(clone, "body", redactedBody(clone.body, token))
    if (clone.cause instanceof Error)
      redefine(
        clone,
        "cause",
        redactedChain(clone.cause, token, seen, depth + 1),
      )
    return clone
  } catch {
    // A getter that throws on the way in, a body that references itself: a
    // faithful copy is not worth an uncoded exception out of `startRelay`'s
    // catch, which is the failure class this module exists to remove.
    return unreadableCause(error, token)
  }
}

/**
 * Turn a failure from the SDK into the code the caller branches on.
 *
 * A 429 is the one worth telling apart: the account is at its concurrent
 * session cap, which is a "try again in a minute", not a "this is broken".
 * An error that already carries a code is passed through untouched.
 *
 * `token` is the preview credential when the caller has one — `startRelay`
 * does from the moment the sandbox answers — so the message and the `cause`
 * are redacted by value rather than by grammar. Exported for `deploy.test.ts`.
 */
export function relayStartError(
  cause: unknown,
  token?: string,
): HandraiseError {
  if (isHandraiseError(cause)) return cause
  if (cause instanceof ConcurrencyLimitError) {
    return new HandraiseError(
      "concurrency_limit",
      redactPreviewToken(
        `handraise: your Solari account is at its concurrent session limit, so the relay sandbox that gives the handoff its public URL could not be created. Free a session and retry. (${sentenceOf(cause)})`,
        token,
      ),
      { cause: redactedCause(cause, token) },
    )
  }
  return new HandraiseError(
    "relay_start_failed",
    redactPreviewToken(
      `handraise: the relay sandbox could not be started, so the handoff has no public URL and nobody has been asked for anything yet. ${sentenceOf(cause)}`,
      token,
    ),
    { cause: cause instanceof Error ? redactedCause(cause, token) : cause },
  )
}

/**
 * Create the relay's sandbox, waiting out a busy account.
 *
 * `attempts` is a parameter so `deploy.test.ts` can reach the mapping in one
 * request instead of sitting through the backoff; `startRelay` always uses the
 * shipped budget.
 */
export async function createSandbox(
  client: SolariClient,
  timeoutMs: number,
  attempts: number = CREATE_ATTEMPTS,
): Promise<Sandbox> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.sandboxes.create({
        template: "base",
        timeoutMs,
        // Idle-timeout must destroy the relay, not pause it. A paused sandbox
        // keeps holding one of the plan's two slots (docs/measurements/04-browser-session-lifetime.md §4);
        // the relay holds no recoverable state, so killing it is correct.
        lifecycle: { onTimeout: "kill" },
      })
    } catch (error) {
      const collided = error instanceof ConcurrencyLimitError
      if (!collided || attempt >= attempts) throw relayStartError(error)
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000))
    }
  }
}

/**
 * Destroy the sandbox, retrying a transient failure.
 *
 * A swallowed failure would leave the public relay URL — and its last frame —
 * reachable until the idle timeout, so the last one is surfaced. Deliberately
 * a plain `Error` and not a `HandraiseError`: both callers catch it and log
 * `relay_release_failed`, so it can never reach a `catch` around `raiseHand`,
 * and a code nobody can branch on is documentation for dead code.
 * `attempts` is a parameter for the same reason as in `createSandbox`, and
 * `token` is the preview credential when the caller knows it — `startRelay`
 * does once the sandbox has answered — so this message is redacted by value
 * and not only by grammar.
 */
export async function killSandbox(
  sandbox: Pick<Sandbox, "kill">,
  attempts: number = KILL_ATTEMPTS,
  token?: string,
): Promise<void> {
  let lastError: unknown
  // At least one attempt: "could not destroy it after 0 attempts" would be a
  // failure report for something that was never tried.
  const budget = Math.max(1, attempts)
  for (let attempt = 1; attempt <= budget; attempt++) {
    try {
      await sandbox.kill()
      return
    } catch (error) {
      // A 404 means the sandbox is already gone — the goal, not a failure.
      if (error instanceof GatewayError && error.status === 404) return
      lastError = error
      if (attempt < budget)
        await sleep(Math.min(500 * 2 ** (attempt - 1), 4000))
    }
  }
  throw new Error(
    redactPreviewToken(
      `handraise: could not destroy the relay sandbox after ${budget} attempts; its public URL stays reachable until the idle timeout. Last error: ${sentenceOf(lastError)}`,
      token,
    ),
    // The SDK's error, with the gateway's own words redacted — `cause` is
    // printed by every error serialiser that exists.
    {
      cause:
        lastError instanceof Error
          ? redactedCause(lastError, token)
          : lastError,
    },
  )
}

/**
 * Poll the relay through the *public* URL, not the control channel: what has to
 * work is the path the phone will take, including the preview proxy and the
 * token.
 */
export async function waitForHealth(
  healthUrl: string,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  // The one place the credential is known exactly: it is in the URL being
  // polled. Everything foreign that reaches `lastAnswer` is redacted against
  // that value, so the redaction does not depend on guessing the token's
  // shape — the guess that let a real one through.
  const token = previewTokenOf(healthUrl)
  // A deadline has no single cause, so what the URL last said is carried in
  // the message: "connection refused" and "502 from the preview proxy" are
  // different problems with the same code. The first attempt always writes it
  // and only a failure leaves the loop, so the throw at the end always has a
  // real one; the initial value below satisfies definite assignment.
  let lastAnswer = ""
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now()
    // The first attempt always runs: "did not answer" about a URL nobody asked
    // would be a lie. Every attempt after it needs budget left, because a
    // request that can only abort would replace the proxy's own answer — the
    // one useful thing in the message — with "The operation timed out".
    if (remaining <= 0 && attempt > 1) break
    try {
      const response = await fetch(healthUrl, {
        cache: "no-store",
        // Without this the deadline is only checked *between* requests, and a
        // preview route that accepts the connection and never answers — what
        // a port that is not wired up yet looks like from outside — would
        // hold the loop open for minutes with a live sandbox burning its idle
        // window. The abort lands in the catch below and the deadline check
        // ends the loop.
        signal: AbortSignal.timeout(Math.max(1, remaining)),
      })
      const body = await response.text()
      if (response.ok && body === "ok") return
      // The body is the preview proxy's, not ours: an error page that echoes
      // the request URI would otherwise quote the live `pt_token` back at us.
      // Redacted before it is cut, so no slice can leave a partial credential
      // without its prefix.
      lastAnswer = `HTTP ${response.status} ${redactPreviewToken(body, token).slice(0, 80)}`
    } catch (error) {
      // The port is not routable yet; the retry below is the whole mechanism.
      lastAnswer = redactPreviewToken(String(error), token)
    }
    if (Date.now() >= deadline) break
    await sleep(READY_POLL_MS)
  }
  // The only way out of the loop: success returns from inside it.
  throw new HandraiseError(
    "relay_not_ready",
    `handraise: the relay sandbox started but its public URL did not answer within ${timeoutMs}ms, so the handoff page would not have loaded on the phone. Last answer: ${lastAnswer}`,
  )
}

/**
 * Create a sandbox, deploy the relay into it, and return once the public URL
 * actually answers. Every failure path destroys the sandbox before it throws.
 */
export async function startRelay(
  options: StartRelayOptions,
): Promise<RelayHandle> {
  const startedAt = Date.now()
  const logger = options.logger ?? quietLogger
  const client = new SolariClient(
    options.baseUrl
      ? { apiKey: options.apiKey, baseUrl: options.baseUrl }
      : { apiKey: options.apiKey },
  )
  const requestedTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(requestedTimeoutMs, MAX_TIMEOUT_MS)
  if (requestedTimeoutMs > MAX_TIMEOUT_MS) {
    logger.warn("relay_timeout_capped", {
      requestedTimeoutMs,
      cappedToMs: MAX_TIMEOUT_MS,
      reason: "preview token lifetime; avoids an unannounced 401 mid-handoff",
    })
  }
  // Only a client that holds this secret may claim role=agent. It is appended
  // to `agentWsUrl` alone, never to the human's link, so possession of the
  // handoff URL cannot be used to read the human's keystrokes.
  const agentKey = randomUUID()
  // Fixed at boot, never taken from a message: the relay's whole job in
  // approval mode is to refuse what the takeover UI would have sent.
  //
  // Constructed here rather than passed through, because it is interpolated
  // into the `sh -c` line below. `raiseHand` already rejects anything that is
  // not one of these two words, and TypeScript closes it for its own callers,
  // but this package ships as JavaScript: the value that reaches a shell is
  // one of two literals written in this file, whatever the caller supplied.
  const mode: HandoffMode =
    options.mode === "approval" ? "approval" : "takeover"
  const sandbox = await createSandbox(client, timeoutMs)

  // Known only once `previewUrl()` answers, and every message built after that
  // — the teardown failure, the wrapped start failure — can quote it. Declared
  // out here so `kill` and the `catch` can both reach it.
  let previewUrl: string | undefined

  let killed = false
  const kill = async (): Promise<void> => {
    if (killed) return
    // Throws if it cannot: the caller must not believe the relay is gone when
    // it is not. Both callers log it as `relay_release_failed`.
    await killSandbox(sandbox, KILL_ATTEMPTS, previewTokenOf(previewUrl))
    killed = true
  }

  try {
    await sandbox.connect()
    await sandbox.commands.run("sh", { args: ["-c", `mkdir -p ${GUEST_DIR}`] })
    await sandbox.files.write(GUEST_PATH, GUEST_SERVER_JS)
    // `commands.run` is not a shell and it waits for exit, so background the
    // server through `sh -c`. The `sleep 0.2` gives the fork time to bind, and
    // the log redirect is the only diagnostic left if it fails to boot.
    await sandbox.commands.run("sh", {
      args: [
        "-c",
        `nohup node ${GUEST_PATH} ${RELAY_PORT} ${agentKey} ${mode} >${GUEST_LOG} 2>&1 & sleep 0.2; echo started`,
      ],
    })

    const preview = await sandbox.previewUrl(RELAY_PORT)
    previewUrl = withToken(preview.url, preview.token)
    await waitForHealth(relayUrl(previewUrl, "/healthz"))

    // https and wss are both "special" URL schemes, so a textual swap is exact.
    const agentUrl = new URL(relayUrl(previewUrl, "/ws", "agent"))
    agentUrl.searchParams.set("k", agentKey)
    return {
      humanUrl: relayUrl(previewUrl, "/"),
      agentWsUrl: agentUrl.toString().replace(/^https:/, "wss:"),
      coldStartMs: Date.now() - startedAt,
      kill,
    }
  } catch (error) {
    await kill().catch((killError) => {
      logger.error("relay_release_failed", { error: String(killError) })
    })
    // Everything from `connect()` to the health poll is "the relay did not come
    // up"; `relayStartError` keeps the more specific codes (a 429, a public URL
    // that never answered) as they are.
    throw relayStartError(error, previewTokenOf(previewUrl))
  }
}
