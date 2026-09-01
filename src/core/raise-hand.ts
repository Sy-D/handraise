/**
 * `raiseHand()` — the whole product in one call.
 *
 * The agent is stuck. It hands the live browser session to a human on a phone,
 * waits, and continues with whatever the human left behind. The hard part is
 * not the streaming; it is that this function is called from inside somebody
 * else's automation, so it may only fail in ways the caller can act on:
 *
 * - It throws only if the relay never came up, i.e. before a human could
 *   possibly have been asked to help. Nothing was promised yet.
 * - After the handoff URL exists it never throws. Every failure — a dead
 *   browser session, a rejected CDP call, a webhook that 500s — becomes an
 *   `outcome` and a log line, because by then the caller has already shown the
 *   URL to a person and needs to know what happened, not catch an exception.
 * - Every path destroys the relay sandbox and settles the promise exactly
 *   once.
 */
import type { CDPSession, Page } from "playwright-core"
import { printHandoffQr } from "../qr"
import { startRelay } from "../relay/deploy"
import type { AgentToHuman, HumanToAgent } from "../relay/protocol"
import type {
  HandoffOutcome,
  HandoffResult,
  RaiseHandOptions,
  StorageState,
} from "../types"
import { notifyWebhook } from "../webhook"
import { createInputTarget } from "./input"
import { DEFAULT_PROFILE, type FramePump, startFramePump } from "./screencast"
import { connectRelay, type RelayConnection } from "./socket"

/**
 * Five minutes. Solari browser sessions die about ten minutes after creation
 * and one measured session died at 319 s (spikes/s4-report.md), so a longer
 * default would put the common path on top of the platform's hard limit.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** The relay must outlive the handoff, never the other way round. */
const RELAY_SLACK_MS = 5 * 60_000

/**
 * Cap on the `storageState()` capture. It is a CDP round trip, and the Solari
 * browser session may die in the very same instant the human hands back, which
 * would leave the call hanging and `raiseHand` never returning — holding the
 * relay's sandbox slot. Better to lose the cookies than the whole function.
 */
const STORAGE_STATE_TIMEOUT_MS = 5_000

/** Resolve `promise`, or reject with `label` if it has not settled in `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`handraise: ${label} timed out after ${ms}ms`)),
      ms,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Identifies one handoff. The preview hostname is unique per relay sandbox and
 * already appears in the relay's own logs, which makes it the cheapest useful
 * correlation key. It is deliberately not the Solari session id: `raiseHand`
 * receives a `Page`, and a Page cannot see the session that owns it.
 */
function handoffId(humanUrl: string): string {
  const host = new URL(humanUrl).hostname
  return host.split(".")[0] ?? host
}

function endedMessage(outcome: HandoffOutcome): AgentToHuman {
  return { type: "ended", outcome }
}

/**
 * A dead Solari browser session has no error code and no status — the only
 * stable marker is this substring (spikes/s4-report.md §3). It is a fallback:
 * the `disconnected` event usually fires first.
 */
function isBrowserGone(error: Error): boolean {
  return error.message.includes("Browser closed")
}

interface HandoffEnd {
  outcome: HandoffOutcome
  storageState?: StorageState
}

/**
 * Run one handoff to its end. Never throws, never leaves a timer, a listener
 * or a CDP session behind.
 */
async function runHandoff(
  page: Page,
  agentWsUrl: string,
  options: RaiseHandOptions,
  timeoutMs: number,
): Promise<HandoffEnd> {
  let settle: (outcome: HandoffOutcome) => void = () => undefined
  // A promise resolves once; that is where "settled exactly once" comes from.
  const finished = new Promise<HandoffOutcome>((resolve) => {
    settle = resolve
  })

  const browser = page.context().browser()
  const onGone = (): void => settle("disconnected")
  browser?.once("disconnected", onGone)
  page.once("close", onGone)

  const timer = setTimeout(() => settle("timeout"), timeoutMs)

  let pump: FramePump | null = null
  let cdp: CDPSession | null = null
  let input: ReturnType<typeof createInputTarget> | null = null
  // The reconnect callback needs the connection it belongs to, and it cannot
  // fire before the constructor has returned, because a socket opens async.
  let link: RelayConnection | null = null

  let terminal = false
  const onHuman = (message: HumanToAgent): void => {
    if (message.type === "handback") {
      terminal = true
      settle("resolved")
      return
    }
    if (message.type === "abort") {
      terminal = true
      settle("aborted")
      return
    }
    // Once a terminal message has arrived the page is being handed back or
    // abandoned, so no further input may run against it.
    if (terminal) return
    // Input can only be mapped once a frame has defined the coordinate space.
    const meta = pump?.lastMeta()
    if (!meta || !input) return
    void input.apply(message, meta).catch((error) => {
      if (error instanceof Error && isBrowserGone(error)) settle("disconnected")
      else console.error("handraise: input was rejected", error)
    })
  }

  const connection = connectRelay({
    url: agentWsUrl,
    onMessage: onHuman,
    // The relay replays the last state to a late joiner, but re-sending on
    // every reconnect costs one small message and covers the case where the
    // relay restarted underneath us.
    onOpen: () => {
      void link?.send({ type: "state", reason: options.reason })
    },
  })
  link = connection

  try {
    cdp = await page.context().newCDPSession(page)
    input = createInputTarget(cdp)
    pump = await startFramePump(cdp, DEFAULT_PROFILE, (data, meta) =>
      // The ack that paces the cast waits on this write. See screencast.ts.
      connection.send({ type: "frame", data, meta }),
    )
  } catch (error) {
    console.error("handraise: could not start the live view", error)
    settle("disconnected")
  }

  const outcome = await finished

  // Handback is only "resolved-pending" until the page is proven still usable.
  let finalOutcome = outcome
  let storageState: StorageState | undefined
  if (outcome === "resolved") {
    // Barrier: let input the human queued before handback finish, so nothing
    // runs against the page during the snapshot and teardown below.
    if (input) await input.drain()
    try {
      // Best effort, and worth trying first: whatever the human just did
      // (a completed login, a solved captcha) lives in these cookies, and the
      // session that holds them may be minutes — or seconds — from its hard
      // lifetime, so this call is raced against a timeout.
      storageState = await withTimeout(
        page.context().storageState(),
        STORAGE_STATE_TIMEOUT_MS,
        "storageState capture",
      )
    } catch (error) {
      console.error("handraise: could not capture storageState", error)
    }
    // Handback can win the promise by milliseconds just as the session hits its
    // ~10-min hard death (spikes/s4-report.md). If the page is gone the caller
    // cannot continue, so report that truthfully instead of a dead "resolved".
    if (browser && !browser.isConnected()) {
      finalOutcome = "disconnected"
      storageState = undefined
    }
  }

  clearTimeout(timer)
  browser?.off("disconnected", onGone)
  page.off("close", onGone)
  await pump?.stop()
  // The ending must reach the phone, so wait briefly for a reconnect if the
  // socket is momentarily down rather than dropping it like a stale frame.
  await connection.sendFinal(endedMessage(finalOutcome))
  await connection.close()
  await cdp?.detach().catch(() => undefined)

  if (storageState === undefined) return { outcome: finalOutcome }
  return { outcome: finalOutcome, storageState }
}

/** See `RaiseHand` in ../types.ts for the contract. */
export async function raiseHand(
  page: Page,
  options: RaiseHandOptions,
): Promise<HandoffResult> {
  const apiKey = options.apiKey ?? process.env.SOLARI_API_KEY
  if (!apiKey) {
    throw new Error(
      "handraise: no API key. Pass options.apiKey or set SOLARI_API_KEY — it is needed to create the relay sandbox that gives the handoff a public URL.",
    )
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Throwing here is allowed and correct: no URL exists yet, so no human has
  // been asked for anything and the caller can retry or give up cleanly.
  const relay = await startRelay({
    apiKey,
    timeoutMs: timeoutMs + RELAY_SLACK_MS,
  })

  const startedAt = Date.now()
  let endedAt = startedAt
  let webhook: Promise<void> = Promise.resolve()
  let end: HandoffEnd = { outcome: "disconnected" }

  try {
    try {
      options.onUrl?.(relay.humanUrl)
    } catch (error) {
      console.error("handraise: the onUrl callback threw", error)
    }
    if (options.qr !== false) printHandoffQr(relay.humanUrl, options.reason)
    if (options.webhookUrl) {
      // Deliberately not awaited: the human may already be scanning the QR
      // code while a slow Slack endpoint is still thinking.
      webhook = notifyWebhook(options.webhookUrl, {
        url: relay.humanUrl,
        reason: options.reason,
        sessionId: handoffId(relay.humanUrl),
      })
    }

    end = await runHandoff(page, relay.agentWsUrl, options, timeoutMs)
  } catch (error) {
    console.error("handraise: the handoff failed", error)
  } finally {
    // Captured before teardown: durationMs is the time the human had, not the
    // time the sandbox took to shut down afterwards.
    endedAt = Date.now()
    await webhook
    await relay.kill().catch((error) => {
      console.error("handraise: could not release the relay sandbox", error)
    })
  }

  const result: HandoffResult = {
    outcome: end.outcome,
    durationMs: endedAt - startedAt,
    url: relay.humanUrl,
  }
  if (end.storageState) result.storageState = end.storageState
  return result
}
