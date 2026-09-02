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
  relayStartError,
  startRelay,
  waitForHealth,
} from "./deploy"

/** A port on which nothing listens, so no test here can reach a live gateway. */
const CLOSED_PORT = "http://127.0.0.1:1"

/**
 * A token shaped like the real thing: the preview credential is a ~362-char
 * JWT — three base64url segments — and not a `pt_`-prefixed opaque string
 * (docs/measurements/01-preview-transport.md §3). A fixture with the wrong
 * grammar is why the redaction looked covered while a real token walked
 * through it.
 */
const FAKE_TOKEN = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzYW5kYm94SWQiOiJzYngtZmFrZSIsInBvcnQiOjMwMDAsIm9yZ0lkIjoib3JnLWZha2UiLCJleHAiOjIwMDAwMDAwMDAsIm5vdGUiOiJub3QtYS1yZWFsLWNyZWRlbnRpYWwifQ",
  "c2lnbmF0dXJlLW9mLWEtZml4dHVyZS1ub3QtYS1yZWFsLWNyZWRlbnRpYWw",
].join(".")

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
 * The gateway's own words as they survive on `cause`: its status, its message
 * and its parsed body. All three are read by anything that prints an error
 * chain — `console.error(error)`, pino's error serialiser, a crash reporter —
 * so a credential in any of them is a credential in the log.
 */
async function gatewayCauseOf(run: Promise<unknown>): Promise<{
  status: number
  message: string
  body: string
}> {
  const missing = { status: 0, body: "" }
  try {
    await run
    return { ...missing, message: "nothing was thrown" }
  } catch (error) {
    if (!isHandraiseError(error))
      return { ...missing, message: `not a HandraiseError: ${String(error)}` }
    const cause = error.cause
    if (!(cause instanceof GatewayError))
      return {
        ...missing,
        message: `the cause is not a GatewayError: ${String(cause)}`,
      }
    return {
      status: cause.status,
      message: cause.message,
      body: JSON.stringify(cause.body),
    }
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

    // …and the same words on the `cause`, which is where a clean outer message
    // stops helping: printing an error prints its chain.
    const cause = await gatewayCauseOf(creating)
    expect(cause.message).not.toContain(FAKE_TOKEN)
    expect(cause.body).not.toContain(FAKE_TOKEN)
    // What a caller branches on survives the redaction: the status, the
    // gateway's code, and enough of the sentence to read.
    expect(cause.status).toBe(429)
    expect(cause.body).toContain("ConcurrencyLimitExceeded")
    expect(cause.message).toContain("Concurrency limit exceeded")
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

/**
 * A preview edge that quotes the credential the way the real one does on a bad
 * token — bare in prose — plus the `%3D` form a redirect hint produces. Both
 * are what a `pt_`-shaped rule cannot see once the token is the JWT it really
 * is.
 */
async function startTokenQuotingProxy(): Promise<{
  url: string
  server: Server
}> {
  const server = createServer((request, response) => {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams
    const token = query.get("pt_token") ?? ""
    response.writeHead(401, { "content-type": "text/plain" })
    response.end(
      `invalid preview token ${token}. Present it as ?pt_token%3D${token}`,
    )
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })
  // SAFETY: as above — a TCP listener never has a string address.
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, server }
}

test("a proxy that quotes the token bare cannot leak it either", async () => {
  // The health URL carries the credential, so handraise knows its exact value
  // and does not have to guess its grammar. This is the case the guess got
  // wrong: a real preview token is a JWT, and neither `pt_token=` nor a
  // `pt_`-prefixed value appears in either sentence below.
  const proxy = await startTokenQuotingProxy()
  try {
    const waiting = waitForHealth(
      `${proxy.url}/healthz?pt_token=${FAKE_TOKEN}&role=human`,
      1500,
    )

    expect(await codeOf(waiting)).toBe("relay_not_ready")
    const message = await messageOf(waiting)
    expect(message).not.toContain(FAKE_TOKEN)
    // Not even a segment of it: a JWT's payload alone decodes to the sandbox
    // and org it was minted for.
    for (const segment of FAKE_TOKEN.split("."))
      expect(message).not.toContain(segment)
    expect(message).toContain("HTTP 401")
  } finally {
    proxy.server.close()
  }
}, 15_000)

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
    // The `%3D` on its own: the parameter rule needs a literal `=` or `:`
    // between the name and the value and cannot see this one.
    `pt_token%3D${FAKE_TOKEN}`,
    // An auth proxy quoting the credential in prose, with no parameter at all.
    // This is what the preview edge actually says on a bad token.
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
    "invalid preview token [redacted]",
  )
  // Nothing else is touched.
  expect(redactPreviewToken("HTTP 502 upstream closed")).toBe(
    "HTTP 502 upstream closed",
  )
  expect(
    redactPreviewToken("sandbox sbx-9f2c.preview.getsolari.com refused"),
  ).toBe("sandbox sbx-9f2c.preview.getsolari.com refused")
})

test("the exact token is redacted even in a form no rule anticipated", () => {
  // The generic rules are a net for text handraise never saw the token in.
  // Where it *is* known — the health URL carries it — the credential is
  // matched by value, so a proxy inventing a new way to quote it changes
  // nothing. Two `pt_token` values would be a bug, so the leak is deliberately
  // in a shape neither rule matches: reversed segment order, no parameter.
  const shredded = FAKE_TOKEN.split(".").reverse().join("~")

  expect(redactPreviewToken(`upstream said: ${shredded}`)).toContain(shredded)
  expect(
    redactPreviewToken(`upstream said: ${shredded}`, shredded),
  ).not.toContain(shredded)
  // And the percent-encoded form of the same value, which is what a redirect
  // parameter carries. A base64 token — one with `+`, `/` and `=` in it —
  // does not survive `encodeURIComponent` unchanged, so both forms are needed.
  const padded = "a+b/c=d+e/f=g+h/i=j"
  const encoded = encodeURIComponent(padded)
  expect(redactPreviewToken(`?next=${encoded}`, padded)).not.toContain(encoded)

  // A short value is not a credential, and blanking every occurrence of one
  // would shred the message rather than redact it.
  expect(redactPreviewToken("port 3000 refused", "3000")).toBe(
    "port 3000 refused",
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

// --- The sanitized `cause` ------------------------------------------------
//
// `cause` is documented as the original error with credentials redacted, and
// callers branch on it. Copying it is where fidelity and safety pull against
// each other: too little and the chain is truncated, too much and reading a
// foreign object throws out of a `catch` whose whole job is to produce a coded
// error.

/**
 * A parsed error body that references itself — what an HTTP client that
 * attaches the response object to its error produces.
 */
interface CyclicBody {
  code: string
  self?: CyclicBody
}

/** One link of the `cause` chain, when there is an error at the end of it. */
function causeOf(error: Error): Error | undefined {
  const cause = error.cause
  return cause instanceof Error ? cause : undefined
}

/** A sandbox whose `kill()` always fails with `error`, so `killSandbox` surfaces it. */
function sandboxThatFailsWith(error: Error): Pick<Sandbox, "kill"> {
  return {
    kill: async () => {
      throw error
    },
  }
}

/** The error `run` rejected with; anything else becomes a legible failure. */
async function errorOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run
    return new Error("nothing was thrown")
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error(`not an Error: ${String(error)}`)
  }
}

test("a nested cause survives the copy, redacted", async () => {
  // `new Error(msg, { cause })` installs `cause` as a *non-enumerable* own
  // property, so a copy made by assignment truncates the chain exactly where
  // the root reason lives — undici's `TypeError: fetch failed` is that shape.
  const root = new Error(`connect refused, was using ${FAKE_TOKEN}`)
  const wrapped = new Error(`sandbox teardown failed for ${FAKE_TOKEN}`, {
    cause: root,
  })

  const surfaced = await errorOf(killSandbox(sandboxThatFailsWith(wrapped), 1))

  expect(surfaced.message).toContain("could not destroy the relay sandbox")
  const cause = causeOf(surfaced)
  expect(cause?.message).toContain("sandbox teardown failed")
  expect(cause?.message).not.toContain(FAKE_TOKEN)
  // The link that used to be dropped, and the credential inside it.
  const nested = cause ? causeOf(cause) : undefined
  expect(nested?.message).toContain("connect refused")
  expect(nested?.message).not.toContain(FAKE_TOKEN)
})

test("the copy keeps message and stack out of a JSON payload", async () => {
  // A copy built by assignment makes both own *enumerable*, so a consumer that
  // serialises `cause` into a log payload suddenly ships the whole stack.
  const original = new Error(`teardown failed for ${FAKE_TOKEN}`)

  const surfaced = await errorOf(killSandbox(sandboxThatFailsWith(original), 1))
  const cause = causeOf(surfaced)

  expect(cause).toBeDefined()
  expect(Object.keys(cause ?? {})).not.toContain("message")
  expect(Object.keys(cause ?? {})).not.toContain("stack")
  expect(JSON.stringify(cause)).toBe("{}")
  // …while everything that reads an error properly still works.
  expect(String(cause)).toContain("teardown failed")
  expect(cause?.stack).toBeDefined()
})

test("a cause that cannot be copied is still redacted, never thrown", async () => {
  // Two shapes that make a naive copy throw — and a throw here replaces a
  // coded error with a raw `TypeError`, which is the failure class this whole
  // branch exists to remove.
  const cyclicBody: CyclicBody = { code: "Cyclic" }
  cyclicBody.self = cyclicBody
  const withCyclicBody = new Error(`teardown failed for ${FAKE_TOKEN}`)
  Object.defineProperty(withCyclicBody, "body", {
    value: cyclicBody,
    enumerable: true,
  })

  const cyclic = await errorOf(
    killSandbox(sandboxThatFailsWith(withCyclicBody), 1),
  )
  expect(cyclic.message).toContain("could not destroy the relay sandbox")
  expect(cyclic.message).not.toContain(FAKE_TOKEN)
  expect(causeOf(cyclic)?.message).not.toContain(FAKE_TOKEN)

  // A getter anywhere on the error: reading it is running the caller's code.
  const withThrowingGetter = new Error(`teardown failed for ${FAKE_TOKEN}`)
  Object.defineProperty(withThrowingGetter, "detail", {
    enumerable: true,
    get: (): never => {
      throw new Error("detail is gone")
    },
  })

  const getter = await errorOf(
    killSandbox(sandboxThatFailsWith(withThrowingGetter), 1),
  )
  expect(getter.message).toContain("could not destroy the relay sandbox")
  expect(causeOf(getter)?.message).not.toContain(FAKE_TOKEN)

  // Even the sentence itself can be a getter that throws. There is nothing
  // left to read then, so there is nothing left to leak either.
  const unreadable = new Error("placeholder")
  Object.defineProperty(unreadable, "message", {
    get: (): never => {
      throw new Error("message is gone")
    },
  })

  const opaque = await errorOf(killSandbox(sandboxThatFailsWith(unreadable), 1))
  expect(opaque.message).toContain("could not destroy the relay sandbox")
  expect(causeOf(opaque)).toBeDefined()
})

test("an encoded dot cannot hide the token's shape", () => {
  // Both nets key on the two dots: the pattern needs literal ones, and the
  // exact-value comparison uses `encodeURIComponent`, which leaves a dot
  // alone. A proxy that encodes the whole path — or an HTML error page that
  // escapes it — produces neither form.
  const percent = FAKE_TOKEN.replaceAll(".", "%2E")
  const percentLower = FAKE_TOKEN.replaceAll(".", "%2e")
  const entity = FAKE_TOKEN.replaceAll(".", "&#46;")

  for (const leak of [percent, percentLower, entity]) {
    // Without the exact value: the pattern has to see through the encoding.
    expect(redactPreviewToken(`invalid preview token ${leak}`)).not.toContain(
      leak,
    )
    // And with it, by comparison.
    expect(
      redactPreviewToken(`invalid preview token ${leak}`, FAKE_TOKEN),
    ).not.toContain(leak)
  }

  // The first segment on its own is not three segments, and stays.
  const segment = FAKE_TOKEN.split(".")[0] ?? ""
  expect(redactPreviewToken(`sbx ${segment} up`)).toContain(segment)
})

test("killSandbox redacts the exact token when the caller knows it", async () => {
  // `startRelay` holds the preview URL from the moment the sandbox answers, so
  // every message it builds after that can be redacted by value rather than by
  // grammar — the same belt the health poll wears. The leak below is in a
  // shape no pattern matches, so only the exact value can remove it.
  const shredded = FAKE_TOKEN.split(".").reverse().join("~")
  const teardown = new Error(`host refused, token was ${shredded}`)

  const surfaced = await errorOf(
    killSandbox(sandboxThatFailsWith(teardown), 1, shredded),
  )

  expect(surfaced.message).toContain("could not destroy the relay sandbox")
  expect(surfaced.message).not.toContain(shredded)
  expect(causeOf(surfaced)?.message).not.toContain(shredded)
})

test("relayStartError redacts the exact token in message and cause", () => {
  // The path Sol's finding did not reach: `startRelay`'s catch, which knows
  // the preview URL once the sandbox has answered. Same leak shape, so the
  // patterns cannot help and only the value can.
  const shredded = FAKE_TOKEN.split(".").reverse().join("~")
  const body = { code: "GatewayTimeout", hint: `retry with ${shredded}` }
  const gateway = new GatewayError(504, `upstream ${shredded} gave up`, body)

  const wrapped = relayStartError(gateway, shredded)

  expect(wrapped.code).toBe("relay_start_failed")
  expect(wrapped.message).not.toContain(shredded)
  const cause = causeOf(wrapped)
  expect(cause?.message).not.toContain(shredded)
  expect(
    JSON.stringify(cause instanceof GatewayError ? cause.body : {}),
  ).not.toContain(shredded)
  // Fidelity is unchanged by the extra argument.
  expect(cause).toBeInstanceOf(GatewayError)
  expect(cause instanceof GatewayError ? cause.status : 0).toBe(504)
})
