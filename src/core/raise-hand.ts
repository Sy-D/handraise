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
import type { HandoffEvent } from "../events"
import { type Logger, quietLogger } from "../logger"
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
import { NO_FOCUS, probeFocus } from "./focus"
import { createInputTarget } from "./input"
import { DEFAULT_PROFILE, type FramePump, startFramePump } from "./screencast"
import { connectRelay, type RelayConnection } from "./socket"

/**
 * Five minutes. Solari browser sessions die about ten minutes after creation
 * and one measured session died at 319 s (docs/measurements/04-browser-session-lifetime.md), so a longer
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
 * stable marker is this substring (docs/measurements/04-browser-session-lifetime.md §3). It is a fallback:
 * the `disconnected` event usually fires first.
 */
function isBrowserGone(error: Error): boolean {
  return error.message.includes("Browser closed")
}

interface HandoffEnd {
  outcome: HandoffOutcome
  storageState?: StorageState
}

/** Everything one handoff needs, plus the relay-level facts for its wide event. */
export interface HandoffRun {
  page: Page
  agentWsUrl: string
  options: RaiseHandOptions
  timeoutMs: number
  /** Correlation key; the relay's preview subdomain. */
  handoffId: string
  /** Measured by `startRelay()` and mirrored into the event. */
  relayColdStartMs: number
  logger: Logger
}

/**
 * Emit the canonical wide event exactly once: as a `logger.info` line and, if
 * the caller supplied one, through `onEvent`. A throw from `onEvent` is caught
 * so a broken callback never breaks the handoff.
 */
function emitHandoffEvent(
  options: RaiseHandOptions,
  logger: Logger,
  event: HandoffEvent,
): void {
  logger.info("handoff", { ...event })
  try {
    options.onEvent?.(event)
  } catch (error) {
    logger.error("on_event_threw", { error: String(error) })
  }
}

/**
 * Run one handoff to its end. Never throws, never leaves a timer, a listener
 * or a CDP session behind. Emits the wide event exactly once before it settles.
 *
 * Exported for `handoff.test.ts`, which drives it against a local relay with a
 * fake page; `raiseHand` is the supported entry point.
 */
export async function runHandoff(run: HandoffRun): Promise<HandoffEnd> {
  const { page, agentWsUrl, options, timeoutMs, logger } = run
  const startedAt = Date.now()
  let framesSent = 0
  let bytesSent = 0
  let firstFrameMs: number | undefined
  let firstError: string | undefined

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

  // The phone cannot see a caret in a 60-quality JPEG, so the agent tells it
  // where the typing lands. Strictly off the critical path: a probe is never
  // awaited by the input it follows, it holds no timer, and the newest result
  // is only sent when it differs from the last one — a human moving between
  // two fields is a handful of tiny messages, not a second stream.
  let lastFocusJson = JSON.stringify(NO_FOCUS)
  let probing = false
  const refreshFocus = (): void => {
    // One probe at a time. A fast typist would otherwise queue a CDP round
    // trip per keystroke, all of them answering the same question.
    if (probing || terminal) return
    probing = true
    void probeFocus(page)
      .then((focus) => {
        if (terminal) return
        const json = JSON.stringify(focus)
        if (json === lastFocusJson) return
        lastFocusJson = json
        void link?.send({ type: "focus", ...focus })
      })
      // probeFocus swallows its own failures; this covers a send that races
      // teardown. A probe still in flight when the handoff ends is simply
      // orphaned — there is nothing to clean up.
      .catch(() => undefined)
      .finally(() => {
        probing = false
      })
  }

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
    void input
      .apply(message, meta)
      // A tap moves the focus and a keystroke can too (Tab, or a page that
      // advances an OTP box on its own), so the answer is only reliable once
      // the input has actually reached the page.
      .then(refreshFocus)
      .catch((error) => {
        if (error instanceof Error && isBrowserGone(error))
          settle("disconnected")
        else logger.warn("input_rejected", { error: String(error) })
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
    pump = await startFramePump(cdp, DEFAULT_PROFILE, async (data, meta) => {
      // The ack that paces the cast waits on this write. See screencast.ts.
      await connection.send({ type: "frame", data, meta })
      // Counted with the same "send resolved" semantics as pump.frameCount():
      // a base64 payload is ASCII, so its char length is its byte length.
      framesSent += 1
      bytesSent += data.length
      if (firstFrameMs === undefined) {
        firstFrameMs = Date.now() - startedAt
        // The phone now has a picture to draw on. If the agent left a field
        // focused — the usual case, it got stuck on a login form — the human
        // sees the ring on the first frame rather than after their first tap.
        refreshFocus()
      }
    })
  } catch (error) {
    firstError = String(error)
    logger.error("live_view_start_failed", { error: firstError })
    settle("disconnected")
  }

  const outcome = await finished
  // The handoff is over the instant it settles; teardown below is not the
  // human's time, so the event's durationMs is measured here.
  const durationMs = Date.now() - startedAt

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
      logger.warn("storage_state_capture_failed", { error: String(error) })
    }
    // Handback can win the promise by milliseconds just as the session hits its
    // ~10-min hard death (docs/measurements/04-browser-session-lifetime.md). If the page is gone the caller
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

  // The one canonical line for this handoff, built after teardown so every
  // counter is final. Optional fields are added only when they carry a value
  // (exactOptionalPropertyTypes).
  const event: HandoffEvent = {
    handoffId: run.handoffId,
    outcome: finalOutcome,
    reason: options.reason,
    timeoutMs,
    durationMs,
    relayColdStartMs: run.relayColdStartMs,
    framesSent,
    bytesSent,
    inputsApplied: input?.applied() ?? 0,
    reconnects: connection.stats().reconnects,
    storageStateCaptured: storageState !== undefined,
  }
  if (firstFrameMs !== undefined) event.firstFrameMs = firstFrameMs
  if (options.baseUrl !== undefined) event.baseUrl = options.baseUrl
  if (firstError !== undefined) event.error = firstError
  emitHandoffEvent(options, logger, event)

  if (storageState === undefined) return { outcome: finalOutcome }
  return { outcome: finalOutcome, storageState }
}

/** See `RaiseHand` in ../types.ts for the contract. */
export async function raiseHand(
  page: Page,
  options: RaiseHandOptions,
): Promise<HandoffResult> {
  const logger = options.logger ?? quietLogger
  const apiKey = options.apiKey ?? process.env.SOLARI_API_KEY
  if (!apiKey) {
    throw new Error(
      "handraise: no API key. Pass options.apiKey or set SOLARI_API_KEY — it is needed to create the relay sandbox that gives the handoff a public URL.",
    )
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Throwing here is allowed and correct: no URL exists yet, so no human has
  // been asked for anything and the caller can retry or give up cleanly.
  const relay = await startRelay(
    options.baseUrl
      ? {
          apiKey,
          timeoutMs: timeoutMs + RELAY_SLACK_MS,
          baseUrl: options.baseUrl,
          logger,
        }
      : { apiKey, timeoutMs: timeoutMs + RELAY_SLACK_MS, logger },
  )

  const startedAt = Date.now()
  let endedAt = startedAt
  let webhook: Promise<void> = Promise.resolve()
  let end: HandoffEnd = { outcome: "disconnected" }

  try {
    try {
      options.onUrl?.(relay.humanUrl)
    } catch (error) {
      logger.warn("on_url_threw", { error: String(error) })
    }
    if (options.qr !== false) printHandoffQr(relay.humanUrl, options.reason)
    if (options.webhookUrl) {
      // Deliberately not awaited: the human may already be scanning the QR
      // code while a slow Slack endpoint is still thinking.
      webhook = notifyWebhook(
        options.webhookUrl,
        {
          url: relay.humanUrl,
          reason: options.reason,
          sessionId: handoffId(relay.humanUrl),
        },
        logger,
      )
    }

    end = await runHandoff({
      page,
      agentWsUrl: relay.agentWsUrl,
      options,
      timeoutMs,
      handoffId: handoffId(relay.humanUrl),
      relayColdStartMs: relay.coldStartMs,
      logger,
    })
  } catch (error) {
    // runHandoff does not throw, so this only fires on an unexpected fault; the
    // handoff event is emitted inside runHandoff, on every ordinary path.
    logger.error("handoff_failed", { error: String(error) })
  } finally {
    // Captured before teardown: durationMs is the time the human had, not the
    // time the sandbox took to shut down afterwards.
    endedAt = Date.now()
    await webhook
    await relay.kill().catch((error) => {
      logger.error("relay_release_failed", { error: String(error) })
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
