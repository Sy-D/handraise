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

/**
 * Turn a failure from the SDK into the code the caller branches on.
 *
 * A 429 is the one worth telling apart: the account is at its concurrent
 * session cap, which is a "try again in a minute", not a "this is broken".
 * An error that already carries a code is passed through untouched.
 */
function relayStartError(cause: unknown): HandraiseError {
  if (isHandraiseError(cause)) return cause
  if (cause instanceof ConcurrencyLimitError) {
    return new HandraiseError(
      "concurrency_limit",
      `handraise: your Solari account is at its concurrent session limit, so the relay sandbox that gives the handoff its public URL could not be created. Free a session and retry. (${cause.message})`,
      { cause },
    )
  }
  return new HandraiseError(
    "relay_start_failed",
    `handraise: the relay sandbox could not be started, so the handoff has no public URL and nobody has been asked for anything yet. ${String(cause)}`,
    { cause },
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
 * reachable until the idle timeout, so the last one is surfaced with a code.
 * `attempts` is a parameter for the same reason as in `createSandbox`.
 */
export async function killSandbox(
  sandbox: Pick<Sandbox, "kill">,
  attempts: number = KILL_ATTEMPTS,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await sandbox.kill()
      return
    } catch (error) {
      // A 404 means the sandbox is already gone — the goal, not a failure.
      if (error instanceof GatewayError && error.status === 404) return
      lastError = error
      if (attempt < attempts)
        await sleep(Math.min(500 * 2 ** (attempt - 1), 4000))
    }
  }
  throw new HandraiseError(
    "relay_kill_failed",
    `handraise: could not destroy the relay sandbox after ${attempts} attempts; its public URL stays reachable until the idle timeout. Last error: ${String(lastError)}`,
    { cause: lastError },
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
  // A deadline has no single cause, so what the URL last said is carried in
  // the message: "connection refused" and "502 from the preview proxy" are
  // different problems with the same code.
  let lastAnswer = "nothing was tried"
  for (;;) {
    try {
      const response = await fetch(healthUrl, { cache: "no-store" })
      const body = await response.text()
      if (response.ok && body === "ok") return
      lastAnswer = `HTTP ${response.status} ${body.slice(0, 80)}`
    } catch (error) {
      // The port is not routable yet; the retry below is the whole mechanism.
      lastAnswer = String(error)
    }
    if (Date.now() >= deadline) {
      throw new HandraiseError(
        "relay_not_ready",
        `handraise: the relay sandbox started but its public URL did not answer within ${timeoutMs}ms, so the handoff page would not have loaded on the phone. Last answer: ${lastAnswer}`,
      )
    }
    await sleep(READY_POLL_MS)
  }
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

  let killed = false
  const kill = async (): Promise<void> => {
    if (killed) return
    // Throws `relay_kill_failed` if it cannot: the caller must not believe the
    // relay is gone when it is not.
    await killSandbox(sandbox)
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
    const previewUrl = withToken(preview.url, preview.token)
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
    throw relayStartError(error)
  }
}
