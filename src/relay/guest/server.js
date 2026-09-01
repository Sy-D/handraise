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

const PONG = JSON.stringify({ type: "pong" })

/** role -> peer. At most one connection per role; a new one replaces the old. */
const peers = new Map()

/** Replay buffer for a human who joins (or rejoins) after the agent started. */
let lastState = null
let lastFrame = null

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
      } else {
        fragments = [payload]
        fragmentOpcode = opcode
      }
      if (!fin) continue
      const complete =
        fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
      fragments = []
      onMessage(complete, fragmentOpcode)
    }
  }
}

function write(peer, payload, opcode) {
  if (!peer?.open) return
  peer.socket.write(encodeFrame(payload, opcode))
}

function sendText(peer, text) {
  write(peer, Buffer.from(text, "utf8"), OP_TEXT)
}

function closePeer(peer, reason) {
  if (!peer.open) return
  peer.open = false
  if (peers.get(peer.role) === peer) peers.delete(peer.role)
  try {
    peer.socket.write(encodeFrame(Buffer.alloc(0), OP_CLOSE))
  } catch {
    // the socket is already gone; nothing left to say on it
  }
  peer.socket.end()
  log("peer closed", { role: peer.role, reason })
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
  const other = peers.get(peer.role === "agent" ? "human" : "agent")
  if (opcode === OP_TEXT) {
    const type = messageType(payload)
    if (type === "ping") {
      sendText(peer, PONG)
      return
    }
    if (peer.role === "agent") {
      if (type === "frame") lastFrame = payload
      else if (type === "state") lastState = payload
      else if (type === "ended") {
        lastFrame = null
        lastState = null
      }
    }
  }
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

  const peer = { role, socket, open: true }
  peers.set(role, peer)
  log("peer connected", { role })

  const read = createReader(
    (payload, opcode) => route(peer, payload, opcode),
    (payload) => write(peer, payload, OP_PONG),
    () => closePeer(peer, "peer closed the socket"),
  )
  if (head?.length) read(head)
  socket.on("data", read)
  socket.on("error", () => closePeer(peer, "socket error"))
  socket.on("close", () => closePeer(peer, "socket closed"))

  // Late join: a human who opens the page mid-handoff must not stare at a blank
  // canvas until the next repaint — an idle page can go seconds without one.
  if (role === "human") {
    if (lastState) write(peer, lastState, OP_TEXT)
    if (lastFrame) write(peer, lastFrame, OP_TEXT)
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
  :root {
    --bg: #08090b;
    --surface: #101216;
    --line: #1e2127;
    --text: #e7e9ec;
    --muted: #8b919b;
    --live: #34d399;
    --wait: #fbbf24;
    --danger: #f87171;
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
    background: var(--live);
  }
  .dot::after {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 1px solid currentColor;
    color: var(--live);
    opacity: 0;
    animation: pulse 2s ease-out infinite;
  }
  .dot.waiting { background: var(--wait); }
  .dot.waiting::after { color: var(--wait); animation-duration: .9s; }
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
    border-radius: 10px;
  }
  #placeholder {
    position: absolute;
    color: var(--muted);
    font-size: 14px;
    pointer-events: none;
  }
  footer {
    border-top: 1px solid var(--line);
    background: var(--surface);
    padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
  }
  input {
    width: 100%;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: #0b0d10;
    color: var(--text);
    font: inherit;
    font-size: 16px;
  }
  input:focus { outline: none; border-color: #39404a; }
  .hint { margin: 7px 2px 10px; color: var(--muted); font-size: 12.5px; }
  .row { display: flex; align-items: center; gap: 10px; }
  button { font: inherit; font-weight: 600; border-radius: 10px; cursor: pointer; }
  .primary {
    flex: 1 1 auto;
    padding: 13px 16px;
    border: none;
    background: var(--live);
    color: #04180f;
    letter-spacing: -0.01em;
  }
  .primary:active { background: #2bbb87; }
  .ghost {
    flex: none;
    padding: 13px 14px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--danger);
    font-weight: 500;
  }
  .ghost:active { background: rgba(248, 113, 113, .1); }
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
    background: rgba(8, 9, 11, .92);
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
  <main>
    <canvas id="view"></canvas>
    <p id="placeholder">Waiting for the first frame…</p>
  </main>
  <footer>
    <input id="kbd" type="text" autocomplete="off" autocapitalize="off" autocorrect="off"
      spellcheck="false" enterkeyhint="enter" placeholder="Type here">
    <p class="hint">Typing goes straight to the browser</p>
    <div class="row">
      <button id="handback" class="primary">&#9995; Hand back to agent</button>
      <button id="abort" class="ghost">Abort</button>
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
  var canvas = document.getElementById("view")
  var ctx = canvas.getContext("2d")
  var kbd = document.getElementById("kbd")
  var overlay = document.getElementById("overlay")
  var overlayTitle = document.getElementById("overlay-title")
  var overlayNote = document.getElementById("overlay-note")

  var ws = null
  var retries = 0
  var finished = false

  var img = new Image()
  var queued = null
  var decoding = false
  var frameW = 0
  var frameH = 0
  var box = { x: 0, y: 0, w: 0, h: 0 }

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
  function showFrame(data) {
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
    kbd.blur()
    if (ws) ws.close()
  }

  document.getElementById("handback").addEventListener("click", function () {
    send({ type: "handback" })
    finish("Handed back", "You can close this tab.")
  })
  document.getElementById("abort").addEventListener("click", function () {
    send({ type: "abort" })
    finish("Aborted", "You can close this tab.")
  })

  var ENDINGS = {
    resolved: ["Handed back", "The agent is driving again."],
    aborted: ["Aborted", "You can close this tab."],
    timeout: ["The agent stopped waiting", "Nobody picked this up in time."],
    disconnected: ["Session lost", "The browser session died. The agent knows."]
  }

  function handle(raw) {
    var message
    try { message = JSON.parse(raw) } catch (err) { return }
    if (!message) return
    if (message.type === "frame") showFrame(message.data)
    else if (message.type === "state") reason.textContent = message.reason
    else if (message.type === "ended") {
      var ending = ENDINGS[message.outcome] || ["Session ended", "You can close this tab."]
      finish(ending[0], ending[1])
    }
  }

  function connect() {
    if (finished) return
    var scheme = location.protocol === "https:" ? "wss:" : "ws:"
    // Relative: the ?pt_token= on the page URL already earned a __pt_preview
    // cookie, which authenticates this upgrade without carrying the token again.
    ws = new WebSocket(scheme + "//" + location.host + "/ws?role=human")
    ws.onopen = function () {
      retries = 0
      setStatus(true)
    }
    ws.onmessage = function (e) { handle(e.data) }
    ws.onclose = function () {
      ws = null
      if (finished) return
      setStatus(false)
      // Close 1006 after 60s of silence is the preview proxy, not the human
      // leaving. Reconnecting is the normal path, not the error path.
      var wait = Math.min(500 * Math.pow(2, retries++), 8000)
      setTimeout(connect, wait + Math.random() * 250)
    }
    ws.onerror = function () { if (ws) ws.close() }
  }

  setInterval(function () { send({ type: "ping" }) }, 20000)
  window.addEventListener("resize", render)
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !ws && !finished) {
      retries = 0
      connect()
    }
  })
  connect()
})()
</script>
</body>
</html>
`
