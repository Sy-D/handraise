/**
 * The relay's failure codes, without the live API.
 *
 * Every case here is reachable offline: a real `node:http` server standing in
 * for the Solari gateway (no module mocking — the SDK does its own fetch, its
 * own retries and its own error mapping, and that mapping is half of what is
 * under test), or a port nothing listens on.
 *
 *   bun test src/relay/deploy.test.ts
 */
import { expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import {
  ConcurrencyLimitError,
  GatewayError,
  type Sandbox,
  SolariClient,
} from "@solarisdk/sdk"

import { isHandraiseError } from "../errors"
import { noopLogger } from "../logger"
import {
  createSandbox,
  killSandbox,
  redactPreviewToken,
  startRelay,
  waitForHealth,
} from "./deploy"

/** A port on which nothing listens, so no test here can reach a live gateway. */
const CLOSED_PORT = "http://127.0.0.1:1"

/** A token shaped like the real thing, long enough to be unmistakable in a diff. */
const FAKE_TOKEN = `pt_${"a1b2c3d4".repeat(8)}`

/**
 * The code of the `HandraiseError` `run` rejects with, or a sentence saying
 * what it did instead — so a regression reads as a diff, not as a stack.
 */
async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
    return "nothing was thrown"
  } catch (error) {
    if (isHandraiseError(error)) return error.code
    return `not a HandraiseError: ${String(error)}`
  }
}

/**
 * The class of the error `run`'s `HandraiseError` wrapped, by name — the proof
 * that the original SDK error is still reachable through `cause`.
 */
async function causeNameOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
    return "nothing was thrown"
  } catch (error) {
    if (!isHandraiseError(error))
      return `not a HandraiseError: ${String(error)}`
    const cause = error.cause
    return cause instanceof Error
      ? cause.constructor.name
      : `the cause is not an error: ${String(cause)}`
  }
}

/** The message `run` rejects with, whatever class it is. */
async function messageOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
    return "nothing was thrown"
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * A gateway that answers `POST /sandboxes` the way the real one does when the
 * account is at its session cap: 429 with `code: "ConcurrencyLimitExceeded"`,
 * which is what the SDK maps onto `ConcurrencyLimitError`.
 */
async function startBusyGateway(): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        code: "ConcurrencyLimitExceeded",
        // `mapGatewayError` puts this straight into the error's message, and
        // the message goes into ours — so it is foreign text on a path a
        // caller logs, and a gateway that quotes the request can put a
        // credential in it.
        message: `Concurrency limit exceeded: 2 of 2 sessions in use (request /sandboxes?pt_token=${FAKE_TOKEN})`,
      }),
    )
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })
  // SAFETY: the server listens on a TCP port; `address()` only returns a
  // string for a unix socket.
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, server }
}

/**
 * A preview proxy that refuses the request and quotes the request line back —
 * what several proxies do by default on a 401 or a 404, and the one path on
 * which a live `pt_token` could reach an error message.
 */
async function startEchoingProxy(): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    response.writeHead(401, { "content-type": "text/plain" })
    response.end(`Not authorised for GET ${request.url}`)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })
  // SAFETY: as above — a TCP listener never has a string address.
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, server }
}

test("a gateway at its session cap becomes concurrency_limit, not a raw 429", async () => {
  const gateway = await startBusyGateway()
  try {
    const client = new SolariClient({
      apiKey: "not-a-real-key",
      baseUrl: gateway.url,
    })

    // One attempt: the shipped budget of six exists to wait out a busy
    // account, and waiting it out here would only prove `setTimeout` works.
    const creating = createSandbox(client, 60_000, 1)

    expect(await codeOf(creating)).toBe("concurrency_limit")
    // The SDK's own error is kept, so a caller that wants the HTTP status
    // still has it.
    expect(await causeNameOf(creating)).toBe(ConcurrencyLimitError.name)
    // The gateway's own words are quoted into our message — redacted first.
    const message = await messageOf(creating)
    expect(message).toContain("concurrent session limit")
    expect(message).not.toContain(FAKE_TOKEN)
  } finally {
    // In a `finally`: a failed expectation above must not leave a listening
    // socket behind for the rest of the run.
    gateway.server.close()
  }
})

test("a gateway that cannot be reached at all becomes relay_start_failed", async () => {
  // No live API: port 1 refuses the connection, the SDK exhausts its own
  // retries, and what comes back must still be a code the caller can branch on.
  const starting = startRelay({
    apiKey: "not-a-real-key",
    baseUrl: CLOSED_PORT,
    logger: noopLogger,
  })

  expect(await codeOf(starting)).toBe("relay_start_failed")
  // Whatever the SDK gave up with is still attached; here it is the transport
  // saying it could not connect.
  expect(await causeNameOf(starting)).toBe("ConnectionError")
}, 30_000)

test("a public URL that never answers becomes relay_not_ready", async () => {
  // The sandbox is up but its preview never routes: the phone would sit on a
  // page that does not load, which is a different fix from a failed create.
  const waiting = waitForHealth(`${CLOSED_PORT}/healthz`, 200)

  expect(await codeOf(waiting)).toBe("relay_not_ready")
})

test("a relay sandbox that will not die is surfaced, not swallowed", async () => {
  let attempts = 0
  const stubborn: Pick<Sandbox, "kill"> = {
    kill: async () => {
      attempts += 1
      throw new GatewayError(500, "the host is not answering")
    },
  }

  // Two attempts rather than the shipped four: the retry is what is under
  // test, not the backoff.
  const killing = killSandbox(stubborn, 2)

  // Deliberately not a coded error: both callers catch this and log
  // `relay_release_failed`, so it can never reach a `catch` around
  // `raiseHand`, and a code nobody can branch on would be dead API surface.
  await expect(killing).rejects.toThrow(/could not destroy the relay sandbox/)
  expect(await codeOf(killing)).toStartWith("not a HandraiseError")
  expect(attempts).toBe(2)
  expect(await causeNameOf(killing)).toStartWith("not a HandraiseError")
})

test("a sandbox that is already gone is not a failure", async () => {
  // 404 is the goal, reached by somebody else — an idle timeout, a second
  // `kill()`. Retrying it would only turn a success into a 2-second stall.
  const vanished: Pick<Sandbox, "kill"> = {
    kill: async () => {
      throw new GatewayError(404, "sandbox not found")
    },
  }

  expect(await codeOf(killSandbox(vanished, 4))).toBe("nothing was thrown")
})

test("a proxy that echoes the request URI cannot leak the preview token", async () => {
  // Every URL handraise polls carries `?pt_token=…`, a live bearer credential
  // with an hour of life on it. This body is the one place a proxy's own text
  // reaches an exception message — and exception messages get logged.
  const proxy = await startEchoingProxy()
  try {
    // Long enough that the proxy's 401 — not the per-request abort — is what
    // the deadline finds in `lastAnswer`, however loaded the machine is.
    const waiting = waitForHealth(
      `${proxy.url}/healthz?pt_token=${FAKE_TOKEN}&role=human`,
      1500,
    )

    expect(await codeOf(waiting)).toBe("relay_not_ready")
    const message = await messageOf(waiting)
    expect(message).not.toContain(FAKE_TOKEN)
    expect(message).toContain("pt_token=[redacted]")
    // The status is still there: it is the difference between "not routable
    // yet" and "the token is wrong".
    expect(message).toContain("HTTP 401")
  } finally {
    proxy.server.close()
  }
})

test("redaction survives every form a token arrives in", () => {
  // The forms a proxy body actually produces. Every one of these was a leak
  // before the second rule; the plain `pt_token=` case never was, which is
  // exactly why testing only that one proved nothing.
  const leaks = [
    `?pt_token=${FAKE_TOKEN}`,
    `?pt_token=${FAKE_TOKEN}&role=human`,
    `pt_token=${FAKE_TOKEN};role=human`,
    `GET "/?pt_token=${FAKE_TOKEN}" failed`,
    `fetch https://x.preview.getsolari.com/?pt_token=${FAKE_TOKEN} failed`,
    // Percent-encoded inside a redirect parameter — a 302/401 default.
    `?next=%2Fhealthz%3Fpt_token%3D${FAKE_TOKEN}`,
    `%2Fhealthz%3Fpt_token%3D${FAKE_TOKEN}`,
    // An auth proxy quoting the credential in prose, with no parameter at all.
    `invalid preview token ${FAKE_TOKEN}`,
    // An uppercased parameter name, an HTML-entity `=`, and a stray space.
    `?PT_TOKEN=${FAKE_TOKEN}`,
    `?pt_token&#61;${FAKE_TOKEN}`,
    `pt_token= ${FAKE_TOKEN}`,
    `pt_token=${FAKE_TOKEN}\nx-request-id: 7`,
  ]

  for (const leak of leaks) {
    expect(redactPreviewToken(leak)).not.toContain(FAKE_TOKEN)
  }

  // The syntax around the credential survives, so the message still reads.
  expect(redactPreviewToken(`?pt_token=${FAKE_TOKEN}&role=human`)).toBe(
    "?pt_token=[redacted]&role=human",
  )
  expect(redactPreviewToken(`invalid preview token ${FAKE_TOKEN}`)).toBe(
    "invalid preview token pt_[redacted]",
  )
  // Nothing else is touched.
  expect(redactPreviewToken("HTTP 502 upstream closed")).toBe(
    "HTTP 502 upstream closed",
  )
})

/**
 * A server that accepts the connection and never answers — what a preview
 * route that is not wired up yet looks like from outside. It is the case that
 * a deadline checked only *between* requests can never end.
 */
async function startHangingServer(): Promise<{ url: string; stop(): void }> {
  const open: Socket[] = []
  const server = createServer((request) => {
    // Hold the request: no write, no end, no close.
    open.push(request.socket)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })
  // SAFETY: as above — a TCP listener never has a string address.
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      for (const socket of open) socket.destroy()
      server.close()
    },
  }
}

test("a public URL that accepts and never answers still hits the deadline", async () => {
  // Without a per-request `signal` the loop suspends inside `fetch`: bun has
  // no default request timeout at all and node's undici waits 300 s, so the
  // sandbox would burn its idle window while `raiseHand` blocks — and the
  // message would then state a deadline that was never enforced.
  const hanging = await startHangingServer()
  try {
    const startedAt = Date.now()
    const waiting = waitForHealth(`${hanging.url}/healthz`, 300)

    expect(await codeOf(waiting)).toBe("relay_not_ready")
    // Slack for the abort and one poll interval, not for a second request.
    expect(Date.now() - startedAt).toBeLessThan(2000)
  } finally {
    hanging.stop()
  }
}, 15_000)
