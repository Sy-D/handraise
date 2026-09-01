/**
 * The scripted human.
 *
 * It connects to the handoff exactly the way a phone does — same URL, same
 * `role=human` WebSocket, same message types — so the e2e exercises the whole
 * path including the relay and the coordinate space, instead of calling into
 * handraise's own modules and proving nothing.
 *
 * The one thing it does not simulate is the browser: the real page decodes the
 * JPEG and reports taps in frame pixels, and here the caller computes those
 * pixels itself. That is the deliberate seam.
 */
import WebSocket from "ws"

import {
  type AgentToHuman,
  type FrameMeta,
  HEARTBEAT_INTERVAL_MS,
  type HumanToAgent,
} from "../src/relay/protocol"

export interface ReceivedFrame {
  /** Base64 JPEG, exactly as CDP produced it. */
  data: string
  meta: FrameMeta
}

export interface SimulatedHuman {
  /** The newest frame, or `null` before the first one. */
  lastFrame(): ReceivedFrame | null
  frameCount(): number
  /** The `reason` currently shown in the header. */
  reason(): string
  /** How the agent said the handoff ended, if it has. */
  ending(): "resolved" | "aborted" | "timeout" | "disconnected" | null
  waitForFrame(timeoutMs?: number): Promise<ReceivedFrame>
  tap(fx: number, fy: number): Promise<void>
  /** Type one character per message, the way the mobile UI does. */
  type(text: string, delayMs?: number): Promise<void>
  press(key: "Enter" | "Backspace" | "Tab"): Promise<void>
  scroll(fdy: number): Promise<void>
  handback(): Promise<void>
  abort(): Promise<void>
  close(): Promise<void>
}

/**
 * Turn the page URL into the WebSocket URL.
 *
 * `new URL("/ws", humanUrl)` would drop `?pt_token=` and earn a 401. A real
 * phone does not need the token here because loading the page granted it a
 * cookie; a Node client has no cookie jar, so it keeps the token.
 */
export function humanWebSocketUrl(humanUrl: string): string {
  const url = new URL(humanUrl)
  url.pathname = "/ws"
  url.searchParams.set("role", "human")
  return url.toString().replace(/^http/, "ws")
}

function parse(raw: string): AgentToHuman | { type: "pong" } | null {
  try {
    // SAFETY: the only writer on this socket is handraise itself, and the
    // relay forwards payloads verbatim. Anything unrecognised falls through
    // the checks below without being acted on.
    return JSON.parse(raw) as AgentToHuman
  } catch {
    return null
  }
}

/**
 * Load the handoff page (asserting it is reachable), then open the human
 * WebSocket and start listening.
 */
export async function openHandoffPage(
  humanUrl: string,
): Promise<SimulatedHuman> {
  const page = await fetch(humanUrl, { cache: "no-store" })
  if (!page.ok) {
    throw new Error(`the handoff page answered ${page.status}, not 200`)
  }
  await page.text()

  const socket = new WebSocket(humanWebSocketUrl(humanUrl))
  let frame: ReceivedFrame | null = null
  let frames = 0
  let reason = ""
  let ending: "resolved" | "aborted" | "timeout" | "disconnected" | null = null
  const waiters: (() => void)[] = []

  socket.on("message", (data: Buffer) => {
    const message = parse(data.toString("utf8"))
    if (!message) return
    if (message.type === "frame") {
      frame = { data: message.data, meta: message.meta }
      frames += 1
      while (waiters.length > 0) waiters.pop()?.()
      return
    }
    if (message.type === "state") reason = message.reason
    if (message.type === "ended") ending = message.outcome
  })

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })

  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ping" }))
    }
  }, HEARTBEAT_INTERVAL_MS)

  const send = (message: HumanToAgent): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => {
        if (error) reject(error)
        else resolve()
      })
    })

  return {
    lastFrame: () => frame,
    frameCount: () => frames,
    reason: () => reason,
    ending: () => ending,

    async waitForFrame(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      while (!frame) {
        if (Date.now() > deadline) {
          throw new Error(`no screencast frame within ${timeoutMs}ms`)
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100)
          waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      return frame
    },

    tap: (fx, fy) => send({ type: "tap", fx, fy }),

    async type(text, delayMs = 60) {
      for (const ch of text) {
        await send({ type: "char", ch })
        if (delayMs > 0) await Bun.sleep(delayMs)
      }
    },

    press: (key) => send({ type: "key", key }),
    scroll: (fdy) => send({ type: "scroll", fdy }),
    handback: () => send({ type: "handback" }),
    abort: () => send({ type: "abort" }),

    close() {
      clearInterval(heartbeat)
      return new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        const giveUp = setTimeout(() => {
          socket.terminate()
          resolve()
        }, 2000)
        socket.once("close", () => {
          clearTimeout(giveUp)
          resolve()
        })
        socket.close()
      })
    },
  }
}
