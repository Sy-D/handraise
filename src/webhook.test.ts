/**
 * The webhook against a real local HTTP server: what leaves the process is
 * the JSON body a Slack/Discord/Telegram endpoint would see, so the test reads
 * it off the wire rather than off a mock.
 */
import { afterEach, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { LogFields, Logger } from "./logger"
import { notifyWebhook, type WebhookPayload } from "./webhook"

interface Received {
  method: string | undefined
  contentType: string | undefined
  body: string
}

interface Endpoint {
  url: string
  received: Received[]
  close(): Promise<void>
}

const endpoints: Endpoint[] = []

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

/** A real endpoint on a free port that records every POST and answers `status`. */
async function listen(status: number): Promise<Endpoint> {
  const received: Received[] = []
  const server: Server = createServer(async (request, response) => {
    received.push({
      method: request.method,
      contentType: request.headers["content-type"],
      body: await readBody(request),
    })
    response.writeHead(status)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  // SAFETY: a TCP listener's address() is an AddressInfo; the string form
  // exists only for pipe and Unix-socket servers, which this is not.
  const { port } = server.address() as AddressInfo
  const endpoint: Endpoint = {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
  endpoints.push(endpoint)
  return endpoint
}

afterEach(async () => {
  while (endpoints.length > 0) await endpoints.pop()?.close()
})

/** A logger that keeps what it was told, so a test can assert on it. */
function recordingLogger() {
  const warnings: string[] = []
  const nothing = (_event: string, _fields?: LogFields): void => {}
  const logger: Logger = {
    debug: nothing,
    info: nothing,
    warn: (event: string) => {
      warnings.push(event)
    },
    error: nothing,
  }
  return { logger, warnings }
}

const APPROVAL: WebhookPayload = {
  url: "https://relay.example/?pt_token=t",
  reason: "I may not move money without a human",
  mode: "approval",
  action: "Submit EUR 12,430 vendor payment to Acme GmbH",
  sessionId: "relay-abc",
}

test("the body is the payload as JSON, mode and action included", async () => {
  const endpoint = await listen(200)
  await notifyWebhook(endpoint.url, APPROVAL)
  expect(endpoint.received).toHaveLength(1)
  const only = endpoint.received[0]
  expect(only?.method).toBe("POST")
  expect(only?.contentType).toBe("application/json")
  expect(JSON.parse(only?.body ?? "null")).toEqual(APPROVAL)
})

test("a takeover payload has no action key at all", async () => {
  const endpoint = await listen(200)
  await notifyWebhook(endpoint.url, {
    url: APPROVAL.url,
    reason: "GitHub is asking for a 2FA code",
    mode: "takeover",
    sessionId: "relay-abc",
  })
  const body = JSON.parse(endpoint.received[0]?.body ?? "null")
  expect(body.mode).toBe("takeover")
  expect("action" in body).toBe(false)
})

test("a rejecting endpoint is a warning, not a throw", async () => {
  const endpoint = await listen(500)
  const { logger, warnings } = recordingLogger()
  await notifyWebhook(endpoint.url, APPROVAL, logger)
  expect(warnings).toEqual(["webhook_rejected"])
})

test("an unreachable endpoint is a warning, not a throw", async () => {
  const { logger, warnings } = recordingLogger()
  await notifyWebhook("http://127.0.0.1:1/hook", APPROVAL, logger)
  expect(warnings).toEqual(["webhook_failed"])
})

/** A logger over a transport that has gone away: every call throws. */
function hostileLogger(): Logger {
  const down = (): never => {
    throw new Error("logger is down (EPIPE)")
  }
  return { debug: down, info: down, warn: down, error: down }
}

test("a logger that throws cannot make this promise reject", async () => {
  // `raiseHand` fires this and only awaits it in its `finally`, minutes later.
  // A rejection would sit unhandled for the whole handoff — node ends the
  // process for that — and would then throw out of the `finally`, after a
  // human has already been shown the URL. A caller's `logger` is the last
  // thing in here that can throw: a pino instance over a closed transport, a
  // sink that decided a field was unserialisable.
  const logger = hostileLogger()

  // Both failure paths reach a `warn`: an endpoint that rejects the POST, and
  // one that cannot be reached at all.
  const endpoint = await listen(500)
  expect(await notifyWebhook(endpoint.url, APPROVAL, logger)).toBeUndefined()
  expect(
    await notifyWebhook("http://127.0.0.1:1/hook", APPROVAL, logger),
  ).toBeUndefined()
})
