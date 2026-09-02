/**
 * handraise in-guest relay — the only thing that runs inside the Solari sandbox.
 *
 * SOURCE OF TRUTH. `scripts/embed-guest.ts` inlines this file verbatim into
 * `src/relay/guest-source.ts`; never edit the generated copy.
 *
 * Constraints that shape every line below:
 *   - Node v18.20.4, template `base`, ZERO dependencies (see docs/measurements/01-preview-transport.md).
 *   - One port for everything. Each preview port is its own subdomain with its
 *     own token and its own cookie grant, so a second port would double the
 *     auth surface for no gain.
 *   - The preview proxy kills a silent WebSocket after exactly 60s (close 1006),
 *     hence the 20s server-side ping below and the client's own 20s heartbeat.
 *
 * Routing contract (src/relay/protocol.ts): everything an agent sends goes to
 * the human and vice versa, byte for byte. The exceptions are answering
 * `{"type":"ping"}` with `{"type":"pong"}`, keeping the last `frame`/`state` so
 * a human who joins late sees something instantly, and the mode: this process
 * is started as a takeover relay or an approval relay and routes only the human
 * messages that mode has. A hidden button is not a restriction — the human's
 * socket is reachable from any HTTP client.
 */
import { createHash } from "node:crypto"
import { createServer } from "node:http"

const PORT = Number(process.argv[2] || process.env.HANDRAISE_RELAY_PORT || 3000)

/**
 * Secret that a role=agent connection must present as `?k=`. `startRelay()`
 * mints it and appends it to `agentWsUrl` only — never to the human's link —
 * so possession of the handoff URL does not let a stranger claim the agent
 * side and read the human's keystrokes. Empty (no argv) disables the check for
 * local tests; the real deploy always sets one.
 */
const AGENT_KEY = process.argv[3] || process.env.HANDRAISE_AGENT_KEY || ""

/**
 * Every message type on the wire, in both directions, named once.
 *
 * This file is plain JavaScript, so comparing a message against a bare quoted
 * string is unchecked: a typo is not a compile error, it is a message that is
 * silently never matched. The literal unions in src/relay/protocol.ts do that
 * work for the rest of the codebase; these constants are their counterpart
 * here, and `relay.test.ts` asserts the two sets against each other so neither
 * can grow a member alone.
 *
 * The mobile page below gets this same object injected at serve time — one
 * definition for the relay and the page it serves, never two that can drift.
 */
const MSG = {
  // agent -> human
  FRAME: "frame",
  STATE: "state",
  FOCUS: "focus",
  LINKS: "links",
  ENDED: "ended",
  // human -> agent
  TAP: "tap",
  SCANQR: "scanqr",
  CHAR: "char",
  KEY: "key",
  CLEAR: "clear",
  SCROLL: "scroll",
  HANDBACK: "handback",
  ABORT: "abort",
  APPROVE: "approve",
  DENY: "deny",
  // either direction
  PING: "ping",
  PONG: "pong",
}

/** The two things a handoff can ask of a human. */
const MODE = { TAKEOVER: "takeover", APPROVAL: "approval" }

/**
 * The URL schemes the page may offer an "Open" button for, from a QR code the
 * agent read off whatever site it got stuck on.
 *
 * Three. `tel:` and `otpauth:` are deliberately not here: opening one hands a
 * dialler a string that can be a control sequence, and opening the other
 * enrols an attacker-chosen secret in an authenticator. Both are shown and
 * copyable with a label that says what they are.
 *
 * The agent classifies each link before it sends it, and the page checks the
 * scheme again against this list. Both locks are needed: the human's link is a
 * bearer URL and the socket behind it is reachable from any HTTP client, so
 * `kind: "url"` is a hint the page must not have to trust. Asserted equal to
 * `OPENABLE_SCHEMES` in src/core/qr-scan.ts by relay.test.ts.
 */
const OPENABLE_SCHEMES = ["http:", "https:", "mailto:"]

/**
 * What this handoff asks of the human: `takeover` (drive the page) or
 * `approval` (answer one question about one screenshot). It arrives as argv
 * and never as a message, so no client can talk the relay into the other set.
 */
const HANDOFF_MODE =
  (process.argv[4] || process.env.HANDRAISE_MODE) === MODE.APPROVAL
    ? MODE.APPROVAL
    : MODE.TAKEOVER

/** The human messages this relay forwards. Everything else from that side is dropped. */
const HUMAN_MESSAGES = new Set(
  HANDOFF_MODE === MODE.APPROVAL
    ? [MSG.APPROVE, MSG.DENY]
    : [
        MSG.TAP,
        MSG.CHAR,
        MSG.KEY,
        MSG.CLEAR,
        MSG.SCROLL,
        MSG.SCANQR,
        MSG.HANDBACK,
        MSG.ABORT,
      ],
)

/**
 * The human messages that end a handoff, in either mode. They are held for an
 * agent that is not connected at the moment, and they stop the frame replay.
 */
const TERMINAL_HUMAN = new Set([MSG.HANDBACK, MSG.ABORT, MSG.APPROVE, MSG.DENY])

/** Must equal HEARTBEAT_INTERVAL_MS in src/relay/protocol.ts (asserted in relay.test.ts). */
const HEARTBEAT_INTERVAL_MS = 20000

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** A screencast frame is ~12-65 KB of base64; anything past this is a bug or an attack. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

/**
 * The ceiling for a message from the human, which is a different number
 * entirely.
 *
 * Every message this side may send is a handful of fields — a tap is two
 * integers, the longest is one character of text — so four kilobytes is
 * already a thousandfold of what any of them needs. The agent's frames are the
 * reason the cap above is megabytes; a bearer-link holder padding an accepted
 * `scanqr` to eight of them is the reason this one is not. Enforced in the
 * reader, before anything is parsed.
 */
const MAX_HUMAN_MESSAGE_BYTES = 4 * 1024

/**
 * The relay's own floor between two scans, in milliseconds.
 *
 * The core enforces this too and its copy is the one that protects the
 * browser. This one protects the relay and the agent's socket: a burst of
 * accepted `scanqr` objects still costs a forward, a parse on the other side
 * and a wake-up each, and none of that is the core's to refuse.
 */
const SCAN_INTERVAL_MS = 2000

/** Grace before a replaced/closed socket is force-destroyed if it hangs on. */
const CLOSE_GRACE_MS = 1000

const PONG = JSON.stringify({ type: MSG.PONG })

/** role -> peer. At most one connection per role; a new one replaces the old. */
const peers = new Map()

/** Replay buffer for a human who joins (or rejoins) after the agent started. */
let lastState = null
let lastFrame = null
/**
 * The newest `focus`. The agent only sends this on change, so a human who
 * reconnects mid-handoff would otherwise show no focus ring until the human
 * next touched something.
 */
let lastFocus = null
/** The terminal `ended` message, once the agent has sent it. */
let lastEnded = null
/**
 * A terminal human message (handback/abort/approve/deny) held for an agent that
 * is not connected at the moment — typically mid-reconnect. Delivered to the
 * next role=agent so the handoff resolves instead of falsely timing out with no
 * storageState. Symmetric to the lastFrame replay for a late human.
 */
let pendingForAgent = null

/**
 * Set by the first terminal human message, and never cleared.
 *
 * The handoff link is a bearer URL and may be in two hands at once. Without
 * this, a second holder could overwrite a queued `deny` with an `approve`
 * before the agent reconnected to collect it — the answer the agent acts on
 * would be the last one sent rather than the first one given. It also stops a
 * reconnecting agent from refilling the replay buffers this relay has just
 * scrubbed, because the agent does not yet know it has been answered.
 */
let humanEnded = false

/** When the relay last forwarded a `scanqr`. See SCAN_INTERVAL_MS. */
let lastScanAt = 0

/**
 * Forget everything that shows the remote page. Not the ending, which a late
 * human still has to be told, and not a human answer still waiting for its
 * agent.
 */
function forgetPage() {
  lastFrame = null
  lastState = null
  lastFocus = null
}

function encodeFrame(payload, opcode) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const length = body.length
  let head
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(length, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([head, body])
}

/**
 * Incremental RFC6455 reader. Handles masking, all three length forms, control
 * frames and fragmentation (browsers do not fragment, but proxies may).
 * `onMessage(payload, opcode)` fires once per complete application message.
 */
function createReader(onMessage, onPing, onClose, maxBytes) {
  let buffered = Buffer.alloc(0)
  let fragments = []
  let fragmentBytes = 0
  let fragmentOpcode = OP_TEXT
  return (chunk) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
    for (;;) {
      if (buffered.length < 2) return
      const first = buffered[0]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (buffered[1] & 0x80) !== 0
      let length = buffered[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffered.length < 4) return
        length = buffered.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffered.length < 10) return
        length = Number(buffered.readBigUInt64BE(2))
        offset = 10
      }
      if (length > maxBytes) {
        onClose()
        return
      }
      const mask = masked ? buffered.subarray(offset, offset + 4) : null
      if (masked) offset += 4
      if (buffered.length < offset + length) return
      const payload = Buffer.from(buffered.subarray(offset, offset + length))
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      }
      buffered = buffered.subarray(offset + length)

      if (opcode === OP_CLOSE) {
        onClose()
        return
      }
      if (opcode === OP_PING) {
        onPing(payload)
        continue
      }
      if (opcode === OP_PONG) continue

      if (opcode === OP_CONTINUATION) {
        fragments.push(payload)
        fragmentBytes += payload.length
      } else {
        fragments = [payload]
        fragmentBytes = payload.length
        fragmentOpcode = opcode
      }
      // Per-frame length is capped above, but a stream of small continuation
      // frames that never sets fin would grow `fragments` without bound (60 MB
      // reassembled to 148 MB, verified). Cap the running sum too.
      if (fragmentBytes > maxBytes) {
        onClose()
        return
      }
      if (!fin) continue
      const complete =
        fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
      fragments = []
      fragmentBytes = 0
      onMessage(complete, fragmentOpcode)
    }
  }
}

function write(peer, payload, opcode) {
  if (!peer?.open) return
  // A false return means the kernel send buffer is full. Track it so `route`
  // can drop frames to a slow receiver instead of letting Node's write queue
  // grow without bound in this sandbox's memory. Cleared on the drain event.
  peer.backpressure = !peer.socket.write(encodeFrame(payload, opcode))
}

function sendText(peer, text) {
  write(peer, Buffer.from(text, "utf8"), OP_TEXT)
}

function closePeer(peer, reason) {
  if (!peer.open) return
  peer.open = false
  if (peers.get(peer.role) === peer) peers.delete(peer.role)
  // An agent that is gone may never come back — a timeout during a socket
  // outage, a killed process, a `kill()` that failed — and its last frame is
  // the logged-in page. `ended` is not guaranteed to arrive (the agent gives
  // up on it after two seconds), so the scrub cannot wait for it. A handoff
  // that is still running restores this by itself: every agent reconnect
  // re-sends its state, and in approval mode its screenshot.
  if (peer.role === "agent") {
    forgetPage()
    // An agent that is gone will never drain, so its backpressure must not be
    // what keeps the human muted: the handback they are about to send has to
    // be read, held, and given to whichever agent connects next.
    resumeHuman()
  }
  // Detach the reader so a replaced client that ignores the close frame can no
  // longer feed route(); a lingering listener is how a peer keeps injecting.
  if (peer.read) peer.socket.removeListener("data", peer.read)
  try {
    peer.socket.write(encodeFrame(Buffer.alloc(0), OP_CLOSE))
  } catch {
    // the socket is already gone; nothing left to say on it
  }
  peer.socket.end()
  // Force the socket down if the client hangs on past the close frame.
  const socket = peer.socket
  setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref?.()
  log("peer closed", { role: peer.role, reason })
}

/** The host of an Origin header, or null if it is missing or unparseable. */
function originHost(origin) {
  try {
    return new URL(origin).host
  } catch {
    return null
  }
}

/** `{"type":"…"}` or null. Never throws: the router must survive garbage. */
function messageType(payload) {
  let value
  try {
    value = JSON.parse(payload.toString("utf8"))
  } catch {
    return null
  }
  if (value === null || Array.isArray(value)) return null
  const type = value.type
  return type === undefined ? null : type
}

/** Keep what a human who joins late has to be shown, and drop what they must not. */
function rememberFromAgent(type, payload) {
  if (type === MSG.ENDED) {
    // Terminal: keep the ending for a late human, drop everything that could
    // show the logged-in page to whoever opens the link next.
    lastEnded = payload
    forgetPage()
    pendingForAgent = null
    return
  }
  // The agent goes on sending until it learns it has been answered — it
  // re-sends state, and in approval mode the screenshot, on every reconnect.
  // Forwarding that is harmless; storing it would put the page back in front
  // of the next visitor after this relay decided to drop it.
  if (humanEnded) return
  if (type === MSG.FRAME) lastFrame = payload
  else if (type === MSG.STATE) lastState = payload
  else if (type === MSG.FOCUS) lastFocus = payload
}

/** One line per relay at most: a hostile client must not be able to fill the log. */
let dropLogged = false

function logDrop(type) {
  if (dropLogged) return
  dropLogged = true
  log("human message dropped", {
    type: String(type).slice(0, 32),
    mode: HANDOFF_MODE,
    ended: humanEnded,
  })
}

/**
 * Whether a human message may be forwarded at all, and the bookkeeping the
 * terminal ones need. Two rules meet here, and neither is the phone's to
 * enforce: the mode's vocabulary — a `tap` on an approval relay dies here, not
 * on the page that never offered it — and first answer wins.
 */
function acceptFromHuman(type, payload) {
  if (humanEnded || !HUMAN_MESSAGES.has(type)) {
    logDrop(type)
    return false
  }
  // The scan floor, enforced here as well as in the core. The core's copy is
  // what protects the browser from a screenshot loop; this one keeps a burst of
  // accepted scans from costing a forward, a wake-up and a JSON parse on the
  // agent's side for each one. Dropped, never queued: a scan is only worth
  // anything against the page as it is now.
  if (type === MSG.SCANQR) {
    const now = Date.now()
    if (now - lastScanAt < SCAN_INTERVAL_MS) {
      logDrop(type)
      return false
    }
    lastScanAt = now
  }
  if (TERMINAL_HUMAN.has(type)) {
    // The human is done, for good. Buffer this for an agent that is
    // mid-reconnect, and stop replaying the last (logged-in) frame.
    humanEnded = true
    pendingForAgent = payload
    forgetPage()
  }
  return true
}

function route(peer, payload, opcode) {
  // A peer that has been closed or replaced (its role now points at a newer
  // socket) must not route anything, even if its reader fires one more time.
  if (!peer.open || peers.get(peer.role) !== peer) return
  const other = peers.get(peer.role === "agent" ? "human" : "agent")
  if (opcode !== OP_TEXT) {
    // The human's whole vocabulary is JSON text; binary from that side is not
    // in it. The agent's frames are text too, but it owns the channel.
    if (peer.role === "human") return
    write(other, payload, opcode)
    return
  }
  const type = messageType(payload)
  if (type === MSG.PING) {
    sendText(peer, PONG)
    return
  }
  if (peer.role === "agent") rememberFromAgent(type, payload)
  else if (!acceptFromHuman(type, payload)) return
  // Newest frame wins: drop a frame bound for a backpressured receiver rather
  // than queue it in memory. Control and terminal messages are never dropped.
  if (type === MSG.FRAME && other?.backpressure) return
  write(other, payload, opcode)
  // The human is producing faster than the agent's socket can take it. Stop
  // reading that socket rather than growing this process's write queue with
  // input nobody has asked for yet: TCP holds it, and the agent's `drain`
  // starts it again.
  //
  // What this does and does not promise. The message just written is not held
  // back, so the one that triggered the pause is delivered. Anything already
  // behind it in the human's socket buffer — a handback among them — is *not
  // lost but is delayed*, until the agent drains or goes away; `closePeer`
  // resumes the human for the second case, so a dead agent cannot mute one
  // forever. Separating terminal messages out would mean parsing before the
  // flow-control decision, which is the work the 4 KiB cap exists to avoid.
  if (peer.role === "human" && other?.backpressure) holdHuman(peer)
}

/**
 * Stop reading a human socket until the agent's has drained.
 *
 * Not a drop. Everything already read has been routed, and everything still in
 * flight is where TCP is best at holding it. `resumeHuman` runs on the agent's
 * `drain` and again when the agent goes away entirely, so a human is never
 * left muted by a peer that is not coming back.
 */
function holdHuman(peer) {
  if (peer.paused) return
  peer.paused = true
  peer.socket.pause()
  log("human paused", { reason: "agent backpressure" })
}

function resumeHuman() {
  const human = peers.get("human")
  if (!human?.paused) return
  human.paused = false
  human.socket.resume()
  log("human resumed", {})
}

function log(event, detail) {
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      event,
      agent: peers.has("agent"),
      human: peers.has("human"),
      ...detail,
    }),
  )
}

/**
 * The mobile page, with this relay's two facts substituted in: which mode it
 * is serving, and the wire vocabulary. The page never spells a message type
 * itself — it reads `MSG` out of the same object the router above uses, so a
 * type that is renamed in one place cannot survive in the other.
 */
function renderPage() {
  // Function replacements, so a `$&` or a `$'` in a substituted value stays a
  // literal instead of becoming a back-reference that rewrites the page.
  const vocabulary = JSON.stringify({
    msg: MSG,
    mode: MODE,
    schemes: OPENABLE_SCHEMES,
  })
  return PAGE.replace("__HANDRAISE_MODE__", () => HANDOFF_MODE).replace(
    "__HANDRAISE_VOCAB__",
    () => vocabulary,
  )
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://relay")
  if (url.pathname === "/healthz") {
    res.writeHead(200, {
      "content-type": "text/plain",
      "cache-control": "no-store",
    })
    res.end("ok")
    return
  }
  if (url.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    })
    // HANDOFF_MODE is one of two literals, so this substitution can only
    // produce the two pages this file was written for.
    res.end(renderPage())
    return
  }
  res.writeHead(404, {
    "content-type": "text/plain",
    "cache-control": "no-store",
  })
  res.end("not found")
})

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://relay")
  const role = url.searchParams.get("role")
  const key = req.headers["sec-websocket-key"]
  if (
    url.pathname !== "/ws" ||
    (role !== "agent" && role !== "human") ||
    !key
  ) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
    socket.destroy()
    return
  }

  // The role is a claim. The agent side reads the human's OTP and password
  // keystrokes and can eject the real agent, so only a client holding the
  // secret from `agentWsUrl` may take it. `role=human` needs no secret.
  if (
    role === "agent" &&
    AGENT_KEY &&
    url.searchParams.get("k") !== AGENT_KEY
  ) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
    socket.destroy()
    return
  }
  // A non-browser agent client sends no Origin; the phone's browser sends the
  // sandbox's own origin. A present but foreign Origin is a cross-site page
  // trying to ride the preview cookie — refuse it.
  const origin = req.headers.origin
  if (origin && originHost(origin) !== req.headers.host) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
    socket.destroy()
    return
  }

  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64")
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.setNoDelay(true)

  const previous = peers.get(role)
  if (previous) closePeer(previous, "replaced")

  const peer = {
    role,
    socket,
    open: true,
    backpressure: false,
    // Human only: set while its socket is held for a backpressured agent.
    paused: false,
  }
  peers.set(role, peer)
  log("peer connected", { role })

  const read = createReader(
    (payload, opcode) => route(peer, payload, opcode),
    (payload) => write(peer, payload, OP_PONG),
    () => closePeer(peer, "peer closed the socket"),
    role === "human" ? MAX_HUMAN_MESSAGE_BYTES : MAX_MESSAGE_BYTES,
  )
  peer.read = read
  if (head?.length) read(head)
  socket.on("data", read)
  socket.on("drain", () => {
    peer.backpressure = false
    // The agent can take input again, so the human may speak again.
    if (peer.role === "agent") resumeHuman()
  })
  socket.on("error", () => closePeer(peer, "socket error"))
  socket.on("close", () => closePeer(peer, "socket closed"))

  // A late human sees the ending if the handoff is over, otherwise the last
  // state and frame so the canvas is not blank until the next repaint.
  if (role === "human") {
    if (lastEnded) write(peer, lastEnded, OP_TEXT)
    else {
      if (lastState) write(peer, lastState, OP_TEXT)
      if (lastFrame) write(peer, lastFrame, OP_TEXT)
      // After the frame: the page positions the ring against the frame it has.
      if (lastFocus) write(peer, lastFocus, OP_TEXT)
    }
  }

  // A reconnecting agent that missed the human's handback/abort while it was
  // away gets it now, so the handoff resolves instead of falsely timing out.
  if (role === "agent" && pendingForAgent) {
    write(peer, pendingForAgent, OP_TEXT)
    pendingForAgent = null
  }
})

// Keeps every hop between the phone, the preview proxy and this process warm.
// A silent socket is dead at 60s, and a human reading a code off another device
// is exactly the situation where nothing is sent for a minute.
setInterval(() => {
  for (const peer of peers.values()) write(peer, Buffer.alloc(0), OP_PING)
}, HEARTBEAT_INTERVAL_MS)

server.listen(PORT, "0.0.0.0", () => {
  // Report the bound port, not the requested one: port 0 asks the OS to pick a
  // free one, which is how the local test suite avoids fighting for 3000.
  const bound = server.address()
  log("relay listening", { port: bound?.port ?? PORT, mode: HANDOFF_MODE })
})

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!-- interactive-widget=resizes-content: Chrome Android otherwise leaves the
     layout viewport alone when the keyboard opens and the footer - field, keys,
     both buttons - ends up underneath it. maximum-scale=1 is gone with it: it
     is a WCAG 1.4.4 failure that iOS has ignored since iOS 10, so it only ever
     penalised Android. -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>handraise</title>
<style>
  /* cmpinf.com's dark palette: monochrome at chroma 0 throughout. The one
     colour in the interface is the destructive red, and it is now spent only
     on the give-up hold while a finger is on it — never at rest, where it used
     to make "I won't" the loudest thing on the screen. oklch has shipped in
     every mobile browser that can run this page since 2023.

     The surface, line and field steps are lifted from the original 0.145 /
     0.24 / 0.26: header, stage and footer measured 1.04:1 against each other
     and read as one continuous black rectangle, and the control borders at
     1.28:1 made the key bar a row of ghosts. */
  :root {
    --bg: oklch(0.11 0 0);
    --surface: oklch(0.205 0 0);
    --line: oklch(0.30 0 0);
    --field: oklch(0.36 0 0);
    --text: oklch(0.985 0 0);
    --muted: oklch(0.68 0 0);
    --danger: oklch(0.65 0.2 25);
    --radius: 0.625rem;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.4;
    overscroll-behavior: none;
  }
  /* dvh, not vh: paired with interactive-widget above it is what keeps the
     bottom bar above the Android soft keyboard. 100% stays as the fallback. */
  @supports (height: 100dvh) {
    html, body { height: 100dvh; }
  }
  /* No insets here. They belong to the boxes that actually touch the screen
     edges; applied on body as well, a notched iPhone got 34 + 10 + 34 = 78px
     of footer padding out of a screen whose canvas is already starved. */
  body {
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: calc(12px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 12px calc(16px + env(safe-area-inset-left));
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }
  .dot {
    position: relative;
    flex: none;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--text);
    /* Optically centred on the first line of the header copy. */
    margin-top: 4px;
  }
  .dot::after {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 1px solid currentColor;
    color: var(--text);
    opacity: 0;
  }
  /* Motion marks change, not permanence. The live state lasts the whole
     session, so a pulse there signals nothing while animating in the corner of
     a screen someone is reading a password onto. Only waiting pulses, because
     waiting is the state where the human needs to know something is trying. */
  .dot.waiting { background: var(--muted); }
  .dot.waiting::after { color: var(--muted); animation: pulse .9s ease-out infinite; }
  .dot.dead { background: var(--danger); }
  @keyframes pulse {
    0% { transform: scale(.6); opacity: .9; }
    100% { transform: scale(1.6); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot::after { animation: none; }
  }
  /* A stranger scans a QR code and lands on a dark page that asks for a
     two-factor code. That is the shape of a phishing page, so the page says
     what it is before it asks for anything. */
  .head-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .eyebrow {
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .eyebrow .mark { color: var(--text); font-weight: 600; }
  /* The reason is the only sentence that tells the human why they are here, so
     it gets two lines. Truncation is right for a label and wrong for the
     primary explanation. */
  #reason {
    min-width: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  main {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px calc(10px + env(safe-area-inset-right)) 10px calc(10px + env(safe-area-inset-left));
  }
  /* Two boxes, and both are load-bearing.

     #frame is never transformed, so its getBoundingClientRect() is the honest
     layout size even while a zoom is mid-animation — everything the letterbox
     maths needs. It also does the clipping, at the stage's content edge.

     #zoom carries the transform. transform-origin: 0 0 is what makes the
     inverse in toFrame() one subtraction and one division: a canvas-local
     point l lands at l * scale + t, and nothing else moves. */
  #frame {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: var(--radius);
  }
  #zoom {
    position: absolute;
    inset: 0;
    transform-origin: 0 0;
    will-change: transform;
  }
  /* Only the eased moves animate: a pinch follows the fingers with no lag at
     all, and the auto-zoom is the one place where movement explains something
     (this is the field you are typing into, and here is where it went). */
  #zoom[data-eased] {
    transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  canvas {
    width: 100%;
    height: 100%;
    touch-action: none;
    display: block;
  }
  #placeholder {
    position: absolute;
    color: var(--muted);
    font-size: 14px;
    pointer-events: none;
  }
  /* The remote page is letterboxed to about a third of its size, so a focus
     outline or a pressed button over there is invisible here. Without a local
     acknowledgement the human taps again — a double submit on a login form.
     Lives in #stage, never on the canvas: every frame repaints the canvas. */
  .tapmark {
    position: absolute;
    width: 28px;
    height: 28px;
    margin: -14px 0 0 -14px;
    border: 2px solid var(--text);
    border-radius: 50%;
    pointer-events: none;
    animation: tapmark 300ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
  }
  /* From 0.4 and not from 0: nothing in the real world appears from nothing. */
  @keyframes tapmark {
    0% { transform: scale(.4); opacity: .9; }
    100% { transform: scale(1.6); opacity: 0; }
  }
  @keyframes tapmark-fade {
    0% { opacity: .9; }
    100% { opacity: 0; }
  }
  /* The ring around the focused remote field. A sibling of the canvas, never
     drawn on it: every frame repaints the canvas and would wipe it out.
     pointer-events: none keeps taps going to the canvas underneath. */
  /* Inside #zoom, so the ring scales and pans with the frame it points at for
     free — one transform instead of a second set of maths that can disagree
     with the first. Its stroke divides the zoom back out: a 2px ring is a 2px
     ring at 3x, not a 6px slab over the field it is meant to outline. */
  #focus-ring {
    position: absolute;
    pointer-events: none;
    border: calc(2px / var(--zoom, 1)) solid var(--text);
    /* Most login pages are light, and a near-white ring on a white form is
       invisible. The 1px dark keyline outside it is not decoration: it is what
       makes the ring readable on a page whose colours we do not control. */
    outline-width: calc(1px / var(--zoom, 1));
    outline-style: solid;
    outline-color: var(--bg);
    border-radius: calc(2px / var(--zoom, 1));
    transition: left .12s ease, top .12s ease, width .12s ease, height .12s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    #focus-ring { transition: none; }
    /* The zoom still happens — it is the only way the page can be read at all.
       It just arrives instead of travelling. */
    #zoom[data-eased] { transition: none; }
    /* The acknowledgement is the point, the ripple is not: keep the dot, drop
       the movement. */
    .tapmark { animation: tapmark-fade 200ms linear forwards; }
  }
  footer {
    border-top: 1px solid var(--line);
    background: var(--surface);
    padding: 10px calc(16px + env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left));
  }
  /* At 320px the field and the key bar are fighting over 288px. Give the row
     its 8px back rather than let the field shrink out of usefulness. */
  @media (max-width: 360px) {
    header, footer {
      padding-right: calc(12px + env(safe-area-inset-right));
      padding-left: calc(12px + env(safe-area-inset-left));
    }
  }
  /* The field owns its own row, the keys sit underneath it on theirs. Sharing
     one line left the field 69px at 320px — about four visible characters,
     which is fine for a six-digit code and useless for an email address. The
     footer costs ~52px more; the stage was wasting 414 of them. */
  .bar { display: flex; flex-direction: column; gap: 8px; }
  input {
    width: 100%;
    min-width: 0;
    padding: 12px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--field);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 16px;
  }
  input:focus { outline: none; border-color: oklch(0.44 0 0); }
  .keys { display: flex; gap: 6px; }
  /* 44 x 44 is the floor, not the target. With a row to themselves the three
     safe keys take a third of it each — 70px at 320px — because these four
     buttons exist precisely because a phone's soft keyboard is unreliable, so
     they have to be the most reliable controls on the page. Muted weight so the
     bar does not compete with the hand-back button below it. */
  .key {
    flex: 1 1 0;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: 1px solid var(--field);
    background: transparent;
    color: var(--muted);
    font-weight: 500;
    font-size: 16px;
    line-height: 1;
  }
  /* Ordered by consequence. Backspace, Next and Enter each cost one character
     or one step and sit together in typing order; clear destroys the whole
     field with no undo, so it is a word rather than a glyph a stranger has to
     guess at, and it sits behind a gutter the thumb has to reach for. A missed
     backspace can no longer empty the field.

     Scan QR is past the gutter with it — not because it is destructive, but
     because it is not a key. It asks the agent a question about the page
     instead of typing into it, and the three glyphs keep their own group. */
  #key-clear, #key-qr {
    flex: 0 0 auto;
    min-width: 44px;
    padding: 0 8px;
    font-size: 13px;
  }
  #key-clear { margin-left: 18px; }
  .key:active:not(:disabled) {
    color: var(--text);
    border-color: oklch(0.44 0 0);
    background: oklch(0.26 0 0 / 0.4);
  }
  /* .38 put the glyph at 1.91:1 against the surface — effectively not there.
     .62 is 3.17:1, so a disabled control still reads as a control. */
  .key:disabled { opacity: .62; cursor: default; }
  .hint {
    margin: 7px 2px 10px;
    color: var(--muted);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row { display: flex; align-items: center; gap: 10px; }
  button {
    font: inherit;
    font-weight: 600;
    border-radius: var(--radius);
    cursor: pointer;
    /* Press feedback that is felt even under the thumb covering the button. */
    transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  .primary:active, .ghost:active { transform: scale(0.97); }
  /* Inverted, the way shadcn's dark primary is: near-white on near-black. */
  .primary {
    flex: 1 1 auto;
    /* A transparent border, not none: .ghost carries a real 1px one, and two
       buttons in a row whose boxes differ by 2px is the kind of thing nobody
       consciously sees and everybody feels. nowrap because the label wrapped
       to two lines at 320px and took the row's height with it. */
    border: 1px solid transparent;
    padding: 13px 16px;
    background: var(--text);
    color: oklch(0.205 0 0);
    letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .primary:active { background: oklch(0.9 0 0); }
  /* This button used to hold the only colour in the interface, which made "I
     won't" the loudest thing on a screen whose job is asking for help. It is
     monochrome at rest; the red exists only as the hold's progress. */
  .ghost {
    position: relative;
    flex: none;
    overflow: hidden;
    padding: 13px 14px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--muted);
    font-weight: 500;
    white-space: nowrap;
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  /* Hold-to-give-up: the fill is the confirmation. Deliberate on press
     (linear, so it reads as elapsed time), snappy on release. scaleX and not
     width, so the progress never leaves the compositor. */
  .ghost::before {
    content: "";
    position: absolute;
    inset: 0;
    background: oklch(0.65 0.2 25 / 0.22);
    transform: scaleX(0);
    transform-origin: left center;
    transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  .ghost[data-holding]::before {
    transform: scaleX(1);
    transition: transform 700ms linear;
  }
  .ghost[data-holding] { color: var(--text); border-color: var(--danger); }
  /* The label rides above the fill: an absolutely positioned ::before paints
     over the button's own text otherwise. */
  .ghost-label { position: relative; }
  #overlay {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 32px;
    text-align: center;
    background: oklch(0.11 0 0 / 0.92);
    backdrop-filter: blur(8px);
    /* Seen once, user-initiated, and it marks the end of the session: the one
       moment on this page where motion is unambiguously earned. From 0.96, not
       from 0 — nothing in the real world appears from nothing. */
    opacity: 1;
    transform: scale(1);
    transition:
      opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
      transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  @starting-style {
    #overlay { opacity: 0; transform: scale(0.96); }
  }
  #overlay[hidden] { display: none; }
  #overlay h1 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
  #overlay p { margin: 0; color: var(--muted); font-size: 14px; }
  /* What the QR code said.
     A sheet and not a second overlay: the overlay ends the session, this one is
     an answer the human reads and dismisses, and the frame stays behind it
     because the next thing they do is usually on the page. It rises from the
     bottom edge, where the thumb already is. */
  #sheet {
    position: fixed;
    inset: 0;
    /* Above the ending overlay, which is 10. The overlay is opaque, and a
       handback taken before the human tapped Open would otherwise bury the
       link this whole feature exists to deliver — with the button disabled,
       the socket closing and no way to scan again. The sheet has its own Done
       button, so the end screen is one tap away. */
    z-index: 11;
    display: flex;
    align-items: flex-end;
    background: oklch(0.11 0 0 / 0.72);
  }
  #sheet[hidden] { display: none; }
  #sheet-card {
    width: 100%;
    max-height: 80%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left));
    border-top: 1px solid var(--line);
    border-radius: var(--radius) var(--radius) 0 0;
    background: var(--surface);
    transform: translateY(0);
    transition: transform 220ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  @starting-style {
    #sheet-card { transform: translateY(100%); }
  }
  #sheet-title { margin: 0; font-size: 17px; letter-spacing: -0.02em; }
  #sheet-links { display: flex; flex-direction: column; gap: 12px; }
  .link {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
  }
  /* The link is the thing being decided on, so it is shown in full and it
     wraps. anywhere, because a token has no spaces to break at — a truncated
     URL is exactly how somebody is talked into opening the wrong one. */
  .link-text {
    margin: 0;
    font-size: 13px;
    line-height: 1.35;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  /* The host is the one word that answers "whose site is this". The rest of a
     URL is a token nobody reads, so it stays muted and the host does not. */
  .link-host { color: var(--text); font-weight: 600; }
  .link-text > span:not(.link-host) { color: var(--muted); }
  .link-note { margin: 0; font-size: 12px; color: var(--muted); }
  .link-actions { display: flex; gap: 8px; }
  /* Same box for the anchor and the button, so the row does not shift by a
     pixel between a link that can be opened and one that can only be copied. */
  .link-action {
    flex: 1 1 0;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 12px;
    border: 1px solid var(--field);
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 15px;
    font-weight: 500;
    text-decoration: none;
  }
  .link-action:active { background: oklch(0.26 0 0 / 0.4); }
  #sheet-close { min-height: 44px; }
  .empty { margin: 0; color: var(--muted); font-size: 14px; }
  /* One page, two jobs. The relay bakes the mode into the body, and the
     controls belonging to the other job are gone rather than disabled: the
     relay refuses to route what they would have sent anyway. */
  body[data-mode="approval"] .takeover-only,
  body[data-mode="takeover"] .approval-only { display: none; }
  /* The sentence being decided. Larger than the reason in the header, because
     the reason says why someone was asked and this is what they answer. */
  .ask { display: flex; flex-direction: column; gap: 3px; margin: 2px 0 14px; }
  .ask-label { font-size: 11px; letter-spacing: 0.02em; color: var(--muted); }
  #action {
    font-size: 20px;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }
  /* Peers, and deliberately so. The accent marks the action the interface
     wants, or nothing (docs/design/phone-ui-audit.md): in a takeover that is
     "Hand back", and in an approval there is no such answer — an interface
     that recommends one is training the thumb to take the loudest button. So
     the two answers are drawn identically and the only asymmetry is the
     gesture. */
  #deny, #approve { flex: 1 1 0; }
  /* Approval inverts the takeover's risk: here the answer that cannot be taken
     back is yes, so yes is the one that costs a hold. The fill stays
     monochrome — the red in this interface means destructive, and approving
     something the human just chose is not that. */
  #approve::before { background: oklch(0.985 0 0 / 0.16); }
  #approve[data-holding] { border-color: var(--field); }
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
    /* Keep the safety, drop the motion: the hold still takes its 700ms, it
       just does not animate getting there. */
    .ghost::before { display: none; }
    .ghost[data-holding] { background: oklch(0.65 0.2 25 / 0.14); }
    #approve[data-holding] { background: oklch(0.985 0 0 / 0.12); }
    #sheet-card { transition: none; }
    @starting-style {
      #sheet-card { transform: none; }
    }
    #overlay { transition: opacity 150ms linear; }
    @starting-style {
      #overlay { opacity: 0; transform: none; }
    }
  }
</style>
</head>
<body data-mode="__HANDRAISE_MODE__">
  <header>
    <span id="dot" class="dot"></span>
    <div class="head-copy">
      <span class="eyebrow"><span class="mark">handraise</span> · <span id="eyebrow-note">an agent asked for your help</span></span>
      <span id="reason">Connecting to the browser…</span>
    </div>
  </header>
  <main id="stage">
    <div id="frame">
      <div id="zoom">
        <canvas id="view"></canvas>
        <div id="focus-ring" hidden></div>
      </div>
    </div>
    <p id="placeholder">Waiting for the first frame…</p>
  </main>
  <footer>
    <div class="bar takeover-only">
      <input id="kbd" type="text" autocomplete="off" autocapitalize="off" autocorrect="off"
        spellcheck="false" enterkeyhint="enter" placeholder="Type here">
      <div class="keys">
        <button id="key-back" class="key" type="button" aria-label="Delete one character">&#9003;</button>
        <button id="key-tab" class="key" type="button" aria-label="Next field">&#8677;</button>
        <button id="key-enter" class="key" type="button" aria-label="Enter">&#9166;</button>
        <button id="key-clear" class="key" type="button" aria-label="Clear the field" disabled>Clear</button>
        <button id="key-qr" class="key" type="button" aria-label="Read the QR codes on the page">Scan QR</button>
      </div>
    </div>
    <p class="ask approval-only">
      <span class="ask-label">The agent is asking to</span>
      <span id="action"></span>
    </p>
    <p class="hint" id="hint">Typing goes straight to the browser</p>
    <div class="row takeover-only">
      <button id="handback" class="primary" type="button">&#9995; Hand back</button>
      <button id="abort" class="ghost" type="button"><span class="ghost-label">I can't do this</span></button>
    </div>
    <div class="row approval-only">
      <button id="deny" class="ghost" type="button"><span class="ghost-label">Deny</span></button>
      <button id="approve" class="ghost" type="button"><span class="ghost-label">Hold to approve</span></button>
    </div>
  </footer>
  <div id="overlay" hidden>
    <h1 id="overlay-title"></h1>
    <p id="overlay-note"></p>
  </div>
  <div id="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <div id="sheet-card">
      <h2 id="sheet-title"></h2>
      <div id="sheet-links"></div>
      <button id="sheet-close" class="primary" type="button">Done</button>
    </div>
  </div>
<script>
(function () {
  var dot = document.getElementById("dot")
  var reason = document.getElementById("reason")
  var placeholder = document.getElementById("placeholder")
  var stage = document.getElementById("stage")
  var frameEl = document.getElementById("frame")
  var zoomEl = document.getElementById("zoom")
  var canvas = document.getElementById("view")
  var ctx = canvas.getContext("2d")
  var ring = document.getElementById("focus-ring")
  var hint = document.getElementById("hint")
  var kbd = document.getElementById("kbd")
  var overlay = document.getElementById("overlay")
  var overlayTitle = document.getElementById("overlay-title")
  var overlayNote = document.getElementById("overlay-note")
  var actionEl = document.getElementById("action")
  var sheet = document.getElementById("sheet")
  var sheetTitle = document.getElementById("sheet-title")
  var sheetLinks = document.getElementById("sheet-links")

  /**
   * The wire vocabulary, injected by the relay that served this page from the
   * one definition at the top of server.js. Not a copy: a message type renamed
   * up there is renamed here in the same edit, and relay.test.ts asserts both
   * against the TypeScript protocol.
   */
  var VOCAB = __HANDRAISE_VOCAB__
  var MSG = VOCAB.msg
  var MODE = VOCAB.mode
  /** The schemes this page may build an "Open" link for. See server.js. */
  var OPENABLE = VOCAB.schemes

  /**
   * Takeover or approval, decided by the relay that served this page. In
   * approval mode the human is answering a question about one screenshot, not
   * driving anything: the input row and the key bar are not on the page, and
   * the two messages below are the only ones this side can produce.
   */
  var APPROVAL = document.body.dataset.mode === MODE.APPROVAL
  var SENDABLE = {}
  ;(APPROVAL
    ? [MSG.APPROVE, MSG.DENY, MSG.PING]
    : [
        MSG.TAP,
        MSG.CHAR,
        MSG.KEY,
        MSG.CLEAR,
        MSG.SCROLL,
        MSG.SCANQR,
        MSG.HANDBACK,
        MSG.ABORT,
        MSG.PING
      ]
  ).forEach(function (type) { SENDABLE[type] = 1 })

  var ws = null
  var retries = 0
  var finished = false
  var reconnectTimer = null
  // Non-zero only after finish() with something still queued: the wall-clock
  // time past which the flush gives up. Zero while the handoff is live, which
  // is what keeps a running handoff reconnecting forever the way it always has.
  var flushDeadline = 0
  // Every connect() bumps this; a displaced socket's stale callbacks compare
  // against it and bow out, so an old onclose never nulls the live socket.
  var generation = 0

  var img = new Image()
  var queued = null
  var decoding = false
  var frameW = 0
  var frameH = 0
  var box = { x: 0, y: 0, w: 0, h: 0 }
  // The newest frame's CDP metadata and the newest focus report. Both are
  // needed to place the ring, and they arrive in separate messages.
  var meta = null
  var focus = null
  var HINT_DEFAULT = APPROVAL
    ? "Approve needs a hold. Deny is one tap."
    : "Typing goes straight to the browser"
  /** Long enough that a stray thumb cannot reach it, short enough to not annoy. */
  var HOLD_MS = 700
  var HOLD_HINT = APPROVAL
    ? "Hold the button to approve"
    : "Hold the button to stop the agent"
  var QUEUE_HINT = "Reconnecting — your input is queued"
  var QUEUE_FULL_HINT = "Reconnecting — queue full, the oldest input was dropped"
  var hintTimer = null

  /** Past this the JPEG has no more detail to magnify, only artefacts. */
  var MAX_ZOOM = 3
  /** Where a double tap lands when the page is at fit. */
  var TAP_ZOOM = 2.5
  /** A field has to be about this tall on the phone before it can be read. */
  var READABLE_FIELD_PX = 44
  /** A thumb of margin either side of the field, and the rest is zoom. Below
      this the field falls off the screen; above it, readability is paying for
      margin the letterbox already provides. */
  var FIELD_WIDTH_SHARE = 0.92
  /** Slightly above centre: what sits below a field is the button that submits it. */
  var FOCUS_ANCHOR_Y = 0.42
  /** Two taps closer than this in time and in space are one double tap. */
  var DOUBLE_TAP_MS = 250
  var DOUBLE_TAP_PX = 20
  /** A finger that moves this far was never a tap. */
  var TAP_SLOP_PX = 10
  /** Queue depth while the socket is down: 50 keystrokes is a long password. */
  var MAX_QUEUED = 50

  /**
   * The canvas transform, in canvas CSS pixels. transform-origin is 0 0, so a
   * canvas-local point l is drawn at l * scale + t — which makes the inverse
   * every tap needs a subtraction and a division, with no origin term.
   * w and h are #frame's untransformed size, measured in render().
   */
  var view = { scale: 1, tx: 0, ty: 0, w: 0, h: 0 }

  /**
   * Human input made while the socket is down. It used to be dropped where the
   * readyState === 1 check failed, which is the one thing an interface may
   * never do silently: the human assumes the *remote page* ignored them, and
   * retypes the character or taps the button again once the socket is back.
   */
  var outbox = []
  var dropped = 0

  function send(message) {
    // The mode's vocabulary, enforced here as well as at the relay: a control
    // that is not on this page cannot have its message leave it either.
    if (!SENDABLE[message.type]) return
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message))
      return
    }
    // A heartbeat is only worth anything now. Replaying it later says nothing.
    if (message.type === MSG.PING) return
    if (outbox.length >= MAX_QUEUED) {
      outbox.shift()
      dropped++
    }
    outbox.push(message)
    showQueue()
  }

  /** The queue is never a secret: a full one says so, in the same line. */
  function showQueue() {
    if (hintTimer) {
      clearTimeout(hintTimer)
      hintTimer = null
    }
    hint.textContent = dropped > 0 ? QUEUE_FULL_HINT : QUEUE_HINT
  }

  /**
   * In order, and at most once. The queue is taken before the first send, so a
   * socket that dies halfway through cannot replay what already left: a
   * duplicated Backspace deletes a character the human never asked to lose,
   * while a dropped one is a character they can see is missing and retype.
   */
  function flushOutbox() {
    var pending = outbox
    outbox = []
    dropped = 0
    for (var i = 0; i < pending.length; i++) {
      // Keystrokes, keys, clear, handback and abort are safe to deliver late:
      // they mean the same thing whenever they land. A tap or a scroll does
      // not — the page may have moved while the link was down, and a stale
      // tap on the wrong element is worse than a tap the human repeats.
      var t = pending[i].type
      if (t === "tap" || t === "scroll") continue
      ws.send(JSON.stringify(pending[i]))
    }
    if (hint.textContent === QUEUE_HINT || hint.textContent === QUEUE_FULL_HINT) {
      setHint()
    }
  }

  /**
   * How long the page keeps trying to deliver a queued answer after the human
   * has finished. A relay that is actually alive reconnects in seconds — this
   * covers several backoff cycles of that. Past it the agent has timed out and
   * killed the sandbox, so the host is gone and retrying it every 8s forever
   * only spins a dead tab; the backoff caps the wait between attempts, not
   * their number, so this is what caps their number.
   */
  var FLUSH_DEADLINE_MS = 30000

  /**
   * A handback or an abort made while the socket was down still has to arrive:
   * the agent is waiting on exactly that message and would otherwise burn its
   * whole five-minute timeout on a human who already answered. But only until
   * the flush deadline: after finish(), a dead host is not worth retrying past
   * the point a live one would have answered.
   */
  function stillSending() {
    return outbox.length > 0 && (flushDeadline === 0 || Date.now() < flushDeadline)
  }

  function setStatus(live) {
    dot.className = live ? "dot" : "dot waiting"
    if (!live) reason.textContent = "Reconnecting…"
  }

  /**
   * Push the transform to the compositor. The CSS variable rides along so the
   * focus ring can divide the zoom back out of its own stroke width.
   */
  function applyTransform(eased) {
    if (eased) zoomEl.dataset.eased = ""
    else delete zoomEl.dataset.eased
    zoomEl.style.transform =
      "translate(" + view.tx + "px, " + view.ty + "px) scale(" + view.scale + ")"
    zoomEl.style.setProperty("--zoom", String(view.scale))
  }

  function clampZoom(scale) {
    return Math.min(MAX_ZOOM, Math.max(1, scale))
  }

  /** Keep the frame covering the viewport. At fit there is nowhere to pan to. */
  function clampPan(offset, size, scale) {
    return Math.min(0, Math.max(size - size * scale, offset))
  }

  function setView(scale, tx, ty, eased) {
    view.scale = clampZoom(scale)
    view.tx = clampPan(tx, view.w, view.scale)
    view.ty = clampPan(ty, view.h, view.scale)
    applyTransform(eased)
  }

  /** Put the canvas-local point (lx, ly) at this share of the visible box. */
  function centreOn(lx, ly, scale, anchorY, eased) {
    var next = clampZoom(scale)
    setView(next, view.w / 2 - lx * next, view.h * anchorY - ly * next, eased)
  }

  /** A resize can strand the pan outside the frame; nothing else can. */
  function reclamp() {
    var tx = clampPan(view.tx, view.w, view.scale)
    var ty = clampPan(view.ty, view.h, view.scale)
    if (tx === view.tx && ty === view.ty) return
    view.tx = tx
    view.ty = ty
    applyTransform(false)
  }

  /**
   * Freeze a running zoom where it currently is. A finger on the glass owns the
   * view: without this the pinch maths would read a mid-animation rectangle and
   * compare it against the transform's final value, and the frame would jump.
   */
  function settleView() {
    if (!zoomEl.hasAttribute("data-eased")) return
    var live = new DOMMatrixReadOnly(getComputedStyle(zoomEl).transform)
    view.scale = live.a > 0 ? live.a : view.scale
    view.tx = live.e
    view.ty = live.f
    applyTransform(false)
  }

  /**
   * Device pixels per canvas CSS pixel to draw at.
   *
   * The transform scales the canvas's rasterised bitmap, so drawing a dpr-sized
   * backing store and then magnifying it 3x means squeezing the JPEG down to
   * the canvas first and blowing the result back up — the field gets big and
   * stays unreadable, which is the whole bug this is meant to fix. Draw at the
   * zoom instead, capped twice: at the JPEG's own resolution, past which there
   * is no more detail to find, and at MAX_ZOOM, so the backing store cannot
   * grow without bound on a phone.
   */
  function backingScale() {
    var dpr = window.devicePixelRatio || 1
    var source = box.w > 0 ? frameW / (box.w * dpr) : 1
    return dpr * Math.max(1, Math.min(view.scale, source, MAX_ZOOM))
  }

  function render() {
    // #frame is never transformed, so this is the layout size even while a zoom
    // is mid-flight. Measuring the canvas would return the animating rectangle.
    var rect = frameEl.getBoundingClientRect()
    view.w = rect.width
    view.h = rect.height
    if (!frameW || !frameH || !rect.width) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    var fit = Math.min(rect.width / frameW, rect.height / frameH)
    box = {
      w: frameW * fit,
      h: frameH * fit,
      x: (rect.width - frameW * fit) / 2,
      y: (rect.height - frameH * fit) / 2
    }
    var pixels = backingScale()
    var wide = Math.round(rect.width * pixels)
    var high = Math.round(rect.height * pixels)
    if (canvas.width !== wide) canvas.width = wide
    if (canvas.height !== high) canvas.height = high
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(img, box.x * pixels, box.y * pixels, box.w * pixels, box.h * pixels)
    // The letterbox just moved, so the ring has to follow it.
    reclamp()
    placeRing()
    zoomToFocus()
  }

  function finiteNumber(value) {
    return typeof value === "number" && isFinite(value)
  }

  /**
   * Place the ring over the focused field.
   *
   * The inverse of toFrame(), one hop longer. The agent reports the box in the
   * remote page's CSS viewport pixels, so:
   *
   *   frame px = page px * pageScaleFactor * jpegWidth / deviceWidth
   *   canvas px = box.x + frame px * box.w / frameW
   *
   * The first factor is the scaling Chromium applied to the JPEG and left out
   * of the metadata; the second is this page's own letterbox.
   */
  /** Remote page CSS px -> canvas CSS px, or null when the maths cannot run. */
  function frameScale() {
    if (!meta || !frameW || !frameH || !box.w) return null
    var pageZoom = meta.pageScaleFactor > 0 ? meta.pageScaleFactor : 1
    var kx = (meta.jpegWidth / meta.deviceWidth) * pageZoom * (box.w / frameW)
    var ky = (meta.jpegHeight / meta.deviceHeight) * pageZoom * (box.h / frameH)
    if (!isFinite(kx) || !isFinite(ky) || kx <= 0 || ky <= 0) return null
    return { kx: kx, ky: ky }
  }

  function placeRing() {
    var k = focus && focus.rect ? frameScale() : null
    if (!k) {
      ring.hidden = true
      return
    }
    // Canvas-local coordinates and nothing else: the ring sits inside #zoom, so
    // the transform carries it onto the screen for free.
    var rect = focus.rect
    ring.style.left = (box.x + rect.x * k.kx) + "px"
    ring.style.top = (box.y + rect.y * k.ky) + "px"
    ring.style.width = (rect.width * k.kx) + "px"
    ring.style.height = (rect.height * k.ky) + "px"
    ring.hidden = false
  }

  /**
   * The rect the view was last zoomed to. A focus that repeats — the agent
   * re-probes after every keystroke — must not drag the frame back from
   * wherever the human has since pinched to.
   */
  var zoomedTo = ""

  /**
   * The headline fix. At fit the remote page is letterboxed to about 29%, which
   * puts 14px body text at ~4 CSS px — a millimetre of glyph. The agent already
   * says which box it wants filled in, so fill the screen with that box the
   * moment it says so.
   *
   * Losing the focus deliberately keeps the zoom. Snapping back to 29% would
   * undo the one thing the human asked for and lose their place on the page
   * between two fields of the same form; they zoom out with a double tap, when
   * they mean to.
   */
  function zoomToFocus() {
    var rect = focus && focus.rect
    if (!rect) {
      zoomedTo = ""
      return
    }
    var key = rect.x + ":" + rect.y + ":" + rect.width + ":" + rect.height
    var k = key === zoomedTo ? null : frameScale()
    if (!k || !view.w) return
    var wide = rect.width * k.kx
    var high = rect.height * k.ky
    if (wide <= 0 || high <= 0) return
    zoomedTo = key
    // Big enough to read, small enough that the field still fits on the screen,
    // and never past the point where the JPEG runs out of pixels to magnify.
    var readable = READABLE_FIELD_PX / high
    var fits = (view.w * FIELD_WIDTH_SHARE) / wide
    var scale = Math.min(Math.max(readable, 1), Math.max(fits, 1), MAX_ZOOM)
    centreOn(
      box.x + (rect.x + rect.width / 2) * k.kx,
      box.y + (rect.y + rect.height / 2) * k.ky,
      scale,
      FOCUS_ANCHOR_Y,
      true
    )
  }

  /**
   * Name the field the keyboard is driving. textContent, never innerHTML: the
   * label comes from whatever page the agent got stuck on.
   */
  function setHint() {
    var named = focus && focus.rect && focus.label
    hint.textContent = named ? "Typing into: " + focus.label : HINT_DEFAULT
  }

  /** Accept a focus message only in the shape the ring maths can use. */
  function readFocus(message) {
    var rect = message.rect
    var usable =
      rect &&
      finiteNumber(rect.x) &&
      finiteNumber(rect.y) &&
      finiteNumber(rect.width) &&
      finiteNumber(rect.height)
    return {
      rect: usable
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null,
      label: typeof message.label === "string" ? message.label : null,
      // An agent that predates the field sends nothing, and "text" is exactly
      // how every field behaved before it existed.
      kind: message.kind === "otp" || message.kind === "password"
        ? message.kind
        : "text"
    }
  }

  /**
   * Dress the local field like the remote one.
   *
   * This is the whole reason kind is on the wire: on iOS a text field with
   * autocomplete="one-time-code" is offered the code straight from Messages,
   * and the human stops copying six digits between two apps — which is the
   * single most common thing this product is used for. There is deliberately no
   * pattern attribute: plenty of one-time codes are alphanumeric, and a
   * digits-only pattern would silently swallow the letters.
   *
   * Password gets type="password" so the secret is not left legible on a phone
   * held in an office. The characters still stream out one at a time; the mirror
   * keeps working, it just stops being readable over a shoulder.
   */
  var KINDS = {
    otp: { type: "text", mode: "numeric", complete: "one-time-code" },
    password: { type: "password", mode: "text", complete: "off" },
    text: { type: "text", mode: "text", complete: "off" }
  }

  function applyKind(kind) {
    var want = KINDS[kind] || KINDS.text
    if (kbd.type === want.type && kbd.autocomplete === want.complete) return
    kbd.type = want.type
    kbd.inputMode = want.mode
    kbd.autocomplete = want.complete
    // A different field is a different context. Without this the Backspace diff
    // would run the next keystroke against what was typed into the last one.
    resetMirror()
  }

  img.onload = function () {
    decoding = false
    frameW = img.naturalWidth
    frameH = img.naturalHeight
    placeholder.hidden = true
    render()
    if (queued !== null) {
      var next = queued
      queued = null
      decoding = true
      img.src = next
    }
  }
  img.onerror = function () { decoding = false }

  // Newest frame wins: a phone that decodes slower than the stream arrives must
  // fall behind in quality of service, never in wall-clock time.
  function showFrame(data, frameMeta) {
    if (frameMeta) meta = frameMeta
    var src = "data:image/jpeg;base64," + data
    if (decoding) { queued = src; return }
    decoding = true
    img.src = src
  }

  /**
   * Client point -> canvas CSS pixel. The transform is ours and anchored at
   * 0 0, so the inverse is the rectangle's own left edge (which is the image of
   * canvas-local zero) and a division by the scale. No origin term, no pan
   * term: both are already inside rect.left.
   */
  function toLocal(clientX, clientY) {
    var rect = zoomEl.getBoundingClientRect()
    return {
      x: (clientX - rect.left) / view.scale,
      y: (clientY - rect.top) / view.scale
    }
  }

  function toFrame(clientX, clientY) {
    if (!frameW || !box.w) return null
    var local = toLocal(clientX, clientY)
    var x = ((local.x - box.x) * frameW) / box.w
    var y = ((local.y - box.y) * frameH) / box.h
    if (x < 0 || y < 0 || x > frameW || y > frameH) return null
    return { x: Math.round(x), y: Math.round(y) }
  }

  var press = null
  /** Live pointers on the canvas. Two of them is a pinch; one is everything else. */
  var pointers = new Map()
  var pinch = null
  var lastTap = { at: 0, x: 0, y: 0 }

  function pinchSpan() {
    var points = []
    pointers.forEach(function (point) { points.push(point) })
    var a = points[0]
    var b = points[1]
    return {
      dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2
    }
  }

  function beginPinch() {
    var span = pinchSpan()
    var rect = zoomEl.getBoundingClientRect()
    // The point between the fingers, in canvas CSS pixels, plus the wrapper's
    // untransformed origin. Holding that point under the fingers for the whole
    // gesture is the entire feel of a pinch.
    pinch = {
      dist: span.dist,
      scale: view.scale,
      lx: (span.cx - rect.left) / view.scale,
      ly: (span.cy - rect.top) / view.scale,
      ox: rect.left - view.tx,
      oy: rect.top - view.ty
    }
  }

  function updatePinch() {
    if (!pinch) return
    var span = pinchSpan()
    var next = clampZoom((pinch.scale * span.dist) / pinch.dist)
    setView(
      next,
      span.cx - pinch.ox - pinch.lx * next,
      span.cy - pinch.oy - pinch.ly * next,
      false
    )
  }

  /**
   * One finger on an approval pans the screenshot. There is no remote page to
   * scroll — the frame is a still — and a magnified still you cannot move is
   * a picture of the middle of the page.
   */
  function dragPan(e) {
    var dx = e.clientX - press.lastX
    var dy = e.clientY - press.lastY
    press.lastX = e.clientX
    press.lastY = e.clientY
    setView(view.scale, view.tx + dx, view.ty + dy, false)
  }

  /** One finger: a scroll of the remote page, or a pan of the screenshot. */
  function dragMove(e) {
    press.travel = Math.max(press.travel, Math.hypot(e.clientX - press.x, e.clientY - press.y))
    if (press.travel < TAP_SLOP_PX) return
    if (APPROVAL) {
      dragPan(e)
      return
    }
    if (!box.h) return
    var now = Date.now()
    if (now - press.sentAt < 60) return
    var stepped = e.clientY - press.lastY
    press.lastY = e.clientY
    press.sentAt = now
    // Direct manipulation: dragging the finger down reveals earlier content, so
    // the wheel delta the agent forwards is the inverse of the finger movement.
    // Divided by the zoom, or a magnified page would scroll magnified too.
    var fdy = Math.round((-stepped * frameH) / (box.h * view.scale))
    if (fdy !== 0) send({ type: MSG.SCROLL, fdy: fdy })
  }

  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId)
    settleView()
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size >= 2) {
      // Two fingers is a pinch and never a tap or a scroll: drop whatever the
      // first finger had started, so releasing them sends nothing.
      press = null
      beginPinch()
      return
    }
    press = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, travel: 0, sentAt: 0 }
  })
  canvas.addEventListener("pointermove", function (e) {
    var point = pointers.get(e.pointerId)
    if (point) {
      point.x = e.clientX
      point.y = e.clientY
    }
    if (pointers.size >= 2) {
      updatePinch()
      return
    }
    if (press) dragMove(e)
  })
  /** Acknowledge the tap where the finger landed, inside the same frame. */
  function markTap(clientX, clientY) {
    var host = stage.getBoundingClientRect()
    var mark = document.createElement("div")
    mark.className = "tapmark"
    mark.style.left = (clientX - host.left) + "px"
    mark.style.top = (clientY - host.top) + "px"
    var drop = function () { mark.remove() }
    mark.addEventListener("animationend", drop)
    // With animations disabled outright, animationend never fires and the marks
    // would pile up on the stage for the rest of the session.
    setTimeout(drop, 600)
    stage.appendChild(mark)
    if (navigator.vibrate) navigator.vibrate(8)
  }

  /**
   * The second half of a double tap.
   *
   * The first tap is already gone — waiting 250ms to find out whether a second
   * one is coming would put a delay on the single action this whole page exists
   * for, and a tap that arrives late on a login form is worse than no zoom
   * gesture at all. So the second tap sends nothing and toggles the zoom
   * instead. The cost is one extra tap delivered to the remote page per double
   * tap, which lands in the same place the human was already tapping.
   */
  function isDoubleTap(clientX, clientY, now) {
    return (
      now - lastTap.at < DOUBLE_TAP_MS &&
      Math.hypot(clientX - lastTap.x, clientY - lastTap.y) < DOUBLE_TAP_PX
    )
  }

  function toggleZoom(clientX, clientY) {
    if (view.scale > 1.01) {
      setView(1, 0, 0, true)
      return
    }
    var local = toLocal(clientX, clientY)
    centreOn(local.x, local.y, TAP_ZOOM, 0.5, true)
  }

  canvas.addEventListener("pointerup", function (e) {
    var pinching = pointers.size >= 2
    pointers.delete(e.pointerId)
    if (pinching) {
      // Lifting one finger of a pinch ends the gesture; the other one is not a
      // tap. Re-render so the backing store follows the zoom it settled on.
      if (pointers.size < 2) pinch = null
      press = null
      render()
      return
    }
    var was = press
    press = null
    if (!was || was.travel >= TAP_SLOP_PX) return
    var now = Date.now()
    if (isDoubleTap(e.clientX, e.clientY, now)) {
      lastTap.at = 0
      toggleZoom(e.clientX, e.clientY)
      return
    }
    lastTap = { at: now, x: e.clientX, y: e.clientY }
    // A single tap on an approval does nothing, and says so by doing nothing:
    // an acknowledgement ripple would promise the remote page had seen it.
    if (APPROVAL) return
    var point = toFrame(e.clientX, e.clientY)
    if (!point) return
    send({ type: MSG.TAP, fx: point.x, fy: point.y })
    markTap(e.clientX, e.clientY)
  })
  canvas.addEventListener("pointercancel", function (e) {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    press = null
  })

  // The field is a local mirror only. Every keystroke leaves for the browser the
  // moment it is typed, so what the remote page shows is the real state.
  var mirrored = ""
  kbd.addEventListener("input", function () {
    var next = kbd.value
    var shared = 0
    while (shared < mirrored.length && shared < next.length && mirrored[shared] === next[shared]) {
      shared++
    }
    for (var back = mirrored.length; back > shared; back--) send({ type: MSG.KEY, key: "Backspace" })
    for (var i = shared; i < next.length; i++) send({ type: MSG.CHAR, ch: next[i] })
    mirrored = next
  })
  // The mirror and the field are one state: writing kbd.value fires no input
  // event, so the diff above never sees these edits and never sends for them.
  function resetMirror() {
    kbd.value = ""
    mirrored = ""
  }

  kbd.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault()
      send({ type: MSG.KEY, key: "Enter" })
      resetMirror()
      return
    }
    // An empty field fires no input event, so this is the only signal that the
    // human wants to delete a character the remote page still holds.
    if (e.key === "Backspace" && kbd.value === "") send({ type: MSG.KEY, key: "Backspace" })
  })

  /**
   * The key bar. A phone's virtual keyboard is not a keyboard: on Android a
   * Backspace on an empty field arrives as keyCode 229 / key "Unidentified" or
   * as nothing at all, so the keydown path above never fires and text already
   * in the remote field cannot be deleted. These four buttons send the message
   * themselves and depend on no keyboard event.
   *
   * Focus is the whole difficulty. A button that takes focus blurs #kbd, and
   * the soft keyboard slides away under every press. preventDefault on
   * mousedown and touchstart stops the focus moving — but cancelling touchstart
   * also suppresses the compatibility click, so the touch path has to act on
   * touchend. touchedAt keeps a browser that still emits that click from
   * running the handler twice: a doubled Backspace deletes a character the
   * human never asked to lose.
   */
  function keyButton(id, run) {
    var button = document.getElementById(id)
    var touchedAt = 0
    var hold = function (e) { e.preventDefault() }
    button.addEventListener("mousedown", hold)
    button.addEventListener("touchstart", hold, { passive: false })
    button.addEventListener("touchend", function (e) {
      e.preventDefault()
      touchedAt = Date.now()
      if (!button.disabled) run()
    })
    button.addEventListener("click", function () {
      if (Date.now() - touchedAt < 700) return
      if (!button.disabled) run()
    })
    return button
  }

  keyButton("key-back", function () {
    // Trim the mirror with the field, so the character is deleted once: this
    // message speaks for it, and the diff has nothing left to report.
    if (kbd.value.length > 0) {
      kbd.value = kbd.value.slice(0, -1)
      mirrored = kbd.value
    }
    send({ type: MSG.KEY, key: "Backspace" })
  })
  var clearKey = keyButton("key-clear", function () {
    send({ type: MSG.CLEAR })
    resetMirror()
  })
  // Tab moves to another field, Enter usually submits: either way what the
  // human types next belongs to a different context than what is mirrored here.
  keyButton("key-tab", function () {
    send({ type: MSG.KEY, key: "Tab" })
    resetMirror()
  })
  keyButton("key-enter", function () {
    send({ type: MSG.KEY, key: "Enter" })
    resetMirror()
  })

  /**
   * Clearing needs a focused field: with nothing focused, the select-all half
   * of it would mark the whole remote page instead of a value. The agent tells
   * us what is focused, so offer the key exactly when it has a target.
   */
  function setClearEnabled() {
    clearKey.disabled = !(focus && focus.rect)
  }

  // ------------------------------------------------------------ QR codes ---
  //
  // The site wants a phone to scan the code it is showing, and the phone is
  // the thing showing it. So the agent reads it off its own screenshot and
  // sends back what it said; this half is the button that asks and the sheet
  // that answers.

  /** Long enough for a screenshot plus a decode across a continent. */
  var SCAN_TIMEOUT_MS = 12000
  /** The floor the agent enforces too, kept here so the button rarely hits it. */
  var SCAN_INTERVAL_MS = 2000
  var SCAN_HINT = "Reading the page…"
  var SCAN_FAILED_HINT = "The agent didn't answer — try again"
  var SCAN_SOON_HINT = "One scan at a time — try again in a moment"
  var scanning = false
  var scanTimer = null
  var lastScanAt = 0

  /**
   * A link is openable only if this page says so.
   *
   * The agent already classified it, but that classification arrives over a
   * socket anybody holding the handoff URL can write to, and the payload came
   * off a page the agent did not choose. So the scheme is checked again here,
   * against the allowlist the relay injected: "javascript:", "data:" and
   * everything else nobody thought of get a Copy button and no anchor.
   */
  /**
   * Whitespace and control characters, the same rule the agent applies.
   *
   * The URL parser deletes a tab or a newline without a word, so a payload
   * that reads as one host parses as another. Rejecting it outright is what
   * keeps the parse honest.
   */
  function hasUnsafeCharacter(value) {
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i)
      if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true
      // Invisible by design: zero-width joiners and the bidi overrides and
      // isolates. A right-to-left override reverses the visible tail of a
      // path, and nothing on the screen says it happened.
      if (code >= 0x200b && code <= 0x200f) return true
      if (code >= 0x202a && code <= 0x202e) return true
      if (code >= 0x2066 && code <= 0x2069) return true
    }
    return false
  }

  /**
   * A link is openable only if this page says so.
   *
   * The agent already classified it, but that classification arrives over a
   * socket anybody holding the handoff URL can write to, and the payload came
   * off a page the agent did not choose. So the whole rule is applied again
   * here — scheme, smuggled control characters, and credentials in the
   * authority, which is the oldest way to make a link read as one host and go
   * to another. Not just the scheme: half a lock is not two locks.
   */
  function openable(link) {
    if (!link || link.kind !== "url") return false
    if (link.text.length === 0 || hasUnsafeCharacter(link.text)) return false
    try {
      var url = new URL(link.text)
      if (url.username !== "" || url.password !== "") return false
      return OPENABLE.indexOf(url.protocol) !== -1
    } catch (err) {
      return false
    }
  }

  /**
   * What the card shows, and what Open and Copy use — one string, never two.
   *
   * The payload came out of a QR code drawn by a page nobody vetted, and the
   * URL parser resolves things the eye cannot: a Cyrillic a in a host lands on
   * a punycode domain, and a right-to-left override reverses the visible tail
   * of a path. Showing the raw text next to an anchor that resolves it means
   * the human reads one address and opens another. So an openable link is
   * shown as its resolved form, and the card says so when the two differ.
   * Nothing is truncated; the whole link is still on the screen.
   */
  /**
   * The authority as the code actually wrote it, lowercased.
   *
   * Not what the parser made of it — that is the whole point. Empty for a
   * scheme with no authority (mailto:), where there is no host to be deceived
   * about.
   */
  function writtenHost(text) {
    // Deliberately not a regular expression: this whole script is a template
    // literal in server.js, which eats the backslash a regex needs. Two
    // indexOf calls and a loop cannot be broken by that.
    var mark = text.indexOf("://")
    if (mark === -1) return ""
    var rest = text.slice(mark + 3)
    var end = rest.length
    for (var i = 0; i < rest.length; i++) {
      var c = rest.charAt(i)
      if (c === "/" || c === "?" || c === "#") { end = i; break }
    }
    var authority = rest.slice(0, end)
    var at = authority.lastIndexOf("@")
    return (at === -1 ? authority : authority.slice(at + 1)).toLowerCase()
  }

  function resolveLink(link) {
    if (!openable(link)) return { shown: link.text, changed: false, host: "" }
    var url = new URL(link.text)
    return {
      shown: url.href,
      // Only when the host the code wrote is not the host the browser will
      // connect to. Comparing the whole string instead fired on
      // "https://example.com" — the parser adds the trailing slash — and on any
      // capital letter in a scheme or a domain, which is to say on some of the
      // commonest shapes a QR code has. A warning that goes off on ordinary
      // input is one a human learns to tap past, and this one has to land on
      // the day it means a Cyrillic homograph.
      changed: writtenHost(link.text) !== "" && writtenHost(link.text) !== url.host,
      // The ASCII host, which is the one the browser will connect to and the
      // one word on the card worth reading before tapping Open.
      host: url.host
    }
  }

  /**
   * What a payload is, when it is not something this page will open.
   *
   * Two of them are actions rather than pages and are named as such, because
   * "not a link" says nothing useful about a phone number or an authenticator
   * secret — and because both are things a human should hand to an app
   * deliberately rather than in one tap from a page nobody vetted.
   */
  function describePayload(text) {
    var scheme = ""
    try { scheme = new URL(text).protocol } catch (err) { scheme = "" }
    if (scheme === "tel:") {
      return "Phone number. Copy it and dial it yourself — a code like this can carry dialler commands."
    }
    if (scheme === "otpauth:") {
      return "Authenticator secret. Add it by hand, and never from a page you did not expect to see it on."
    }
    return "Not a link this page will open. Copy it instead."
  }

  function actionButton(label, run) {
    var button = document.createElement("button")
    button.type = "button"
    button.className = "link-action"
    button.textContent = label
    button.addEventListener("click", run)
    return button
  }

  /**
   * Copy, with the one thing that can go wrong said out loud. The clipboard
   * API needs a secure context and a user gesture; this has both, but a phone
   * browser may still refuse, and a Copy button that silently does nothing is
   * worse than one that admits it.
   */
  function copyButton(text) {
    return actionButton("Copy", function () {
      var clipboard = navigator.clipboard
      if (!clipboard) { flashHint("This browser won't let the page copy"); return }
      clipboard.writeText(text).then(
        function () { flashHint("Copied") },
        function () { flashHint("This browser won't let the page copy") }
      )
    })
  }

  function linkNote(card, message) {
    var note = document.createElement("p")
    note.className = "link-note"
    note.textContent = message
    card.appendChild(note)
  }

  /** One card per code. textContent only: this string came off a hostile page. */
  function linkCard(link) {
    var card = document.createElement("div")
    card.className = "link"
    var resolved = resolveLink(link)
    var text = document.createElement("p")
    text.className = "link-text"
    // The host, drawn as the loud part. Everything else in a URL is noise to
    // the one question a human is answering — whose site is this — and on a
    // 390px screen the host is otherwise a few characters lost in a token.
    var split = resolved.host ? resolved.shown.indexOf(resolved.host) : -1
    if (split === -1) {
      text.textContent = resolved.shown
    } else {
      var before = document.createElement("span")
      before.textContent = resolved.shown.slice(0, split)
      var host = document.createElement("span")
      host.className = "link-host"
      host.textContent = resolved.host
      var after = document.createElement("span")
      after.textContent = resolved.shown.slice(split + resolved.host.length)
      text.appendChild(before)
      text.appendChild(host)
      text.appendChild(after)
    }
    card.appendChild(text)
    var actions = document.createElement("div")
    actions.className = "link-actions"
    if (openable(link)) {
      if (resolved.changed) {
        linkNote(
          card,
          "The code wrote this address differently. This is where it really goes."
        )
      }
      var open = document.createElement("a")
      open.className = "link-action"
      open.href = resolved.shown
      open.target = "_blank"
      // noopener: the opened page must not get a handle on this one, which is
      // the tab holding a live handoff. noreferrer keeps the handoff URL — a
      // bearer credential — out of the other site's logs.
      open.rel = "noopener noreferrer"
      open.textContent = "Open in new tab"
      actions.appendChild(open)
    } else {
      linkNote(card, describePayload(link.text))
    }
    // Copy takes what is on the card, so what a human pastes elsewhere is the
    // address they read here and not the one the code smuggled.
    actions.appendChild(copyButton(resolved.shown))
    card.appendChild(actions)
    return card
  }

  /**
   * The wire's array, parsed into cards this page can draw.
   *
   * A links message carrying a null, a number or an object with no text used
   * to throw out of the message handler, which skipped endScan() and left the
   * Scan QR button dead until its twelve-second deadline. Parse it here
   * instead: anything that is not a payload is not a card.
   */
  function readLinks(raw) {
    var links = []
    if (!Array.isArray(raw)) return links
    for (var i = 0; i < raw.length; i++) {
      var entry = raw[i]
      if (!entry || entry.text === undefined || entry.text === null) continue
      var text = String(entry.text)
      if (text.length === 0) continue
      links.push({ text: text, kind: entry.kind === "url" ? "url" : "text" })
    }
    return links
  }

  function showLinks(links) {
    sheetLinks.textContent = ""
    if (links.length === 0) {
      sheetTitle.textContent = "No QR code found"
      var empty = document.createElement("p")
      empty.className = "empty"
      empty.textContent =
        "Nothing on this screen decoded as a QR code. Scroll the page to bring it into view, then scan again."
      sheetLinks.appendChild(empty)
    } else {
      sheetTitle.textContent =
        links.length > 1 ? links.length + " codes on the page" : "On the page"
      for (var i = 0; i < links.length; i++) {
        sheetLinks.appendChild(linkCard(links[i]))
      }
    }
    sheet.hidden = false
  }

  /** Let the button go again, whatever ended the scan. */
  function endScan() {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null }
    scanning = false
    qrKey.disabled = finished
    if (hint.textContent === SCAN_HINT) setHint()
  }

  var qrKey = keyButton("key-qr", function () {
    if (scanning) return
    // The agent drops a scan that comes too soon, and a dropped scan is an
    // answer that never arrives. Say so here instead of spending the wait.
    if (Date.now() - lastScanAt < SCAN_INTERVAL_MS) {
      flashHint(SCAN_SOON_HINT)
      return
    }
    lastScanAt = Date.now()
    scanning = true
    qrKey.disabled = true
    hint.textContent = SCAN_HINT
    send({ type: MSG.SCANQR })
    // The answer may never come: the agent may have gone, or dropped this one.
    // Without a deadline the button would stay dead for the rest of the session.
    scanTimer = setTimeout(function () {
      scanTimer = null
      endScan()
      flashHint(SCAN_FAILED_HINT)
    }, SCAN_TIMEOUT_MS)
  })

  document.getElementById("sheet-close").addEventListener("click", function () {
    sheet.hidden = true
  })

  function finish(title, note) {
    finished = true
    overlayTitle.textContent = title
    overlayNote.textContent = note
    overlay.hidden = false
    dot.className = "dot dead"
    // Nothing is being typed into anymore; drop the ring and the field name.
    focus = null
    placeRing()
    setHint()
    setClearEnabled()
    // A scan can no longer be answered: there is no agent left to ask. The
    // sheet stays if it is open — the link is still worth reading.
    endScan()
    applyKind("text")
    kbd.blur()
    // A queued answer now has a deadline: keep reconnecting to flush it, but
    // not forever against a host that may already be gone. Set before the
    // stillSending() check below so both read the same state.
    if (outbox.length > 0) flushDeadline = Date.now() + FLUSH_DEADLINE_MS
    // Only close once there is nothing left to deliver. A give-up made during a
    // reconnect has to reach the agent, or it waits out its whole timeout for a
    // human who already answered.
    if (ws && !stillSending()) ws.close()
  }

  function flashHint(text) {
    hint.textContent = text
    if (hintTimer) clearTimeout(hintTimer)
    hintTimer = setTimeout(function () { hintTimer = null; setHint() }, 2200)
  }

  /**
   * Press-and-hold, for the one answer in each mode that cannot be taken back:
   * giving up in a takeover, approving in an approval. The message leaves the
   * socket and the agent settles on it immediately, so the gesture costs more
   * than a tap instead of a confirm dialog costing a screen.
   *
   * Pointer events only: they cover mouse, touch and pen with one stream, so
   * the hold cannot start twice from one finger.
   */
  function holdButton(button, run) {
    var holdTimer = null
    var holdFired = false

    function startHold() {
      if (holdTimer || finished) return
      button.dataset.holding = ""
      holdTimer = setTimeout(function () {
        holdTimer = null
        holdFired = true
        delete button.dataset.holding
        if (navigator.vibrate) navigator.vibrate(20)
        run()
      }, HOLD_MS)
    }

    function cancelHold() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      delete button.dataset.holding
    }

    button.addEventListener("pointerdown", startHold)
    button.addEventListener("pointerup", cancelHold)
    button.addEventListener("pointercancel", cancelHold)
    button.addEventListener("pointerleave", cancelHold)
    // A keyboard has no press-and-hold of its own, so held Space or Enter is
    // the same contract. Without this the button needs a pointer to reach.
    button.addEventListener("keydown", function (e) {
      if (e.key !== " " && e.key !== "Enter") return
      e.preventDefault()
      if (!e.repeat) startHold()
    })
    button.addEventListener("keyup", cancelHold)
    // A release always fires a click. After a completed hold that click is the
    // same gesture arriving twice; before 700ms it is a tap that did nothing,
    // and a tap that does nothing has to say why or it reads as broken.
    button.addEventListener("click", function () {
      if (holdFired) { holdFired = false; return }
      flashHint(HOLD_HINT)
    })
  }

  var ENDINGS = {
    resolved: ["Thanks — that unblocked it", "The agent is driving again. You can close this tab."],
    aborted: ["Handoff ended", "You couldn't solve it here. Nothing more to do — you can close this tab."],
    approved: ["Approved", "The agent has your approval and is continuing. You can close this tab."],
    denied: ["Denied", "The agent has been told not to do it. You can close this tab."],
    timeout: ["Too late", "The agent gave up waiting. Nothing you can do here now."],
    disconnected: ["Connection ended", "The remote browser closed. The agent has been told — this wasn't anything you did."]
  }

  if (APPROVAL) {
    // Deny is a single tap because it is the answer that keeps the world as it
    // is; approve is the hold, because it is the one that cannot be undone.
    // That is the takeover's rule with the sides swapped, for the same reason.
    document.getElementById("deny").addEventListener("click", function () {
      send({ type: MSG.DENY })
      finish(ENDINGS.denied[0], ENDINGS.denied[1])
    })
    holdButton(document.getElementById("approve"), function () {
      send({ type: MSG.APPROVE })
      finish(ENDINGS.approved[0], ENDINGS.approved[1])
    })
  } else {
    // The expected ending, and the only one whose worst case is recoverable in
    // spirit: the agent looks, fails and asks again. Confirming the happy path
    // is the classic mistake, so this stays a single tap.
    document.getElementById("handback").addEventListener("click", function () {
      send({ type: MSG.HANDBACK })
      finish(ENDINGS.resolved[0], ENDINGS.resolved[1])
    })
    holdButton(document.getElementById("abort"), function () {
      send({ type: MSG.ABORT })
      finish("Thanks for looking", "The agent knows it can't be done here and will stop. You can close this tab.")
    })
  }

  function handle(raw) {
    var message
    try { message = JSON.parse(raw) } catch (err) { return }
    if (!message) return
    if (message.type === MSG.FRAME) showFrame(message.data, message.meta)
    else if (message.type === MSG.STATE) {
      reason.textContent = message.reason
      // textContent, never innerHTML: the action is the agent's own sentence,
      // and it goes on the screen a decision is made from.
      if (message.action) actionEl.textContent = message.action
    }
    else if (message.type === MSG.FOCUS) {
      focus = readFocus(message)
      applyKind(focus.rect ? focus.kind : "text")
      placeRing()
      zoomToFocus()
      setHint()
      setClearEnabled()
    }
    else if (message.type === MSG.LINKS) {
      endScan()
      showLinks(readLinks(message.links))
    }
    else if (message.type === MSG.ENDED) {
      var ending = ENDINGS[message.outcome] || ["Session ended", "You can close this tab."]
      finish(ending[0], ending[1])
    }
  }

  // Close 1006 after 60s of silence is the preview proxy, not the human
  // leaving. Reconnecting is the normal path. One timer only, so a backoff and
  // a visibilitychange can never race into two overlapping sockets.
  function scheduleReconnect() {
    if ((finished && !stillSending()) || reconnectTimer) return
    var wait = Math.min(500 * Math.pow(2, retries++), 8000)
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null
      connect()
    }, wait + Math.random() * 250)
  }

  function connect() {
    if (finished && !stillSending()) return
    // Refuse a second socket while one is already connecting or open — that is
    // how the displaced-socket churn started.
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
    var mine = ++generation
    var scheme = location.protocol === "https:" ? "wss:" : "ws:"
    // Relative: the ?pt_token= on the page URL already earned a __pt_preview
    // cookie, which authenticates this upgrade without carrying the token again.
    var sock = new WebSocket(scheme + "//" + location.host + "/ws?role=human")
    ws = sock
    sock.onopen = function () {
      if (mine !== generation) { sock.close(); return }
      retries = 0
      // A page that has already ended is not "live" again; this socket exists
      // only to carry what is still queued.
      if (!finished) setStatus(true)
      flushOutbox()
      // finish() left this socket open for exactly that flush.
      if (finished) sock.close()
    }
    sock.onmessage = function (e) { if (mine === generation) handle(e.data) }
    sock.onclose = function () {
      // A stale socket (already superseded) must not touch shared state.
      if (mine !== generation) return
      ws = null
      // Being finished is not enough to stop: an answer made while this socket
      // was already CLOSING is sitting in the outbox, and it is the one message
      // the agent is waiting for. Abandoning it here showed the human
      // "Approved" and left the agent to time out.
      if (finished && !stillSending()) return
      if (!finished) setStatus(false)
      scheduleReconnect()
    }
    sock.onerror = function () { if (mine === generation) sock.close() }
  }

  if (APPROVAL) {
    // The page arrives phrased for a takeover, because that is what it is most
    // of the time. These three lines are the rest of the difference.
    document.getElementById("eyebrow-note").textContent = "an agent needs your approval"
    placeholder.textContent = "Waiting for the screenshot…"
    setHint()
  }
  applyTransform(false)
  setInterval(function () { send({ type: MSG.PING }) }, 20000)
  window.addEventListener("resize", render)
  // The stage also changes size without the window doing so: a longer reason
  // takes the header to its second line. The letterbox has to follow.
  if (window.ResizeObserver) new ResizeObserver(render).observe(stage)
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || (finished && !stillSending())) return
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    retries = 0
    // connect() refuses if a socket is already live, so this is safe to call
    // whether or not the current socket is still up.
    connect()
  })
  connect()
})()
</script>
</body>
</html>
`
