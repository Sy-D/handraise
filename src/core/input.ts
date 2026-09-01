/**
 * The return channel: what the human does on their phone, replayed into the
 * remote page as real CDP input events.
 *
 * Everything here was verified against a live Solari cloud browser in
 * spikes/s3-report.md. The three findings that shape this file:
 *
 * 1. Mouse, not touch. `Input.dispatchMouseEvent` produces `isTrusted: true`
 *    events and a compat click; touch events need the page to expect them.
 * 2. Printable characters need `keyDown` **with** `text`. `Input.insertText`
 *    fires `input` but no `keydown`, which silently breaks the split OTP boxes
 *    that are the headline use case.
 * 3. Coordinates arrive in frame pixels and are converted here, on the agent
 *    side, because only this side sees the screencast metadata. Never add
 *    scroll offsets: CDP input coordinates are viewport-relative and the frame
 *    already shows the scrolled viewport.
 */
import type { CDPSession } from "playwright-core"

import type { FrameMeta, HumanToAgent } from "../relay/protocol"

/**
 * The slice of Playwright's `CDPSession` this module uses. Narrow on purpose:
 * it keeps the protocol's own typing for `send` while letting a test drive the
 * module without a browser.
 */
export type CdpChannel = Pick<CDPSession, "send">

/** A point in CSS pixels, relative to the top-left of the layout viewport. */
export interface PagePoint {
  x: number
  y: number
}

/** Frame pixels per CSS pixel, per axis. */
interface FrameScale {
  x: number
  y: number
}

/**
 * Chromium clamps the screencast to `maxWidth`/`maxHeight` and preserves the
 * aspect ratio, so both factors are normally the same number — but the frame
 * is scaled and the metadata is not (spikes/s2-report.md trap 6), so the ratio
 * has to come from the actual JPEG, never from the requested maximum.
 */
function frameScale(meta: FrameMeta): FrameScale {
  const x = meta.jpegWidth / meta.deviceWidth
  const y = meta.jpegHeight / meta.deviceHeight
  return {
    x: Number.isFinite(x) && x > 0 ? x : 1,
    y: Number.isFinite(y) && y > 0 ? y : 1,
  }
}

/** Pinch zoom, when the page has any. A missing or zero factor means 1:1. */
function zoomOf(meta: FrameMeta): number {
  return meta.pageScaleFactor > 0 ? meta.pageScaleFactor : 1
}

/** Map a tap in the phone's frame to CSS viewport pixels of the remote page. */
export function frameToPage(
  fx: number,
  fy: number,
  meta: FrameMeta,
): PagePoint {
  const scale = frameScale(meta)
  const zoom = zoomOf(meta)
  return { x: fx / (scale.x * zoom), y: fy / (scale.y * zoom) }
}

/**
 * Map a scroll distance in frame pixels to page pixels.
 *
 * The sign is already in wheel convention when it leaves the phone (positive =
 * scroll down, inverted from the finger so that dragging down reveals earlier
 * content), so there is deliberately no flip here.
 */
export function frameDeltaToPage(fdy: number, meta: FrameMeta): number {
  return fdy / (frameScale(meta).y * zoomOf(meta))
}

/** The middle of the viewport — the scroll anchor before the human has tapped. */
export function viewportCentre(meta: FrameMeta): PagePoint {
  return { x: meta.deviceWidth / 2, y: meta.deviceHeight / 2 }
}

interface KeyDefinition {
  code: string
  keyCode: number
  /** Present only for keys that must also produce a `keypress`. */
  text?: string
}

/**
 * The three keys the phone keyboard can send.
 *
 * Enter carries `text: "\r"`. That looks wrong next to "non-printables use
 * rawKeyDown", and it is the one exception that matters: Blink triggers
 * implicit form submission from the `keypress` handler, and `rawKeyDown`
 * produces no `keypress`. An Enter without `text` fires `keydown`, looks
 * correct in a listener log, and never submits the form. Verified in
 * spikes/s3-report.md; it also inserts no character.
 */
const KEY_TABLE = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", keyCode: 8 },
  Tab: { code: "Tab", keyCode: 9 },
} satisfies Record<string, KeyDefinition>

export type SendableKey = keyof typeof KEY_TABLE

async function dispatchKey(
  cdp: CdpChannel,
  key: SendableKey,
  definition: KeyDefinition,
): Promise<void> {
  const shared = {
    key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  }
  if (definition.text === undefined) {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...shared })
  } else {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...shared,
      text: definition.text,
      unmodifiedText: definition.text,
    })
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...shared })
}

/**
 * Modifier bitmask (spikes/s3-report.md): Alt 1, Ctrl 2, Meta 4, Shift 8. The
 * remote page runs on Linux Chromium, so select-all is Ctrl+A, never Meta+A.
 */
const CTRL = 2

/**
 * Select everything in the focused field.
 *
 * `rawKeyDown` with no `text`, because any modifier other than Shift has to
 * suppress `text` — a `keyDown` carrying "a" here types an "a" into the field
 * instead of selecting its contents (verified in spikes/s3-report.md).
 */
async function selectAll(cdp: CdpChannel): Promise<void> {
  const shared = {
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: CTRL,
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...shared })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...shared })
}

async function typeCharacter(cdp: CdpChannel, ch: string): Promise<void> {
  if (ch.length === 0) return
  const keyCode = ch.toUpperCase().charCodeAt(0)
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: ch,
    text: ch,
    unmodifiedText: ch,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: ch,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  })
}

async function clickAt(cdp: CdpChannel, at: PagePoint): Promise<void> {
  // Hover first: menus and tooltips that only open on mouseover otherwise
  // never see the pointer arrive.
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: at.x,
    y: at.y,
    button: "none",
    buttons: 0,
  })
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: at.x,
    y: at.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  })
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: at.x,
    y: at.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  })
}

export interface InputTarget {
  /**
   * Apply one human message. Calls are serialised in arrival order, so a fast
   * typist cannot interleave two keystrokes. Rejects if CDP rejects — the
   * caller decides whether that means the session is gone.
   */
  apply(message: HumanToAgent, meta: FrameMeta): Promise<void>
  /** Where a scroll will be aimed: the last tap, or the viewport centre. */
  anchor(meta: FrameMeta): PagePoint
  /**
   * Resolve once every input queued so far has been dispatched. Used before a
   * handback commits, so no keystroke the human sent still runs against the
   * page while it is being snapshotted and torn down.
   */
  drain(): Promise<void>
  /**
   * Taps, characters, keys, clears and scrolls dispatched to the page. Dropped
   * messages (an over-long char, an unmapped key, a flood past the cap) and the
   * `handback`/`abort` lifecycle messages do not count.
   */
  applied(): number
}

/**
 * Cap on the number of unfinished input messages. A human types a handful per
 * second; a flood past this is a client trying to grow the serialisation queue
 * without bound, so drop the excess rather than buffer it.
 */
const MAX_QUEUE_DEPTH = 256

/** Bind the input channel to one CDP session. */
export function createInputTarget(cdp: CdpChannel): InputTarget {
  let lastTap: PagePoint | null = null
  let queue: Promise<void> = Promise.resolve()
  let depth = 0
  // Incremented only after an input reaches the page, so the wide event counts
  // what the human actually did, not what a hostile client tried to send.
  let appliedCount = 0

  const anchor = (meta: FrameMeta): PagePoint => lastTap ?? viewportCentre(meta)

  const dispatch = async (
    message: HumanToAgent,
    meta: FrameMeta,
  ): Promise<void> => {
    switch (message.type) {
      case "tap": {
        const at = frameToPage(message.fx, message.fy, meta)
        lastTap = at
        await clickAt(cdp, at)
        appliedCount += 1
        return
      }
      case "char":
        // The mobile UI sends exactly one character per message; a longer
        // string is a malformed or hostile client trying to push an arbitrary
        // payload into the page. Drop it rather than type it.
        if (message.ch.length !== 1) return
        await typeCharacter(cdp, message.ch)
        appliedCount += 1
        return
      case "key":
        // `key` is typed as SendableKey but arrives as untrusted JSON. Reject
        // anything outside the table so a value like "constructor" or "F1"
        // cannot index a prototype member or reach an unmapped key.
        if (!Object.hasOwn(KEY_TABLE, message.key)) return
        await dispatchKey(cdp, message.key, KEY_TABLE[message.key])
        appliedCount += 1
        return
      case "clear":
        // Nothing focused means Ctrl+A selects the document instead of a field
        // value, and the Backspace then goes nowhere: harmless, and the phone
        // greys the key out anyway. Both halves are ordinary key events, so a
        // page with a keydown listener sees exactly what a human would send.
        await selectAll(cdp)
        await dispatchKey(cdp, "Backspace", KEY_TABLE.Backspace)
        appliedCount += 1
        return
      case "scroll": {
        // A scroll message carries no anchor point, and mouseWheel needs one.
        const at = anchor(meta)
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          button: "none",
          deltaX: 0,
          deltaY: frameDeltaToPage(message.fdy, meta),
        })
        appliedCount += 1
        return
      }
      case "handback":
      case "abort":
        // Lifecycle, not input. raiseHand handles these.
        return
    }
  }

  return {
    anchor,
    applied: () => appliedCount,
    apply(message, meta) {
      if (depth >= MAX_QUEUE_DEPTH) return Promise.resolve()
      depth += 1
      const next = queue.then(() => dispatch(message, meta))
      queue = next
        .catch(() => undefined)
        .finally(() => {
          depth -= 1
        })
      return next
    },
    drain() {
      return queue.then(() => undefined)
    },
  }
}
