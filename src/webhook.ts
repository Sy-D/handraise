/**
 * The generic notification hook.
 *
 * One POST with a flat JSON body, because that is the lowest common
 * denominator that Slack, Discord, ntfy, Telegram bots and a three-line
 * Express endpoint all accept. handraise deliberately ships no per-vendor
 * integrations: a webhook the caller can point anywhere ages better than a
 * Slack client that needs a token and a scope.
 */
import { type Logger, quietLogger } from "./logger"

/** Body of the notification POST. */
export interface WebhookPayload {
  /** The public handoff page. Treat it as a bearer credential. */
  url: string
  /** The `reason` the agent gave, verbatim. */
  reason: string
  /** Identifies this handoff, for correlating a message with a log line. */
  sessionId: string
}

const TIMEOUT_MS = 10_000

/**
 * Notify the webhook. Failures are logged and swallowed: the handoff page
 * already exists by the time this runs, and a broken Slack URL must not cost
 * the caller a browser session.
 */
export async function notifyWebhook(
  webhookUrl: string,
  payload: WebhookPayload,
  logger: Logger = quietLogger,
): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      logger.warn("webhook_rejected", {
        status: response.status,
        statusText: response.statusText,
      })
    }
  } catch (error) {
    logger.warn("webhook_failed", { error: String(error) })
  }
}
