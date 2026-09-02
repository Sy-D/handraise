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
import type { AddressInfo } from "node:net"
import {
  ConcurrencyLimitError,
  GatewayError,
  type Sandbox,
  SolariClient,
} from "@solarisdk/sdk"

import { isHandraiseError } from "../errors"
import { noopLogger } from "../logger"
import { createSandbox, killSandbox, startRelay, waitForHealth } from "./deploy"

/** A port on which nothing listens, so no test here can reach a live gateway. */
const CLOSED_PORT = "http://127.0.0.1:1"

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
        message: "Concurrency limit exceeded: 2 of 2 sessions in use",
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

test("a gateway at its session cap becomes concurrency_limit, not a raw 429", async () => {
  const gateway = await startBusyGateway()
  const client = new SolariClient({
    apiKey: "not-a-real-key",
    baseUrl: gateway.url,
  })

  // One attempt: the shipped budget of six exists to wait out a busy account,
  // and waiting it out here would only prove that `setTimeout` works.
  const creating = createSandbox(client, 60_000, 1)

  expect(await codeOf(creating)).toBe("concurrency_limit")
  // The SDK's own error is kept, so a caller that wants the HTTP status still
  // has it.
  expect(await causeNameOf(creating)).toBe(ConcurrencyLimitError.name)
  gateway.server.close()
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

test("a relay sandbox that will not die becomes relay_kill_failed", async () => {
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

  expect(await codeOf(killing)).toBe("relay_kill_failed")
  expect(attempts).toBe(2)
  expect(await causeNameOf(killing)).toBe(GatewayError.name)
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
