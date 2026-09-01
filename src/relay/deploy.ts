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

import { GUEST_SERVER_JS } from "./guest-source"
import { RELAY_PORT } from "./protocol"

const GUEST_DIR = "/opt/relay"
const GUEST_PATH = `${GUEST_DIR}/server.mjs`
const GUEST_LOG = "/var/log/relay.log"

/** Idle window for the sandbox. Comfortably longer than raiseHand's 15 min default. */
const DEFAULT_TIMEOUT_MS = 20 * 60_000

/**
 * The preview `pt_token` lives one hour (spikes/s1-report.md §3). A sandbox
 * that outlives its token would hand the phone and the agent an unannounced
 * 401 mid-handoff, so cap the idle window below that. A cleaner fix is to
 * re-mint the token via `previewUrl()`; for v1 the cap is enough.
 */
const MAX_TIMEOUT_MS = 55 * 60_000

/** Cold start measured at ~2.9s (spikes/s1-report.md); 30s is a generous ceiling. */
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
  /** Sandbox idle window in ms. Default: 20 minutes. */
  timeoutMs?: number
}

export interface RelayHandle {
  /** Public page for the human. Carries the `pt_token` that grants the cookie. */
  humanUrl: string
  /**
   * `wss://…/ws?role=agent&pt_token=…&k=…` — a non-browser client keeps no
   * cookie, and `k` is the secret that proves this side is the agent.
   */
  agentWsUrl: string
  /** Destroy the sandbox. Idempotent; safe to call from a `finally`. */
  kill(): Promise<void>
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Put a path (and optionally a role) on the preview URL while keeping its query
 * string. `new URL(path, previewUrl)` drops `?pt_token=` and earns a 401 — the
 * single easiest way to lose an hour here (spikes/s1-report.md §4.3).
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

async function createSandbox(
  client: SolariClient,
  timeoutMs: number,
): Promise<Sandbox> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.sandboxes.create({
        template: "base",
        timeoutMs,
        // Idle-timeout must destroy the relay, not pause it. A paused sandbox
        // keeps holding one of the plan's two slots (spikes/s4-report.md §4);
        // the relay holds no recoverable state, so killing it is correct.
        lifecycle: { onTimeout: "kill" },
      })
    } catch (error) {
      const collided = error instanceof ConcurrencyLimitError
      if (!collided || attempt >= CREATE_ATTEMPTS) throw error
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000))
    }
  }
}

/**
 * Poll the relay through the *public* URL, not the control channel: what has to
 * work is the path the phone will take, including the preview proxy and the
 * token.
 */
async function waitForHealth(healthUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    try {
      const response = await fetch(healthUrl, { cache: "no-store" })
      const body = await response.text()
      if (response.ok && body === "ok") return
    } catch {
      // The port is not routable yet; the retry below is the whole mechanism.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `handraise relay did not become healthy within ${READY_TIMEOUT_MS}ms`,
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
  const client = new SolariClient({ apiKey: options.apiKey })
  const requestedTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(requestedTimeoutMs, MAX_TIMEOUT_MS)
  if (requestedTimeoutMs > MAX_TIMEOUT_MS) {
    console.warn(
      `handraise: timeoutMs ${requestedTimeoutMs}ms exceeds the ${MAX_TIMEOUT_MS}ms preview-token lifetime; capping to ${MAX_TIMEOUT_MS}ms to avoid an unannounced 401 mid-handoff.`,
    )
  }
  // Only a client that holds this secret may claim role=agent. It is appended
  // to `agentWsUrl` alone, never to the human's link, so possession of the
  // handoff URL cannot be used to read the human's keystrokes.
  const agentKey = randomUUID()
  const sandbox = await createSandbox(client, timeoutMs)

  let killed = false
  const kill = async (): Promise<void> => {
    if (killed) return
    let lastError: unknown
    for (let attempt = 1; attempt <= KILL_ATTEMPTS; attempt++) {
      try {
        await sandbox.kill()
        killed = true
        return
      } catch (error) {
        // A 404 means the sandbox is already gone — the goal, not a failure.
        if (error instanceof GatewayError && error.status === 404) {
          killed = true
          return
        }
        lastError = error
        if (attempt < KILL_ATTEMPTS) {
          await sleep(Math.min(500 * 2 ** (attempt - 1), 4000))
        }
      }
    }
    // Surface it: the caller must not believe the relay is gone when it is not.
    throw new Error(
      `handraise: could not destroy the relay sandbox after ${KILL_ATTEMPTS} attempts; its public URL stays reachable until the idle timeout. Last error: ${String(lastError)}`,
    )
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
        `nohup node ${GUEST_PATH} ${RELAY_PORT} ${agentKey} >${GUEST_LOG} 2>&1 & sleep 0.2; echo started`,
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
      kill,
    }
  } catch (error) {
    await kill().catch((killError) => {
      console.error("handraise: could not release the relay sandbox", killError)
    })
    throw error
  }
}
