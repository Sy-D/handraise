/**
 * handraise in-guest relay — the only thing that runs inside the Solari sandbox.
 *
 * SOURCE OF TRUTH. `scripts/embed-guest.ts` inlines this file verbatim into
 * `src/relay/guest-source.ts`; never edit the generated copy.
 *
 * Constraints that shape every line below:
 *   - Node v18.20.4, template `base`, ZERO dependencies (see spikes/s1-report.md).
 *   - One port for everything. Each preview port is its own subdomain with its
 *     own token and its own cookie grant, so a second port would double the
 *     auth surface for no gain.
 *   - The preview proxy kills a silent WebSocket after exactly 60s (close 1006),
 *     hence the 20s server-side ping below and the client's own 20s heartbeat.
 *
 * Routing contract (src/relay/protocol.ts): this is a dumb router. Everything
 * an agent sends goes to the human and vice versa, byte for byte. The only two
 * exceptions are answering `{"type":"ping"}` with `{"type":"pong"}` and keeping
 * the last `frame`/`state` so a human who joins late sees something instantly.
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

/** Grace before a replaced/closed socket is force-destroyed if it hangs on. */
const CLOSE_GRACE_MS = 1000

const PONG = JSON.stringify({ type: "pong" })

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
 * A terminal human message (handback/abort) held for an agent that is not
 * connected at the moment — typically mid-reconnect. Delivered to the next
 * role=agent so the handoff resolves instead of falsely timing out with no
 * storageState. Symmetric to the lastFrame replay for a late human.
 */
let pendingForAgent = null

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
function createReader(onMessage, onPing, onClose) {
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
      if (length > MAX_MESSAGE_BYTES) {
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
      if (fragmentBytes > MAX_MESSAGE_BYTES) {
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

function route(peer, payload, opcode) {
  // A peer that has been closed or replaced (its role now points at a newer
  // socket) must not route anything, even if its reader fires one more time.
  if (!peer.open || peers.get(peer.role) !== peer) return
  const other = peers.get(peer.role === "agent" ? "human" : "agent")
  let type = null
  if (opcode === OP_TEXT) {
    type = messageType(payload)
    if (type === "ping") {
      sendText(peer, PONG)
      return
    }
    if (peer.role === "agent") {
      if (type === "frame") lastFrame = payload
      else if (type === "state") lastState = payload
      else if (type === "focus") lastFocus = payload
      else if (type === "ended") {
        // Terminal: keep the ending for a late human, drop everything that
        // could show the logged-in page to whoever opens the link next.
        lastEnded = payload
        lastFrame = null
        lastState = null
        lastFocus = null
        pendingForAgent = null
      }
    } else if (type === "handback" || type === "abort") {
      // The human is done. Buffer this for an agent that is mid-reconnect, and
      // stop replaying the last (logged-in) frame to a late human.
      pendingForAgent = payload
      lastFrame = null
      lastState = null
      lastFocus = null
    }
  }
  // Newest frame wins: drop a frame bound for a backpressured receiver rather
  // than queue it in memory. Control and terminal messages are never dropped.
  if (type === "frame" && other?.backpressure) return
  write(other, payload, opcode)
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
    res.end(PAGE)
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

  const peer = { role, socket, open: true, backpressure: false }
  peers.set(role, peer)
  log("peer connected", { role })

  const read = createReader(
    (payload, opcode) => route(peer, payload, opcode),
    (payload) => write(peer, payload, OP_PONG),
    () => closePeer(peer, "peer closed the socket"),
  )
  peer.read = read
  if (head?.length) read(head)
  socket.on("data", read)
  socket.on("drain", () => {
    peer.backpressure = false
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
  log("relay listening", { port: bound?.port ?? PORT })
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
  canvas {
    width: 100%;
    height: 100%;
    touch-action: none;
    display: block;
    border-radius: var(--radius);
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
  #focus-ring {
    position: absolute;
    pointer-events: none;
    border: 2px solid var(--text);
    /* Most login pages are light, and a near-white ring on a white form is
       invisible. The 1px dark keyline outside it is not decoration: it is what
       makes the ring readable on a page whose colours we do not control. */
    outline: 1px solid var(--bg);
    border-radius: 2px;
    transition: left .12s ease, top .12s ease, width .12s ease, height .12s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    #focus-ring { transition: none; }
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
  /* Field and key bar on one line. The field takes the slack, the keys never
     shrink and never wrap: a wrapped key bar on a 320px phone would push the
     hint and the buttons below the fold. */
  .bar { display: flex; align-items: stretch; gap: 8px; }
  input {
    flex: 1 1 auto;
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
  .keys { display: flex; flex: none; gap: 6px; }
  /* 44 x 44: the minimum is a target, not a height. These four buttons exist
     because a phone's soft keyboard is unreliable, so they have to be the most
     reliable controls on the page. Muted weight so the bar does not compete
     with the hand-back button below it. */
  .key {
    flex: none;
    width: 44px;
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
     backspace can no longer empty the field. */
  #key-clear {
    width: auto;
    min-width: 44px;
    margin-left: 18px;
    padding: 0 8px;
    font-size: 13px;
  }
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
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
    /* Keep the safety, drop the motion: the hold still takes its 700ms, it
       just does not animate getting there. */
    .ghost::before { display: none; }
    .ghost[data-holding] { background: oklch(0.65 0.2 25 / 0.14); }
    #overlay { transition: opacity 150ms linear; }
    @starting-style {
      #overlay { opacity: 0; transform: none; }
    }
  }
</style>
</head>
<body>
  <header>
    <span id="dot" class="dot"></span>
    <div class="head-copy">
      <span class="eyebrow"><span class="mark">handraise</span> · an agent asked for your help</span>
      <span id="reason">Connecting to the browser…</span>
    </div>
  </header>
  <main id="stage">
    <canvas id="view"></canvas>
    <p id="placeholder">Waiting for the first frame…</p>
    <div id="focus-ring" hidden></div>
  </main>
  <footer>
    <div class="bar">
      <input id="kbd" type="text" autocomplete="off" autocapitalize="off" autocorrect="off"
        spellcheck="false" enterkeyhint="enter" placeholder="Type here">
      <div class="keys">
        <button id="key-back" class="key" type="button" aria-label="Delete one character">&#9003;</button>
        <button id="key-tab" class="key" type="button" aria-label="Next field">&#8677;</button>
        <button id="key-enter" class="key" type="button" aria-label="Enter">&#9166;</button>
        <button id="key-clear" class="key" type="button" aria-label="Clear the field" disabled>Clear</button>
      </div>
    </div>
    <p class="hint" id="hint">Typing goes straight to the browser</p>
    <div class="row">
      <button id="handback" class="primary" type="button">&#9995; Hand back</button>
      <button id="abort" class="ghost" type="button"><span class="ghost-label">I can't do this</span></button>
    </div>
  </footer>
  <div id="overlay" hidden>
    <h1 id="overlay-title"></h1>
    <p id="overlay-note"></p>
  </div>
<script>
(function () {
  var dot = document.getElementById("dot")
  var reason = document.getElementById("reason")
  var placeholder = document.getElementById("placeholder")
  var stage = document.getElementById("stage")
  var canvas = document.getElementById("view")
  var ctx = canvas.getContext("2d")
  var ring = document.getElementById("focus-ring")
  var hint = document.getElementById("hint")
  var kbd = document.getElementById("kbd")
  var overlay = document.getElementById("overlay")
  var overlayTitle = document.getElementById("overlay-title")
  var overlayNote = document.getElementById("overlay-note")

  var ws = null
  var retries = 0
  var finished = false
  var reconnectTimer = null
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
  var HINT_DEFAULT = "Typing goes straight to the browser"
  /** Long enough that a stray thumb cannot reach it, short enough to not annoy. */
  var HOLD_MS = 700
  var HOLD_HINT = "Hold the button to stop the agent"

  function send(message) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message))
  }

  function setStatus(live) {
    dot.className = live ? "dot" : "dot waiting"
    if (!live) reason.textContent = "Reconnecting…"
  }

  function render() {
    var rect = canvas.getBoundingClientRect()
    var dpr = window.devicePixelRatio || 1
    var w = Math.round(rect.width * dpr)
    var h = Math.round(rect.height * dpr)
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!frameW || !frameH || !rect.width) return
    var scale = Math.min(rect.width / frameW, rect.height / frameH)
    box = {
      w: frameW * scale,
      h: frameH * scale,
      x: (rect.width - frameW * scale) / 2,
      y: (rect.height - frameH * scale) / 2
    }
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(img, box.x * dpr, box.y * dpr, box.w * dpr, box.h * dpr)
    // The letterbox just moved, so the ring has to follow it.
    placeRing()
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
  function placeRing() {
    if (!focus || !focus.rect || !meta || !frameW || !frameH || !box.w) {
      ring.hidden = true
      return
    }
    var zoom = meta.pageScaleFactor > 0 ? meta.pageScaleFactor : 1
    var kx = (meta.jpegWidth / meta.deviceWidth) * zoom * (box.w / frameW)
    var ky = (meta.jpegHeight / meta.deviceHeight) * zoom * (box.h / frameH)
    if (!isFinite(kx) || !isFinite(ky) || kx <= 0 || ky <= 0) {
      ring.hidden = true
      return
    }
    // The ring is positioned against <main>, the canvas is centred inside it.
    var here = canvas.getBoundingClientRect()
    var host = stage.getBoundingClientRect()
    var rect = focus.rect
    ring.style.left = (here.left - host.left + box.x + rect.x * kx) + "px"
    ring.style.top = (here.top - host.top + box.y + rect.y * ky) + "px"
    ring.style.width = (rect.width * kx) + "px"
    ring.style.height = (rect.height * ky) + "px"
    ring.hidden = false
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
      label: typeof message.label === "string" ? message.label : null
    }
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

  function toFrame(clientX, clientY) {
    if (!frameW || !box.w) return null
    var rect = canvas.getBoundingClientRect()
    var x = ((clientX - rect.left - box.x) * frameW) / box.w
    var y = ((clientY - rect.top - box.y) * frameH) / box.h
    if (x < 0 || y < 0 || x > frameW || y > frameH) return null
    return { x: Math.round(x), y: Math.round(y) }
  }

  var press = null
  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId)
    press = { x: e.clientX, y: e.clientY, lastY: e.clientY, travel: 0, sentAt: 0 }
  })
  canvas.addEventListener("pointermove", function (e) {
    if (!press) return
    press.travel = Math.max(press.travel, Math.hypot(e.clientX - press.x, e.clientY - press.y))
    if (press.travel < 10 || !box.h) return
    var now = Date.now()
    if (now - press.sentAt < 60) return
    var stepped = e.clientY - press.lastY
    press.lastY = e.clientY
    press.sentAt = now
    // Direct manipulation: dragging the finger down reveals earlier content, so
    // the wheel delta the agent forwards is the inverse of the finger movement.
    var fdy = Math.round((-stepped * frameH) / box.h)
    if (fdy !== 0) send({ type: "scroll", fdy: fdy })
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

  canvas.addEventListener("pointerup", function (e) {
    var was = press
    press = null
    if (!was || was.travel >= 10) return
    var point = toFrame(e.clientX, e.clientY)
    if (!point) return
    send({ type: "tap", fx: point.x, fy: point.y })
    markTap(e.clientX, e.clientY)
  })
  canvas.addEventListener("pointercancel", function () { press = null })

  // The field is a local mirror only. Every keystroke leaves for the browser the
  // moment it is typed, so what the remote page shows is the real state.
  var mirrored = ""
  kbd.addEventListener("input", function () {
    var next = kbd.value
    var shared = 0
    while (shared < mirrored.length && shared < next.length && mirrored[shared] === next[shared]) {
      shared++
    }
    for (var back = mirrored.length; back > shared; back--) send({ type: "key", key: "Backspace" })
    for (var i = shared; i < next.length; i++) send({ type: "char", ch: next[i] })
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
      send({ type: "key", key: "Enter" })
      resetMirror()
      return
    }
    // An empty field fires no input event, so this is the only signal that the
    // human wants to delete a character the remote page still holds.
    if (e.key === "Backspace" && kbd.value === "") send({ type: "key", key: "Backspace" })
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
    send({ type: "key", key: "Backspace" })
  })
  var clearKey = keyButton("key-clear", function () {
    send({ type: "clear" })
    resetMirror()
  })
  // Tab moves to another field, Enter usually submits: either way what the
  // human types next belongs to a different context than what is mirrored here.
  keyButton("key-tab", function () {
    send({ type: "key", key: "Tab" })
    resetMirror()
  })
  keyButton("key-enter", function () {
    send({ type: "key", key: "Enter" })
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
    kbd.blur()
    if (ws) ws.close()
  }

  // The expected ending, and the only one whose worst case is recoverable in
  // spirit: the agent looks, fails and asks again. Confirming the happy path is
  // the classic mistake, so this stays a single tap.
  document.getElementById("handback").addEventListener("click", function () {
    send({ type: "handback" })
    finish(ENDINGS.resolved[0], ENDINGS.resolved[1])
  })

  /**
   * Giving up ends the handoff for good and there is nothing to undo — the
   * message leaves the socket and the agent settles on it immediately. So the
   * gesture costs more than a tap instead of a confirm dialog costing a screen.
   *
   * Pointer events only: they cover mouse, touch and pen with one stream, so
   * the hold cannot start twice from one finger.
   */
  var abortButton = document.getElementById("abort")
  var holdTimer = null
  var holdFired = false
  var hintTimer = null

  function flashHint(text) {
    hint.textContent = text
    if (hintTimer) clearTimeout(hintTimer)
    hintTimer = setTimeout(function () { hintTimer = null; setHint() }, 2200)
  }

  function startHold() {
    if (holdTimer || finished) return
    abortButton.dataset.holding = ""
    holdTimer = setTimeout(function () {
      holdTimer = null
      holdFired = true
      delete abortButton.dataset.holding
      if (navigator.vibrate) navigator.vibrate(20)
      send({ type: "abort" })
      finish("Thanks for looking", "The agent knows it can't be done here and will stop. You can close this tab.")
    }, HOLD_MS)
  }

  function cancelHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
    delete abortButton.dataset.holding
  }

  abortButton.addEventListener("pointerdown", startHold)
  abortButton.addEventListener("pointerup", cancelHold)
  abortButton.addEventListener("pointercancel", cancelHold)
  abortButton.addEventListener("pointerleave", cancelHold)
  // A keyboard has no press-and-hold of its own, so held Space or Enter is the
  // same contract. Without this the button is unreachable without a pointer.
  abortButton.addEventListener("keydown", function (e) {
    if (e.key !== " " && e.key !== "Enter") return
    e.preventDefault()
    if (!e.repeat) startHold()
  })
  abortButton.addEventListener("keyup", cancelHold)
  // A release always fires a click. After a completed hold that click is the
  // same gesture arriving twice; before 700ms it is a tap that did nothing, and
  // a tap that does nothing has to say why or the human thinks it is broken.
  abortButton.addEventListener("click", function () {
    if (holdFired) { holdFired = false; return }
    flashHint(HOLD_HINT)
  })

  var ENDINGS = {
    resolved: ["Thanks — that unblocked it", "The agent is driving again. You can close this tab."],
    aborted: ["Handoff ended", "You couldn't solve it here. Nothing more to do — you can close this tab."],
    timeout: ["Too late", "The agent gave up waiting. Nothing you can do here now."],
    disconnected: ["Connection ended", "The remote browser closed. The agent has been told — this wasn't anything you did."]
  }

  function handle(raw) {
    var message
    try { message = JSON.parse(raw) } catch (err) { return }
    if (!message) return
    if (message.type === "frame") showFrame(message.data, message.meta)
    else if (message.type === "state") reason.textContent = message.reason
    else if (message.type === "focus") {
      focus = readFocus(message)
      placeRing()
      setHint()
      setClearEnabled()
    }
    else if (message.type === "ended") {
      var ending = ENDINGS[message.outcome] || ["Session ended", "You can close this tab."]
      finish(ending[0], ending[1])
    }
  }

  // Close 1006 after 60s of silence is the preview proxy, not the human
  // leaving. Reconnecting is the normal path. One timer only, so a backoff and
  // a visibilitychange can never race into two overlapping sockets.
  function scheduleReconnect() {
    if (finished || reconnectTimer) return
    var wait = Math.min(500 * Math.pow(2, retries++), 8000)
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null
      connect()
    }, wait + Math.random() * 250)
  }

  function connect() {
    if (finished) return
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
      setStatus(true)
    }
    sock.onmessage = function (e) { if (mine === generation) handle(e.data) }
    sock.onclose = function () {
      // A stale socket (already superseded) must not touch shared state.
      if (mine !== generation) return
      ws = null
      if (finished) return
      setStatus(false)
      scheduleReconnect()
    }
    sock.onerror = function () { if (mine === generation) sock.close() }
  }

  setInterval(function () { send({ type: "ping" }) }, 20000)
  window.addEventListener("resize", render)
  // The stage also changes size without the window doing so: a longer reason
  // takes the header to its second line. The letterbox has to follow.
  if (window.ResizeObserver) new ResizeObserver(render).observe(stage)
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || finished) return
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
