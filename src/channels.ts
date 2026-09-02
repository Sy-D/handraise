/**
 * Channels: where else the handoff shows up.
 *
 * The QR code, `onUrl` and `webhookUrl` all say the same thing — "here is a
 * link" — and none of them can carry an answer back. A chat channel can: an
 * approval is a screenshot, a sentence and two buttons, which is exactly what
 * a Telegram or Slack message already is.
 *
 * So a channel is an object with one method. handraise calls it once per
 * handoff with everything the message needs (the link, the reason, and in
 * approval mode the JPEG the phone is looking at), and hands it a way to
 * answer in-process. The adapter never speaks the relay's wire protocol, never
 * holds the human's WebSocket slot, and cannot make the handoff fail:
 * `notify` is not awaited, and a throw or rejection is one `channel_failed`
 * warning ([`docs/adr/0007`](../docs/adr/0007-channels.md)).
 */
import type { HandoffMode, HandoffOutcome } from "./types"

/** The fields every channel gets, whatever the mode. */
export interface ChannelHandoffBase {
  /** Correlation key, the same one the wide event carries. */
  handoffId: string
  /**
   * The public handoff page. It is a bearer credential: whoever holds it can
   * drive the browser (takeover) or answer (approval), so a channel that posts
   * it is choosing who may do that.
   */
  url: string
  /** The `reason` the agent gave, verbatim — the phone shows the same string. */
  reason: string
  /** What the human is being asked for. Discriminates this union. */
  mode: HandoffMode
  /**
   * Resolves with the outcome the moment the handoff ends, whatever ended it —
   * an answer from the phone, an answer from this or another channel, the
   * timeout, a dead browser session. Never rejects.
   *
   * This is the only way a channel learns that it is no longer needed. Without
   * it an adapter that waits for a reply has nothing to wait on but its own
   * clock: it keeps a chat message live and a connection open long after the
   * handoff is over, and a script that has already printed its result sits
   * there until that clock runs out.
   *
   * It is the same promise for every channel of one handoff, and it stays
   * resolved — awaiting it after the fact returns immediately.
   */
  settled: Promise<HandoffOutcome>
}

/**
 * A takeover: the human has to drive the browser, which only the handoff page
 * can do. All a channel can usefully do here is deliver the link.
 */
export interface TakeoverChannelHandoff extends ChannelHandoffBase {
  mode: "takeover"
}

/**
 * An approval: one screenshot and one question, which a chat message can carry
 * end to end — including the answer.
 */
export interface ApprovalChannelHandoff extends ChannelHandoffBase {
  mode: "approval"
  /** The concrete step being decided, verbatim. */
  action: string
  /**
   * The JPEG the phone is showing, decoded — the same bytes, not a second
   * screenshot of a page that may have moved on.
   */
  screenshot: Buffer
  /**
   * Answer the handoff from the channel, without the handoff page.
   *
   * Returns `true` if this answer settled the handoff and `false` if it was
   * already settled — by the phone, by another channel, by the timeout or by a
   * dead session. A boolean rather than a throw because "somebody was faster"
   * is the ordinary case for an approval that went to two places at once, and
   * an adapter has to render it ("already decided elsewhere"), not handle it.
   *
   * The losing answer changes nothing: the outcome, the wide event and the
   * ending the phone sees are the first answer's.
   */
  answer(decision: "approve" | "deny"): boolean
}

/**
 * One handoff, as a channel adapter sees it. A discriminated union on `mode`,
 * like `RaiseHandOptions`: `answer` and `screenshot` do not exist on a
 * takeover, so an adapter cannot reach for them where they would be undefined.
 */
export type ChannelHandoff = TakeoverChannelHandoff | ApprovalChannelHandoff

/**
 * A place a handoff is announced, and possibly answered.
 *
 * `notify` is called exactly once per handoff, per channel, as soon as there
 * is something to send: the URL in takeover mode, the URL and the screenshot
 * in approval mode. handraise does not await it — the human may already be
 * scanning the QR code while a chat API is still thinking — and catches
 * whatever it throws or rejects with.
 */
export interface HandoffChannel {
  notify(handoff: ChannelHandoff): void | Promise<void>
}
