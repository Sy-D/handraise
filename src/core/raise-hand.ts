/**
 * `raiseHand()` — the whole product in one call.
 *
 * The agent is stuck. It hands the live browser session to a human on a phone,
 * waits, and continues with whatever the human left behind. The hard part is
 * not the streaming; it is that this function is called from inside somebody
 * else's automation, so it may only fail in ways the caller can act on:
 *
 * - It throws only if the relay never came up, i.e. before a human could
 *   possibly have been asked to help. Nothing was promised yet, and what it
 *   throws is a `HandraiseError` with a code (see ../errors.ts).
 * - After the handoff URL exists it never throws. Every failure — a dead
 *   browser session, a rejected CDP call, a webhook that 500s — becomes an
 *   `outcome` and a log line, because by then the caller has already shown the
 *   URL to a person and needs to know what happened, not catch an exception.
 * - Every path destroys the relay sandbox and settles the promise exactly
 *   once.
 */
import type { Browser, CDPSession, Page } from "playwright-core"
import type {
  ApprovalChannelHandoff,
  ChannelHandoff,
  HandoffChannel,
  TakeoverChannelHandoff,
} from "../channels"
import { HandraiseError } from "../errors"
import type { HandoffEvent } from "../events"
import { type Logger, quietLogger, safeLogger } from "../logger"
import { printHandoffQr } from "../qr"
import { startRelay } from "../relay/deploy"
import type { AgentToHuman, HumanToAgent } from "../relay/protocol"
import type {
  HandoffMode,
  HandoffOutcome,
  HandoffResult,
  RaiseHandOptions,
  StorageState,
} from "../types"
import { notifyWebhook } from "../webhook"
import { NO_FOCUS, probeFocus } from "./focus"
import { createInputTarget } from "./input"
import { DEFAULT_PROFILE, type FramePump, startFramePump } from "./screencast"
import { type ApprovalFrame, captureApprovalFrame } from "./snapshot"
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

/** What the human is looking at, replayed on every (re)connect. */
function stateMessage(options: RaiseHandOptions): AgentToHuman {
  if (options.mode === "approval") {
    return { type: "state", reason: options.reason, action: options.action }
  }
  return { type: "state", reason: options.reason }
}

/**
 * The human message that ends this mode, and what it means to the caller.
 *
 * Each mode answers to its own two messages and ignores the other pair. The
 * relay refuses to route them in the first place; this is the second lock, for
 * the case where the relay is not the one this version shipped.
 */
function endingFor(
  mode: HandoffMode,
  type: HumanToAgent["type"],
): HandoffOutcome | null {
  if (mode === "approval") {
    if (type === "approve") return "approved"
    if (type === "deny") return "denied"
    return null
  }
  if (type === "handback") return "resolved"
  if (type === "abort") return "aborted"
  return null
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
  /** The public handoff page, as handed to `onUrl` and to every channel. */
  url: string
  /** Correlation key; the relay's preview subdomain. */
  handoffId: string
  /** Measured by `startRelay()` and mirrored into the event. */
  relayColdStartMs: number
  logger: Logger
}

/**
 * Start the live cast for a takeover, wired to the relay socket.
 *
 * The frame is written to the relay before it is acknowledged to Chromium, so
 * the cast paces itself to the phone's link (see screencast.ts). `onSent` runs
 * after the write resolves, which is what makes the counters truthful.
 */
async function startTakeoverCast(
  cdp: CDPSession,
  connection: RelayConnection,
  onSent: (data: string) => void,
): Promise<FramePump> {
  return startFramePump(cdp, DEFAULT_PROFILE, async (data, meta) => {
    // The ack that paces the cast waits on this write. See screencast.ts.
    await connection.send({ type: "frame", data, meta })
    onSent(data)
  })
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
 * The view a channel gets of a takeover: the link, and that is all. There is
 * nothing to answer and no one moment worth sending — the human has to drive
 * the browser, which only the handoff page can do.
 */
function takeoverChannelHandoff(
  run: HandoffRun,
  settled: Promise<HandoffOutcome>,
): TakeoverChannelHandoff {
  return {
    mode: "takeover",
    handoffId: run.handoffId,
    url: run.url,
    reason: run.options.reason,
    settled,
  }
}

/**
 * The view a channel gets of an approval.
 *
 * `action` and `shot` are parameters rather than fields read off `run`,
 * because only the caller has narrowed the options union far enough to know
 * they exist. Two builders rather than one with a fallback: an approval
 * announced as a takeover would not be a degraded message but the wrong one —
 * a bearer link and "drive the browser", in place of a yes or no.
 */
function approvalChannelHandoff(
  run: HandoffRun,
  action: string,
  shot: ApprovalFrame,
  answer: (decision: "approve" | "deny") => boolean,
  settled: Promise<HandoffOutcome>,
): ApprovalChannelHandoff {
  return {
    mode: "approval",
    handoffId: run.handoffId,
    url: run.url,
    reason: run.options.reason,
    settled,
    action,
    // The same JPEG the phone is looking at. It is held base64 because that is
    // what goes on the wire; this is that exact payload decoded back, not a
    // second screenshot of a page that may have moved on since.
    screenshot: Buffer.from(shot.data, "base64"),
    answer,
  }
}

/**
 * Announce the handoff to every channel, once each.
 *
 * Fire-and-forget on purpose: a channel is a side channel. It must not delay
 * the handoff (the human may already be scanning the QR code) and it must not
 * be able to end it, so a synchronous throw and a rejected promise are the
 * same thing here — one warning, and the handoff carries on.
 */
function notifyChannels(
  channels: readonly HandoffChannel[],
  handoff: ChannelHandoff,
  logger: Logger,
): void {
  for (const channel of channels) {
    try {
      void Promise.resolve(channel.notify(handoff)).catch((error) => {
        logger.warn("channel_failed", { error: String(error) })
      })
    } catch (error) {
      logger.warn("channel_failed", { error: String(error) })
    }
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
  const { page, agentWsUrl, options, timeoutMs } = run
  // Wrapped here as well as in `raiseHand`, because this is the entry point
  // the tests drive: from this line on, no log call can end a handoff.
  const logger = safeLogger(run.logger)
  const mode: HandoffMode = options.mode ?? "takeover"
  const startedAt = Date.now()
  let framesSent = 0
  let bytesSent = 0
  let firstFrameMs: number | undefined
  let firstError: string | undefined

  // Set by the first settle, on every path — a human answer, the timeout, a
  // dead session. Nothing about the page may go on the wire after it: the
  // relay scrubs its replay buffers when a handoff ends, and a reconnect that
  // re-sent the screenshot would undo exactly that scrubbing.
  let over = false
  let settle: (outcome: HandoffOutcome) => void = () => undefined
  // A promise resolves once; that is where "settled exactly once" comes from.
  const finished = new Promise<HandoffOutcome>((resolve) => {
    settle = (outcome) => {
      over = true
      resolve(outcome)
    }
  })

  // What every channel of this handoff awaits. Resolved once, with the outcome
  // the caller is given — after the handback check, so a channel is never told
  // "resolved" for a session that turned out to be dead. It never rejects, so
  // an adapter can await it without a guard.
  let announceSettled: (outcome: HandoffOutcome) => void = () => undefined
  const settled = new Promise<HandoffOutcome>((resolve) => {
    announceSettled = resolve
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

  // Who ended it, when it was ended by an answer. Only meaningful for
  // `approved` and `denied`; the event carries it on those outcomes only.
  let answeredVia: "relay" | "channel" | undefined

  /**
   * The single settle path for a human answer, from the phone or from a
   * channel. First answer wins: `over` is set by the first `settle`, so a
   * second answer — the phone tapping Deny while a Telegram button was already
   * pressed — changes nothing and is told so.
   */
  const answerHandoff = (
    outcome: HandoffOutcome,
    via: "relay" | "channel",
  ): boolean => {
    if (over) return false
    terminal = true
    answeredVia = via
    settle(outcome)
    return true
  }

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
    const ending = endingFor(mode, message.type)
    if (ending) {
      answerHandoff(ending, "relay")
      return
    }
    // Once a terminal message has arrived the page is being handed back or
    // abandoned, so no further input may run against it. An approval never
    // injects anything at all: the human is answering, not driving.
    if (terminal || mode === "approval") return
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

  // The approval's single screenshot, kept so a reconnect can put it back on
  // the wire. A cast would simply send the next frame; this one has no next,
  // which is why `framesSent` counts one per connection and not one per
  // handoff — every one of them really did go over the wire.
  let approvalFrame: ApprovalFrame | null = null
  const sendApprovalFrame = async (): Promise<void> => {
    const shot = approvalFrame
    // `send` resolves without sending while the socket is down, which is right
    // for a cast and wrong for the only frame there is: skip it, and let the
    // reconnect's `onOpen` be the one that delivers it (and counts it). Once
    // the handoff is over there is nothing to deliver at all.
    const live = link
    if (!shot || over || !live?.isOpen()) return
    await live.send({ type: "frame", data: shot.data, meta: shot.meta })
    framesSent += 1
    bytesSent += shot.data.length
    if (firstFrameMs === undefined) firstFrameMs = Date.now() - startedAt
  }

  const connection = connectRelay({
    url: agentWsUrl,
    onMessage: onHuman,
    // The relay replays the last state to a late joiner, but re-sending on
    // every reconnect costs one small message and covers the case where the
    // relay restarted underneath us.
    onOpen: () => {
      void link?.send(stateMessage(options))
      void sendApprovalFrame()
    },
  })
  link = connection

  const answerFromChannel = (decision: "approve" | "deny"): boolean =>
    answerHandoff(decision === "approve" ? "approved" : "denied", "channel")

  /**
   * Tell the channels. Once per handoff, per channel, at the first moment
   * there is something worth sending: the link in takeover mode, the link and
   * the screenshot in approval mode.
   *
   * Not once the handoff is over. Taking the screenshot is a round trip to the
   * browser, and the page can close or the wait can run out while it is in
   * flight — `sendApprovalFrame` guards exactly that window, and a channel
   * announced anyway would leave live buttons under a request that no longer
   * exists.
   */
  const announce = (handoff: ChannelHandoff): void => {
    const channels = options.channels ?? []
    if (over || channels.length === 0) return
    notifyChannels(channels, handoff, logger)
  }

  try {
    if (mode === "approval") {
      // One screenshot and nothing else: no CDP session, no screencast, no
      // focus probe. The page the human decides on is the page as the agent
      // left it, and it is still that page afterwards.
      approvalFrame = await captureApprovalFrame(page)
      await sendApprovalFrame()
      // `options.mode`, not the `mode` local: this is the check that narrows
      // the union, and it is what makes `options.action` readable here.
      if (options.mode === "approval") {
        announce(
          approvalChannelHandoff(
            run,
            options.action,
            approvalFrame,
            answerFromChannel,
            settled,
          ),
        )
      }
    } else {
      // The relay is up — `raiseHand` awaited it — so the link in the message
      // is already open. Sent before the cast starts, because the cast is not
      // what the human needs in order to be told.
      announce(takeoverChannelHandoff(run, settled))
      cdp = await page.context().newCDPSession(page)
      input = createInputTarget(cdp)
      pump = await startTakeoverCast(cdp, connection, (data) => {
        // Counted with the same "send resolved" semantics as
        // pump.frameCount(): a base64 payload is ASCII, so its char length is
        // its byte length.
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
    }
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

  // The earliest point at which the outcome is the one the caller will see.
  // Before teardown on purpose: a channel that stops polling here releases the
  // chat and the process while the relay is still being shut down.
  announceSettled(finalOutcome)

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
    mode,
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
  // Only an answer has a source. A timeout, a dead session or a handback is
  // not "answered via" anything, so the field stays absent there.
  if (
    answeredVia !== undefined &&
    (finalOutcome === "approved" || finalOutcome === "denied")
  ) {
    event.answeredVia = answeredVia
  }
  if (options.baseUrl !== undefined) event.baseUrl = options.baseUrl
  if (firstError !== undefined) event.error = firstError
  emitHandoffEvent(options, logger, event)

  if (storageState === undefined) return { outcome: finalOutcome }
  return { outcome: finalOutcome, storageState }
}

/** The two modes, as a runtime value. */
const MODES = new Set<string>(["takeover", "approval"])

/**
 * Check the mode and, in approval mode, that there is an action to decide on;
 * return the mode. Everything `raiseHand` refuses to start a handoff for is
 * here, and here is the one place it may throw: no URL exists yet, so nobody
 * has been asked for anything and the caller can retry or give up cleanly.
 *
 * The types close both of these for TypeScript callers. This package is
 * published as JavaScript as well, the mode ends up on the relay's command
 * line, and an approval with no action puts a blank question on a phone.
 */
function checkedMode(options: RaiseHandOptions): HandoffMode {
  const mode = options.mode ?? "takeover"
  if (!MODES.has(mode)) {
    throw new HandraiseError(
      "invalid_mode",
      `handraise: unknown mode ${JSON.stringify(mode)} — it must be "takeover" or "approval".`,
    )
  }
  // String(): a JavaScript caller can leave `action` out entirely, and a
  // TypeError from reading `.trim()` of undefined is not an answer.
  if (
    options.mode === "approval" &&
    String(options.action ?? "").trim() === ""
  ) {
    throw new HandraiseError(
      "empty_action",
      'handraise: mode "approval" needs a non-empty `action` — it is the step the human says yes or no to, and the phone shows it as the decision. Without it a human is asked to approve a blank line.',
    )
  }
  // SAFETY: `MODES` holds exactly the two members of HandoffMode, so a value
  // that passed the check above is one of them.
  return mode as HandoffMode
}

/**
 * Refuse a dead page before a sandbox is created.
 *
 * A dead session cannot be driven or screenshotted, so a handoff on one would
 * spend a relay sandbox, a QR code and a person's attention to end in
 * `disconnected`. Two questions, both answered from local state — neither
 * touches the network: is this page closed, and is its browser still
 * connected? `context()` is a field read and throws nothing in Playwright, so
 * it is `isClosed()` that catches a closed page; the try/catch is for the page
 * object that is not a working Playwright page at all.
 */
function checkedPage(page: Page): void {
  let closed: boolean
  let browser: Browser | null
  try {
    closed = page.isClosed()
    browser = page.context().browser()
  } catch (cause) {
    throw new HandraiseError(
      "browser_unusable",
      `handraise: this page cannot be handed to a human — reading its state (page.isClosed(), page.context()) threw. A dead CDP connection does that, and so does a page-like object that is not a Playwright page. ${String(cause)}`,
      { cause },
    )
  }
  if (closed) {
    throw new HandraiseError(
      "browser_unusable",
      "handraise: this page is already closed, so there is nothing for a human to take over. Open a new page (its `storageState` from an earlier handoff, if you kept it, restores the human's work) and retry.",
    )
  }
  if (browser && !browser.isConnected()) {
    throw new HandraiseError(
      "browser_unusable",
      "handraise: the browser session behind this page is already disconnected, so there is nothing for a human to take over. Relaunch the session (its `storageState` from an earlier handoff, if you kept it, restores the human's work) and retry.",
    )
  }
}

/** See `RaiseHand` in ../types.ts for the contract. */
export async function raiseHand(
  page: Page,
  options: RaiseHandOptions,
): Promise<HandoffResult> {
  const logger = safeLogger(options.logger ?? quietLogger)
  const mode = checkedMode(options)
  const apiKey = options.apiKey ?? process.env.SOLARI_API_KEY
  if (!apiKey) {
    throw new HandraiseError(
      "missing_api_key",
      "handraise: no API key. Pass options.apiKey or set SOLARI_API_KEY — it is needed to create the relay sandbox that gives the handoff a public URL.",
    )
  }
  checkedPage(page)

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const relay = await startRelay(
    options.baseUrl
      ? {
          apiKey,
          mode,
          timeoutMs: timeoutMs + RELAY_SLACK_MS,
          baseUrl: options.baseUrl,
          logger,
        }
      : { apiKey, mode, timeoutMs: timeoutMs + RELAY_SLACK_MS, logger },
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
    // In approval mode the action is the decision, so the terminal line the
    // operator reads carries it next to the reason.
    const headline =
      options.mode === "approval"
        ? `${options.reason} — ${options.action}`
        : options.reason
    if (options.qr !== false) printHandoffQr(relay.humanUrl, headline)
    if (options.webhookUrl) {
      // Deliberately not awaited: the human may already be scanning the QR
      // code while a slow Slack endpoint is still thinking.
      const payload = {
        url: relay.humanUrl,
        reason: options.reason,
        mode,
        sessionId: handoffId(relay.humanUrl),
      }
      webhook = notifyWebhook(
        options.webhookUrl,
        options.mode === "approval"
          ? { ...payload, action: options.action }
          : payload,
        logger,
      )
        // `notifyWebhook` does not reject, and this is what makes that safe to
        // rely on: nothing awaits this promise until the `finally`, minutes
        // later, so a rejection would be unhandled for the whole handoff (node
        // ends the process for that) and would then throw from the `finally`.
        .catch(() => undefined)
    }

    end = await runHandoff({
      page,
      agentWsUrl: relay.agentWsUrl,
      options,
      timeoutMs,
      url: relay.humanUrl,
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
