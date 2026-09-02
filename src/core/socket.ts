/**
 * The agent's side of the relay WebSocket.
 *
 * Three behaviours from docs/measurements/01-preview-transport.md and from the
 * relay integration run, none of them optional:
 *
 * 1. The preview proxy kills a silent WebSocket after exactly 60 s with close
 *    code 1006. A ping every 20 s keeps it warm.
 * 2. 1006 therefore means "reconnect", not "failed". The `agentWsUrl` stays
 *    valid for an hour, so a dropped socket is recovered with backoff for as
 *    long as the handoff is running.
 * 3. The relay answers `ping` itself and does not forward it. A pong proves
 *    the relay is alive; it proves nothing about the human. There is no signal
 *    for "the human closed the tab" — the timeout is the honest answer.
 */
import WebSocket from "ws"

import {
  type AgentToHuman,
  HEARTBEAT_INTERVAL_MS,
  type Heartbeat,
  type HumanToAgent,
  type RelayMessage,
} from "../relay/protocol"

const MAX_BACKOFF_MS = 8_000
const BASE_BACKOFF_MS = 500
const CLOSE_GRACE_MS = 2_000

export interface RelayConnectionOptions {
  /** `wss://…/ws?role=agent&pt_token=…`, exactly as `startRelay()` returned it. */
  url: string
  /** Called for every message the human sends. Never called after `close()`. */
  onMessage: (message: HumanToAgent) => void
  /** Called on every successful connect, including reconnects. */
  onOpen?: () => void
  /** Heartbeat period. Defaults to the protocol's 20 s. */
  heartbeatMs?: number
}

export interface RelayConnection {
  /**
   * Send one message. Resolves when the bytes have been handed to the socket,
   * which is what makes it usable as screencast flow control. Resolves without
   * sending while the socket is down — a stale frame is worth nothing.
   */
  send(message: AgentToHuman | Heartbeat): Promise<void>
  /**
   * Send a terminal message (the `ended` frame), waiting up to the close grace
   * period for a reconnect to finish if the socket is momentarily down. The
   * human's phone hangs on "Reconnecting…" forever if this is dropped, so it is
   * worth the short wait that `send` deliberately refuses for stale frames.
   */
  sendFinal(message: AgentToHuman): Promise<void>
  isOpen(): boolean
  /** Observability counters for the wide event. */
  stats(): RelayConnectionStats
  /** Stop reconnecting and close. Idempotent. */
  close(): Promise<void>
}

export interface RelayConnectionStats {
  /**
   * Times the socket re-opened after the first connect. The preview proxy cuts
   * a silent socket at 60 s (close 1006) and the relay drops an agent when a
   * second one connects; both are recovered here, and both count.
   */
  reconnects: number
}

function toText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8")
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  return Buffer.from(data).toString("utf8")
}

function parse(raw: string): RelayMessage | null {
  try {
    // SAFETY: the relay forwards payloads verbatim and only this library and
    // the relay's own mobile page write to that socket, so every frame on it
    // is a RelayMessage. A payload that is not JSON at all is caught here and
    // dropped; a JSON payload with an unknown `type` falls through the switch
    // in `handle` without being acted on.
    return JSON.parse(raw) as RelayMessage
  } catch {
    return null
  }
}

/** Connect to the relay and keep the connection alive for the whole handoff. */
export function connectRelay(options: RelayConnectionOptions): RelayConnection {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
  let socket: WebSocket | null = null
  let shuttingDown = false
  let attempt = 0
  // Every successful open bumps this; the first is the initial connect, so
  // reconnects are one fewer. Counted on open, not on close, so a drop that
  // never recovers is not miscounted as a reconnect.
  let opens = 0
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let reconnect: ReturnType<typeof setTimeout> | null = null

  const send = (message: AgentToHuman | Heartbeat): Promise<void> =>
    new Promise<void>((resolve) => {
      const live = socket
      if (!live || live.readyState !== WebSocket.OPEN) {
        resolve()
        return
      }
      live.send(JSON.stringify(message), () => resolve())
    })

  const sendFinal = (message: AgentToHuman): Promise<void> =>
    new Promise<void>((resolve) => {
      const trySend = (): boolean => {
        const live = socket
        if (!live || live.readyState !== WebSocket.OPEN) return false
        live.send(JSON.stringify(message), () => resolve())
        return true
      }
      if (trySend()) return
      // The socket is down; the reconnect loop is already working. Poll for it
      // to come back, and give up after the grace period so the caller's
      // cleanup is never blocked.
      const giveUp = setTimeout(() => {
        clearInterval(poll)
        resolve()
      }, CLOSE_GRACE_MS)
      const poll = setInterval(() => {
        if (trySend()) {
          clearInterval(poll)
          clearTimeout(giveUp)
        }
      }, 25)
    })

  const handle = (message: RelayMessage): void => {
    switch (message.type) {
      case "ping":
        void send({ type: "pong" })
        return
      case "tap":
      case "char":
      case "key":
      case "scroll":
      case "handback":
      case "abort":
      case "approve":
      case "deny":
        // Which of these the mode actually acts on is `runHandoff`'s decision,
        // and the relay's before that. This switch only says what may be a
        // human message at all.
        if (!shuttingDown) options.onMessage(message)
        return
      default:
        // pong, and anything the agent never expects to receive.
        return
    }
  }

  const open = (): void => {
    const live = new WebSocket(options.url)
    socket = live

    live.on("open", () => {
      attempt = 0
      opens += 1
      options.onOpen?.()
    })
    live.on("message", (data: WebSocket.RawData) => {
      const message = parse(toText(data))
      if (message) handle(message)
    })
    // An error is always followed by a close, which owns the retry.
    live.on("error", () => undefined)
    live.on("close", () => {
      if (socket === live) socket = null
      if (shuttingDown) return
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
      attempt += 1
      reconnect = setTimeout(open, backoff + Math.random() * 250)
    })
  }

  open()
  heartbeat = setInterval(() => void send({ type: "ping" }), heartbeatMs)

  return {
    send,
    sendFinal,
    isOpen: () => socket?.readyState === WebSocket.OPEN,
    stats: () => ({ reconnects: Math.max(0, opens - 1) }),
    close() {
      shuttingDown = true
      if (heartbeat) clearInterval(heartbeat)
      if (reconnect) clearTimeout(reconnect)
      heartbeat = null
      reconnect = null
      const live = socket
      socket = null
      if (!live) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const giveUp = setTimeout(() => {
          live.terminate()
          resolve()
        }, CLOSE_GRACE_MS)
        live.once("close", () => {
          clearTimeout(giveUp)
          resolve()
        })
        live.close()
      })
    },
  }
}
