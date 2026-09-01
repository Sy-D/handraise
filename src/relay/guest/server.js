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
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>handraise</title>
<style>
  /* cmpinf.com's dark palette, verbatim: monochrome at chroma 0 throughout,
     with exactly one colour in the whole interface — the destructive red on
     the "Can't help" button. oklch has shipped in every mobile browser that
     can run this page since 2023. */
  :root {
    --bg: oklch(0.11 0 0);
    --surface: oklch(0.145 0 0);
    --line: oklch(0.24 0 0);
    --field: oklch(0.26 0 0);
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
  body {
    display: flex;
    flex-direction: column;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
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
  }
  .dot::after {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 1px solid currentColor;
    color: var(--text);
    opacity: 0;
    animation: pulse 2s ease-out infinite;
  }
  .dot.waiting { background: var(--muted); }
  .dot.waiting::after { color: var(--muted); animation-duration: .9s; }
  .dot.dead { background: var(--danger); }
  .dot.dead::after { animation: none; }
  @keyframes pulse {
    0% { transform: scale(.6); opacity: .9; }
    100% { transform: scale(1.6); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot::after { animation: none; }
  }
  #reason {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    padding: 10px;
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
  }
  footer {
    border-top: 1px solid var(--line);
    background: var(--surface);
    padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  }
  input {
    width: 100%;
    padding: 12px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--field);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 16px;
  }
  input:focus { outline: none; border-color: oklch(0.44 0 0); }
  .hint {
    margin: 7px 2px 10px;
    color: var(--muted);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row { display: flex; align-items: center; gap: 10px; }
  button { font: inherit; font-weight: 600; border-radius: var(--radius); cursor: pointer; }
  /* Inverted, the way shadcn's dark primary is: near-white on near-black. */
  .primary {
    flex: 1 1 auto;
    padding: 13px 16px;
    border: none;
    background: var(--text);
    color: oklch(0.205 0 0);
    letter-spacing: -0.01em;
  }
  .primary:active { background: oklch(0.9 0 0); }
  .ghost {
    flex: none;
    padding: 13px 14px;
    border: 1px solid var(--field);
    background: transparent;
    color: var(--danger);
    font-weight: 500;
  }
  .ghost:active { border-color: var(--danger); background: oklch(0.65 0.2 25 / 0.1); }
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
  }
  #overlay[hidden] { display: none; }
  #overlay h1 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
  #overlay p { margin: 0; color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
  <header>
    <span id="dot" class="dot"></span>
    <span id="reason">Connecting to the browser…</span>
  </header>
  <main id="stage">
    <canvas id="view"></canvas>
    <p id="placeholder">Waiting for the first frame…</p>
    <div id="focus-ring" hidden></div>
  </main>
  <footer>
    <input id="kbd" type="text" autocomplete="off" autocapitalize="off" autocorrect="off"
      spellcheck="false" enterkeyhint="enter" placeholder="Type here">
    <p class="hint" id="hint">Typing goes straight to the browser</p>
    <div class="row">
      <button id="handback" class="primary">&#9995; Hand back to agent</button>
      <button id="abort" class="ghost">Can't help</button>
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
  canvas.addEventListener("pointerup", function (e) {
    var was = press
    press = null
    if (!was || was.travel >= 10) return
    var point = toFrame(e.clientX, e.clientY)
    if (point) send({ type: "tap", fx: point.x, fy: point.y })
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
  kbd.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault()
      send({ type: "key", key: "Enter" })
      kbd.value = ""
      mirrored = ""
      return
    }
    // An empty field fires no input event, so this is the only signal that the
    // human wants to delete a character the remote page still holds.
    if (e.key === "Backspace" && kbd.value === "") send({ type: "key", key: "Backspace" })
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
    kbd.blur()
    if (ws) ws.close()
  }

  document.getElementById("handback").addEventListener("click", function () {
    send({ type: "handback" })
    finish("Handed back", "You can close this tab.")
  })
  document.getElementById("abort").addEventListener("click", function () {
    send({ type: "abort" })
    finish("Told the agent", "It knows you couldn't help and will stop waiting. You can close this tab.")
  })

  var ENDINGS = {
    resolved: ["Handed back", "The agent is driving again."],
    aborted: ["Handoff ended", "The helper couldn't solve it. You can close this tab."],
    timeout: ["The agent stopped waiting", "Nobody picked this up in time."],
    disconnected: ["Session lost", "The browser session died. The agent knows."]
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
