/**
 * The proof that handraise does its job.
 *
 * An agent logs into a real site running on a real Solari sandbox, hits a real
 * TOTP wall, and stops. A human who is not the agent — a separate WebSocket
 * client, talking only the public wire protocol — opens the handoff, sees the
 * page, taps the code field, types the code, presses Enter, and hands back.
 * The agent then finds itself signed in.
 *
 * Nothing here asserts that a page rendered. Every assertion is about the job
 * getting done: the field focused where the human tapped, the code in the
 * field, the account page reached, the cookies captured.
 *
 *   bun --env-file=.env e2e/handoff.e2e.ts
 *
 * Costs two sandboxes (the test app and the relay) and one browser session.
 * That is the whole plan allowance, so nothing else may run at the same time —
 * check with `bun --env-file=.env scripts/cleanup-sandboxes.ts` first.
 *
 * Set HANDRAISE_E2E_FAULT=wrong-code to make the human type a wrong code. The
 * run must then fail on the "signed in" assertion; that is how the assertion
 * is known to be load-bearing rather than decorative.
 */
import { Solari } from "@solarisdk/browser"
import type { Page } from "playwright-core"

import type { HandoffEvent } from "../src/events"
import { type Logger, raiseHand } from "../src/index"
import { previewPath, startTestApp } from "../test-app/deploy"
import { msUntilNextStep, totp } from "../test-app/totp"
import { openHandoffPage } from "./human-sim"

declare global {
  interface Window {
    /** Installed by the approval cases; see `watchForInput` below. */
    handraiseInputCounts?: {
      pointerdown: number
      keydown: number
      input: number
    }
  }
}

const FAULT = process.env.HANDRAISE_E2E_FAULT ?? ""
const VIEWPORT = { width: 1280, height: 800 }
const TIMEOUT_CASE_MS = 8_000
/** The presence case: a wait nobody would sit through, and a short grace. */
const PRESENCE_TIMEOUT_MS = 90_000
const PRESENCE_GRACE_MS = 5_000

const started = Date.now()
const timings: Record<string, number> = {}

/** One wide JSON line per event, the way the relay and the test app log. */
type LogDetail = Record<string, string | number | boolean | undefined>

function log(event: string, detail: LogDetail = {}): void {
  console.log(JSON.stringify({ t: Date.now() - started, event, ...detail }))
}

/**
 * A logger that keeps the one line this file measures — the relay's receipt for
 * the ending — and shouts about anything that went wrong. Everything else
 * handraise says is already covered by the wide event.
 */
interface AckWatcher {
  logger: Logger
  /** The `ended_ack` lines handraise logged, as JSON. */
  lines: string[]
}

function ackWatcher(): AckWatcher {
  const lines: string[] = []
  return {
    lines,
    logger: {
      debug: () => undefined,
      info: (event, fields) => {
        if (event === "ended_ack") lines.push(JSON.stringify(fields))
      },
      warn: (event, fields) =>
        console.error(JSON.stringify({ warn: event, fields })),
      error: (event, fields) =>
        console.error(JSON.stringify({ error: event, fields })),
    },
  }
}

/** Whether the relay confirmed it had stored the ending before the kill. */
function acked(lines: string[]): boolean {
  return lines.some((line) => line.includes('"acked":true'))
}

/**
 * Open the link the way somebody who was not watching would, *after* the
 * answer, and report what they are told about the ending.
 *
 * Measured, not asserted, and the comment at the call site says why: the relay
 * holds the ending (that part is now guaranteed — the agent waits for the
 * relay's receipt before it kills anything), but the sandbox it is held in is
 * being destroyed, and opening a fresh HTTPS connection plus a WebSocket
 * upgrade to us-west takes about as long as the teardown does. What this
 * number says is how wide that remaining window is.
 */
async function lateViewerEnding(
  humanUrl: string,
  deadlineMs = 3_000,
): Promise<string | null> {
  const deadline = Date.now() + deadlineMs
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    const openedAt = Date.now()
    try {
      const viewer = await openHandoffPage(humanUrl)
      log("late_viewer_connected", {
        attempt: attempts,
        ms: Date.now() - openedAt,
      })
      const until = Math.min(deadline, Date.now() + 2_000)
      while (Date.now() < until && !viewer.ending()) await Bun.sleep(50)
      const ending = viewer.ending()
      await viewer.close()
      if (ending) return ending
    } catch (error) {
      log("late_viewer_refused", {
        attempt: attempts,
        ms: Date.now() - openedAt,
        error: String(error).slice(0, 80),
      })
      await Bun.sleep(150)
    }
  }
  return null
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${what}`)
  log("assertion_passed", { what })
}

/** A wrong code that is still six digits, for the deliberate red run. */
function corrupt(code: string): string {
  return [...code].map((digit) => String((Number(digit) + 1) % 10)).join("")
}

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey)
  throw new Error("SOLARI_API_KEY missing — run with --env-file=.env")

const app = await startTestApp({ apiKey, timeoutMs: 15 * 60_000 })
log("test_app_ready", { url: app.url, sandbox: app.sandboxId })
timings.testAppMs = Date.now() - started

const solari = new Solari({ apiKey })
let browser: Awaited<ReturnType<typeof solari.launch>> | undefined
/**
 * A handoff that is still running when an assertion fails. Closing the browser
 * makes it settle as `disconnected`, which is what destroys its relay sandbox
 * — without this, a red run leaks one of the plan's two sandbox slots.
 */
let pending: Promise<unknown> | null = null

try {
  const launchedAt = Date.now()
  browser = await solari.launch({ stealth: true })
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const opened = context.pages()[0] ?? (await context.newPage())
  await opened.setViewportSize(VIEWPORT)
  // SAFETY: `@solarisdk/browser` returns patchright-core's Page. patchright is
  // a Playwright fork whose runtime surface is the one handraise uses — goto,
  // context(), newCDPSession — and measurements 02 and 03 drove exactly this object.
  // The two type declarations differ only in optional-property variance.
  const page = opened as Page
  timings.browserLaunchMs = Date.now() - launchedAt
  log("browser_ready", { ms: timings.browserLaunchMs })

  // --- The agent's part: ordinary Playwright, right up to the wall. --------
  const agentAt = Date.now()
  await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await page.fill('[data-testid="username"]', app.user)
  await page.fill('[data-testid="password"]', app.pass)
  await page.click('[data-testid="login-submit"]')
  await page.waitForSelector('[data-testid="totp-code"]', { timeout: 30_000 })
  timings.agentToWallMs = Date.now() - agentAt
  check(page.url().endsWith("/totp"), "the agent is stuck on the 2FA page")

  // --- The handoff --------------------------------------------------------
  let announce: (url: string) => void = () => undefined
  const urlReady = new Promise<string>((resolve) => {
    announce = resolve
  })

  const handoffAt = Date.now()
  const handoff = raiseHand(page, {
    reason: "Aurora Bank is asking for a 2FA code",
    qr: false,
    onUrl: (url) => announce(url),
  })
  pending = handoff

  const humanUrl = await urlReady
  timings.urlReadyMs = Date.now() - handoffAt
  log("handoff_url", { humanUrl, ms: timings.urlReadyMs })

  const human = await openHandoffPage(humanUrl)
  const first = await human.waitForFrame()
  timings.firstFrameMs = Date.now() - handoffAt
  log("first_frame", {
    ms: timings.firstFrameMs,
    jpeg: `${first.meta.jpegWidth}x${first.meta.jpegHeight}`,
    device: `${first.meta.deviceWidth}x${first.meta.deviceHeight}`,
    bytes: Buffer.from(first.data, "base64").length,
  })
  check(
    first.meta.deviceWidth === VIEWPORT.width,
    "metadata reports the CSS viewport",
  )
  check(
    first.meta.jpegWidth === 800,
    "the frame is scaled to the 800px profile",
  )
  check(
    human.reason() === "Aurora Bank is asking for a 2FA code",
    "the phone shows the reason the agent gave",
  )

  // The human taps the code field. Autofocus already put the caret there, so
  // blur it first — otherwise a broken coordinate mapping would still pass.
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  const box = await page.locator('[data-testid="totp-code"]').boundingBox()
  if (!box) throw new Error("the code field has no bounding box")
  const scale = first.meta.jpegWidth / first.meta.deviceWidth
  await human.tap(
    (box.x + box.width / 2) * scale,
    (box.y + box.height / 2) * scale,
  )
  // Every human message costs a relay hop plus a CDP round trip to us-west, so
  // poll for the effect instead of guessing how long that takes today.
  let focused = ""
  const focusDeadline = Date.now() + 20_000
  while (Date.now() < focusDeadline) {
    focused = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? "",
    )
    if (focused === "totp-code") break
    await Bun.sleep(200)
  }
  check(focused === "totp-code", "the tap focused the field the human aimed at")

  // A code lives 30 s and the app tolerates one step either side. Compute it
  // when the human types it, not when the handoff opened.
  if (msUntilNextStep() < 8_000) await Bun.sleep(msUntilNextStep() + 200)
  const real = totp(app.totpSecret)
  const code = FAULT === "wrong-code" ? corrupt(real) : real
  log("human_types", { fault: FAULT || "none" })

  const typingAt = Date.now()
  await human.type(code)
  let typed = ""
  const typingDeadline = Date.now() + 30_000
  while (Date.now() < typingDeadline) {
    typed = await page.inputValue('[data-testid="totp-code"]')
    if (typed.length >= code.length) break
    await Bun.sleep(200)
  }
  timings.typingMs = Date.now() - typingAt
  check(typed === code, `every character arrived in the field (saw "${typed}")`)

  await human.press("Enter")
  const deadline = Date.now() + 20_000
  while (!page.url().endsWith("/account") && Date.now() < deadline) {
    await Bun.sleep(250)
  }
  check(
    page.url().endsWith("/account"),
    "Enter submitted the form and the code was accepted",
  )

  const framesBeforeHandback = human.frameCount()
  check(framesBeforeHandback > 1, "the cast kept running across the navigation")

  await human.handback()
  const result = await handoff
  pending = null
  timings.handoffMs = Date.now() - handoffAt
  log("handoff_done", {
    outcome: result.outcome,
    durationMs: result.durationMs,
    cookies: result.storageState?.cookies.length,
    ms: timings.handoffMs,
  })

  check(result.outcome === "resolved", "the handoff resolved")
  check(result.url === humanUrl, "the result carries the URL the human used")
  check(
    result.durationMs > 1_000 && result.durationMs < 10 * 60_000,
    `durationMs is plausible (${result.durationMs}ms)`,
  )
  check(result.storageState !== undefined, "storageState was captured")
  check(
    (result.storageState?.cookies.length ?? 0) > 0,
    "storageState carries the session cookie the human earned",
  )
  check(human.ending() === "resolved", "the phone was told the handoff ended")
  await human.close()

  await page.waitForSelector('[data-testid="signed-in"]', { timeout: 15_000 })
  const signedIn = await page.textContent('[data-testid="signed-in"]')
  check(
    signedIn?.includes(app.user) === true,
    `the agent is signed in as ${app.user} (saw "${signedIn}")`,
  )

  const relayGone = await fetch(humanUrl, { cache: "no-store" })
  check(
    relayGone.status !== 200,
    `the relay sandbox is gone (${relayGone.status})`,
  )
  await relayGone.text()

  // --- QR passthrough: the code on the page, opened on the phone ---------
  //
  // The device-change check, which the human on a phone cannot answer by
  // scanning their own screen. The agent reads the code off a full-resolution
  // screenshot and hands the human the link; the human opens it, and the site
  // is satisfied on a device that has never seen it before.
  const qrAt = Date.now()
  await page.goto(previewPath(app.url, "/qr"), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  })
  await page.waitForSelector('[data-testid="qr-code"]', { timeout: 15_000 })

  // The selector only says the element is there. A scan that finds nothing is
  // then two different bugs — a code that never drew, or a decoder that could
  // not read it — and this is what tells them apart.
  const drawn = await page.evaluate(() => {
    const image = document.querySelector("img")
    if (!image) return null
    const rect = image.getBoundingClientRect()
    return {
      complete: image.complete,
      natural: image.naturalWidth,
      css: Math.round(rect.width),
      src: image.src.length,
    }
  })
  log("qr_page", drawn ?? { drawn: false })
  check(
    (drawn?.natural ?? 0) > 0,
    `the code is drawn on the page (${JSON.stringify(drawn)})`,
  )

  let qrUrl = ""
  let qrEvent: HandoffEvent | undefined
  const scanning = raiseHand(page, {
    reason: "Aurora Bank wants this code scanned with your phone",
    qr: false,
    timeoutMs: 60_000,
    onUrl: (url) => {
      qrUrl = url
    },
    onEvent: (raised) => {
      qrEvent = raised
    },
  })
  pending = scanning

  while (qrUrl === "") await Bun.sleep(50)
  const scanner = await openHandoffPage(qrUrl)
  await scanner.waitForFrame()

  const scanAt = Date.now()
  const links = await scanner.scanqr()
  timings.qrScanMs = Date.now() - scanAt
  log("qr_scanned", {
    ms: timings.qrScanMs,
    count: links.length,
    kind: links[0]?.kind,
  })
  if (links.length === 0) {
    // Keep the pixels the agent was looking at. Reading a failure off a
    // screenshot beats guessing at it from a count.
    const evidence = "/tmp/handraise-qr-e2e-failure.png"
    await Bun.write(evidence, await page.screenshot({ type: "png" }))
    log("qr_evidence", { path: evidence })
  }
  check(
    links.length === 1,
    `the agent found exactly one code (${links.length})`,
  )
  check(
    links[0]?.text === app.verifyUrl,
    "the link the human got is the one inside the code on the page",
  )
  check(links[0]?.kind === "url", "an https link is offered as openable")

  // The human "opens" it. A phone, not this browser: no session cookie, no
  // preview cookie, nothing but the link itself.
  const visited = await fetch(links[0]?.text ?? "", { cache: "no-store" })
  const visitedBody = await visited.text()
  check(visited.status === 200, `the link opens (${visited.status})`)
  check(
    visitedBody.includes('data-testid="verified"'),
    "opening it reached the confirmation page",
  )

  await scanner.handback()
  const scanned = await scanning
  pending = null
  timings.qrCaseMs = Date.now() - qrAt
  log("qr_done", {
    outcome: scanned.outcome,
    scans: qrEvent?.qrScans,
    hits: qrEvent?.qrHits,
    ms: timings.qrCaseMs,
  })
  check(scanned.outcome === "resolved", "the QR handoff resolved")
  check(
    qrEvent?.qrScans === 1,
    `the wide event counts one scan (${qrEvent?.qrScans})`,
  )
  check(qrEvent?.qrHits === 1, `and one hit (${qrEvent?.qrHits})`)
  await scanner.close()

  // --- Approval: the human answers a question, and drives nothing --------
  //
  // The other half of the product. No screencast, no input path: one
  // screenshot, the action in words, and a yes or a no.
  const APPROVAL_ACTION = "Transfer EUR 12,430.00 to Acme GmbH"

  async function askApproval(answer: "approve" | "deny"): Promise<void> {
    const askedAt = Date.now()
    let approvalUrl = ""
    let event: HandoffEvent | undefined
    const ack = ackWatcher()
    const asking = raiseHand(page, {
      mode: "approval",
      reason: "The agent may not move money without a human",
      action: APPROVAL_ACTION,
      qr: false,
      timeoutMs: 60_000,
      logger: ack.logger,
      onUrl: (url) => {
        approvalUrl = url
      },
      onEvent: (raised) => {
        event = raised
      },
    })
    pending = asking

    while (approvalUrl === "") await Bun.sleep(50)
    const human = await openHandoffPage(approvalUrl)
    await human.waitForFrame()
    check(
      human.action() === APPROVAL_ACTION,
      `the phone shows the action verbatim (${answer})`,
    )
    check(
      human.reason() === "The agent may not move money without a human",
      `the phone shows the reason (${answer})`,
    )

    // Approval injects nothing, and this is the only place that can be proven
    // against the real page: count what the page itself would see if a tap or
    // a keystroke ever landed on it. `inputsApplied` cannot fail — there is no
    // input target in approval mode — but these listeners can.
    await page.evaluate(() => {
      const counts = { pointerdown: 0, keydown: 0, input: 0 }
      window.handraiseInputCounts = counts
      document.addEventListener(
        "pointerdown",
        () => {
          counts.pointerdown += 1
        },
        true,
      )
      document.addEventListener(
        "keydown",
        () => {
          counts.keydown += 1
        },
        true,
      )
      document.addEventListener(
        "input",
        () => {
          counts.input += 1
        },
        true,
      )
    })
    await human.tap(10, 10)
    await human.type("9", 0)
    await Bun.sleep(500)

    if (answer === "approve") await human.approve()
    else await human.deny()

    // Somebody else opens the same link, right after the answer and while the
    // sandbox is being torn down. Until 0.7.0 they saw a blank page: the
    // `ended` lost its race with the kill, so the relay had nothing to replay.
    // The agent now waits for the relay's receipt before it kills anything,
    // which is what makes this an assertion instead of a log line.
    const lateEnding = await lateViewerEnding(approvalUrl)

    const result = await asking
    pending = null
    timings[`approval${answer}Ms`] = Date.now() - askedAt
    log("approval_done", {
      answer,
      outcome: result.outcome,
      durationMs: result.durationMs,
      frames: human.frameCount(),
      ms: timings[`approval${answer}Ms`],
    })

    const expected = answer === "approve" ? "approved" : "denied"
    check(
      result.outcome === expected,
      `an approval answered with ${answer} reports ${expected}`,
    )
    const counts = await page.evaluate(() => window.handraiseInputCounts)
    check(
      counts?.pointerdown === 0 && counts?.keydown === 0 && counts?.input === 0,
      `the page saw no pointer, key or input event (${JSON.stringify(counts)})`,
    )
    check(
      human.frameCount() === 1 + (event?.reconnects ?? 0),
      `the phone got the screenshot once per connection (${human.frameCount()} frames, ${event?.reconnects} reconnects)`,
    )
    check(result.storageState === undefined, "an approval captures no cookies")
    check(event?.mode === "approval", "the wide event carries the mode")
    check(event?.inputsApplied === 0, "the wide event reports no input applied")
    check(
      event?.framesSent === 1 + (event?.reconnects ?? 0),
      `the wide event counts one frame per connection (${event?.framesSent} frames, ${event?.reconnects} reconnects)`,
    )
    log("phone_ending", { seen: human.ending() ?? "none", expected })
    check(
      acked(ack.lines),
      `the relay stored the ending and said so before the kill (${ack.lines.join(",") || "no ended_ack line"})`,
    )
    // Was an observation until 0.7.0, for the reason the ack now removes: the
    // ending was written to a socket whose sandbox was already being deleted,
    // so whether it was ever relayed was a race. The phone that answered does
    // not need it — it shows its own ending the moment the human taps — but
    // every *other* holder of the link does, and this is the message they are
    // all served from.
    check(
      human.ending() === expected,
      `the answering phone was told over the wire that it ended as ${expected} (saw ${human.ending() ?? "nothing"})`,
    )
    // Measured, not asserted. See lateViewerEnding.
    log("late_viewer", { seen: lateEnding ?? "none", expected })
    await human.close()

    const gone = await fetch(approvalUrl, { cache: "no-store" })
    await gone.text()
    check(gone.status !== 200, `the approval relay is gone (${gone.status})`)
  }

  await askApproval("approve")
  await askApproval("deny")

  // --- An approval answered by a channel, while somebody watches the link -
  //
  // The path a Telegram or Slack adapter takes: handraise hands the channel
  // the screenshot and an `answer()`, and nobody has to open the link at all.
  // The in-process channel here stands in for the adapter; what is under test
  // is the core's side of it against the real relay.
  //
  // And the second half of what 0.7.0 fixes. Somebody else *is* holding the
  // link — two people were sent it, which is the whole reason it is a URL —
  // and they did not answer. Before the relay acknowledged the ending, that
  // person watched the handoff be decided and were told nothing: the `ended`
  // was written to a socket whose sandbox was already being destroyed. Here
  // the viewer is connected before the answer and must be told how it ended.
  const channelAt = Date.now()
  let channelUrl = ""
  let channelEvent: HandoffEvent | undefined
  let channelShot = 0
  const channelAck = ackWatcher()
  // The channel's `answer`, handed out when the adapter is notified and called
  // once the watching viewer is on the link.
  let handAnswer: (answer: (decision: "approve" | "deny") => boolean) => void =
    () => undefined
  const answerReady = new Promise<(decision: "approve" | "deny") => boolean>(
    (resolve) => {
      handAnswer = resolve
    },
  )
  const channelAnswered = raiseHand(page, {
    mode: "approval",
    reason: "The agent may not move money without a human",
    action: APPROVAL_ACTION,
    qr: false,
    timeoutMs: 60_000,
    onUrl: (url) => {
      channelUrl = url
    },
    logger: channelAck.logger,
    onEvent: (raised) => {
      channelEvent = raised
    },
    channels: [
      {
        notify: (raised) => {
          if (raised.mode !== "approval") return
          channelShot = raised.screenshot.length
          check(
            raised.action === APPROVAL_ACTION,
            "the channel is handed the action verbatim",
          )
          check(
            raised.url === channelUrl && channelUrl !== "",
            "the channel is handed the same link the phone would open",
          )
          handAnswer(raised.answer)
        },
      },
    ],
  })
  pending = channelAnswered

  const answerFromChannel = await answerReady
  // The bystander: they opened the link, they are looking at the screenshot,
  // and they are not the one who decides.
  const watcher = await openHandoffPage(channelUrl)
  await watcher.waitForFrame()
  const answeredAt = Date.now()
  check(
    answerFromChannel("approve") === true,
    "the channel's first answer settles the handoff",
  )
  check(
    answerFromChannel("deny") === false,
    "a second answer from the channel is refused",
  )

  const watcherDeadline = Date.now() + 15_000
  while (!watcher.ending() && Date.now() < watcherDeadline) await Bun.sleep(50)
  timings.watcherToldMs = Date.now() - answeredAt
  log("watcher_told", {
    seen: watcher.ending() ?? "none",
    ms: timings.watcherToldMs,
    endedAck: channelAck.lines[0] ?? "none",
  })
  check(
    watcher.ending() === "approved",
    `a second holder of the link who never answered is told it ended as approved (saw ${watcher.ending() ?? "nothing"})`,
  )
  await watcher.close()

  const channelResult = await channelAnswered
  // After the handoff has returned, because that is when the line is written:
  // the watcher above is told at the same moment the agent hears the receipt.
  check(
    acked(channelAck.lines),
    `the relay stored the ending and said so before the kill (${channelAck.lines.join(",") || "no ended_ack line"})`,
  )
  pending = null
  timings.channelApprovalMs = Date.now() - channelAt
  log("channel_approval_done", {
    outcome: channelResult.outcome,
    answeredVia: channelEvent?.answeredVia,
    screenshotBytes: channelShot,
    ms: timings.channelApprovalMs,
  })

  check(
    channelResult.outcome === "approved",
    "an approval answered by a channel reports approved",
  )
  check(
    channelEvent?.answeredVia === "channel",
    `the wide event says who answered (${channelEvent?.answeredVia})`,
  )
  check(
    channelShot > 1000,
    `the channel got the real JPEG, not an empty buffer (${channelShot} bytes)`,
  )
  check(
    channelResult.storageState === undefined,
    "a channel-answered approval captures no cookies either",
  )
  const channelGone = await fetch(channelUrl, { cache: "no-store" })
  await channelGone.text()
  check(
    channelGone.status !== 200,
    `the channel-answered relay is gone (${channelGone.status})`,
  )

  // --- The human who was there and went ----------------------------------
  //
  // The gap this release closes. A human opens the handoff, looks at it, and
  // closes the tab without answering — no handback, no abort, nothing on the
  // wire. The relay is the only party that can see that socket go (it answers
  // the heartbeats itself), so before 0.7.0 the agent sat out the whole
  // `timeoutMs`: five minutes by default, against a browser session with a
  // ten-minute life.
  // A fresh paint first. A CDP screencast delivers a frame when the page
  // composites one, and this page has been sitting still through three
  // approvals — what is under test here is the socket, not the picture, but a
  // handoff that never paints is a confusing way to prove it.
  await page.goto(previewPath(app.url, "/qr"), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  })

  const presenceAt = Date.now()
  let presenceUrl = ""
  let presenceEvent: HandoffEvent | undefined
  const presenceAck = ackWatcher()
  const abandoned = raiseHand(page, {
    reason: "Aurora Bank is asking for a 2FA code",
    qr: false,
    timeoutMs: PRESENCE_TIMEOUT_MS,
    humanGoneGraceMs: PRESENCE_GRACE_MS,
    logger: presenceAck.logger,
    onUrl: (url) => {
      presenceUrl = url
    },
    onEvent: (raised) => {
      presenceEvent = raised
    },
  })
  pending = abandoned

  while (presenceUrl === "") await Bun.sleep(50)
  const leaver = await openHandoffPage(presenceUrl)
  // The phone is *there*, which is the fact under test: the relay reports the
  // socket, and the agent hears about it whether or not a frame has painted.
  const shownDeadline = Date.now() + 30_000
  while (leaver.reason() === "" && Date.now() < shownDeadline) {
    await Bun.sleep(100)
  }
  check(
    leaver.reason() === "Aurora Bank is asking for a 2FA code",
    `the phone is on the handoff (${leaver.reason() || "nothing shown"})`,
  )
  log("presence_phone_open", { frames: leaver.frameCount() })
  const leftAt = Date.now()
  await leaver.close()

  const abandonedResult = await abandoned
  pending = null
  timings.presenceCaseMs = Date.now() - presenceAt
  timings.endedAfterLeaveMs = Date.now() - leftAt
  log("presence_case", {
    outcome: abandonedResult.outcome,
    durationMs: abandonedResult.durationMs,
    afterLeaveMs: timings.endedAfterLeaveMs,
    humanSeen: presenceEvent?.humanSeen,
    humanLeftMs: presenceEvent?.humanLeftMs,
    endedEarly: presenceEvent?.endedEarly,
    endedAck: presenceAck.lines[0] ?? "none",
    ms: timings.presenceCaseMs,
  })

  check(
    abandonedResult.outcome === "timeout",
    `a human who walked away ends the handoff as timeout (${abandonedResult.outcome})`,
  )
  check(
    abandonedResult.durationMs < PRESENCE_TIMEOUT_MS / 2,
    `it ended on the absence, not on the wait (${abandonedResult.durationMs}ms of ${PRESENCE_TIMEOUT_MS}ms)`,
  )
  check(
    timings.endedAfterLeaveMs < PRESENCE_GRACE_MS + 15_000,
    `and it ended within the grace plus teardown (${timings.endedAfterLeaveMs}ms)`,
  )
  check(
    presenceEvent?.humanSeen === true,
    "the wide event says a human was there",
  )
  check(
    presenceEvent?.endedEarly === true,
    "the wide event says the handoff ended early",
  )
  check(
    (presenceEvent?.humanLeftMs ?? -1) >= 0,
    `the wide event says when they left (${presenceEvent?.humanLeftMs})`,
  )
  check(
    acked(presenceAck.lines),
    `the relay acknowledged the ending before the kill (${presenceAck.lines.join(",") || "no ended_ack line"})`,
  )
  const leaverGone = await fetch(presenceUrl, { cache: "no-store" })
  await leaverGone.text()
  check(
    leaverGone.status !== 200,
    `its relay was destroyed too (${leaverGone.status})`,
  )

  // --- The cheap second case: nobody comes -------------------------------
  const timeoutAt = Date.now()
  let secondUrl = ""
  const waiting = raiseHand(page, {
    reason: "nobody is going to answer this one",
    qr: false,
    timeoutMs: TIMEOUT_CASE_MS,
    onUrl: (url) => {
      secondUrl = url
    },
  })
  pending = waiting
  const timedOut = await waiting
  pending = null
  timings.timeoutCaseMs = Date.now() - timeoutAt
  log("timeout_case", {
    outcome: timedOut.outcome,
    durationMs: timedOut.durationMs,
    ms: timings.timeoutCaseMs,
  })

  check(timedOut.outcome === "timeout", "an unanswered handoff times out")
  check(
    timedOut.durationMs >= TIMEOUT_CASE_MS,
    `it waited the full ${TIMEOUT_CASE_MS}ms (${timedOut.durationMs}ms)`,
  )
  check(
    timedOut.storageState === undefined,
    "a timed-out handoff captures no cookies",
  )
  const secondGone = await fetch(secondUrl, { cache: "no-store" })
  await secondGone.text()
  check(
    secondGone.status !== 200,
    `its relay was destroyed too (${secondGone.status})`,
  )

  console.log(
    JSON.stringify(
      { evt: "e2e_passed", totalMs: Date.now() - started, timings },
      null,
      2,
    ),
  )
} finally {
  await browser?.close().catch(() => undefined)
  // The handoff notices the dead browser, reports `disconnected` and releases
  // its relay. Awaiting it here is what keeps a failed run from leaking one.
  await pending?.catch(() => undefined)
  await solari.close().catch(() => undefined)
  await app.kill().catch(() => undefined)
  log("cleaned_up")
}
