// In-guest echo server: WS + SSE + plain HTTP on ONE port.
// Node 18 stdlib only (no `ws` dependency). RFC6455 framing done by hand.
const http = require("node:http")
const crypto = require("node:crypto")

const PORT = Number(process.argv[2] || 3000)
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

function encodeFrame(payload, opcode = 0x1) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const len = buf.length
  let head
  if (len < 126) head = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, buf])
}

// Minimal frame reader. Handles masking, 3 length forms, ping/close.
// (No fragmentation reassembly — the test client does not fragment.)
function makeReader(onMessage, onClose, sock) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        off = 10
      }
      const maskKey = masked ? buf.subarray(off, off + 4) : null
      if (masked) off += 4
      if (buf.length < off + len) return
      const payload = Buffer.from(buf.subarray(off, off + len))
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
      buf = buf.subarray(off + len)
      if (opcode === 0x8) return onClose()
      if (opcode === 0x9) { sock.write(encodeFrame(payload, 0xa)); continue }
      if (opcode === 0xa) continue
      onMessage(payload, opcode)
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x")
  if (url.pathname === "/ping") {
    const body = JSON.stringify({ t: Date.now(), port: PORT, echo: url.searchParams.get("n") })
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
    return res.end(body)
  }
  if (url.pathname === "/sse") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // ask nginx-ish proxies not to buffer
    })
    res.write(": open\n\n")
    let i = 0
    const iv = setInterval(() => {
      i++
      res.write(`id: ${i}\nevent: tick\ndata: ${JSON.stringify({ i, t: Date.now() })}\n\n`)
      if (i >= 200) { clearInterval(iv); res.end() }
    }, 250)
    req.on("close", () => clearInterval(iv))
    return
  }
  if (url.pathname === "/sse-big") {
    // SSE carrying a ~40 KB payload per event (screenshot-sized)
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" })
    const blob = "x".repeat(40 * 1024)
    let i = 0
    const iv = setInterval(() => {
      i++
      res.write(`event: frame\ndata: ${JSON.stringify({ i, t: Date.now(), blob })}\n\n`)
      if (i >= 20) { clearInterval(iv); res.end() }
    }, 200)
    req.on("close", () => clearInterval(iv))
    return
  }
  res.writeHead(200, { "content-type": "text/plain" })
  res.end(`handraise s1 echo server on ${PORT}\n`)
})

server.on("upgrade", (req, sock, head) => {
  const key = req.headers["sec-websocket-key"]
  if (!key) { sock.destroy(); return }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64")
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  sock.setNoDelay(true)
  const read = makeReader(
    (payload, opcode) => sock.write(encodeFrame(payload, opcode)),
    () => { sock.write(encodeFrame(Buffer.alloc(0), 0x8)); sock.end() },
    sock,
  )
  if (head && head.length) read(head)
  sock.on("data", read)
  sock.on("error", () => sock.destroy())
  // /ws-quiet: no traffic at all, to measure the proxy's real idle timeout
  if ((req.url || "").startsWith("/ws-quiet")) return
  // server-pushed ticks, to prove the proxy does not buffer server->client
  const iv = setInterval(() => sock.write(encodeFrame(JSON.stringify({ push: Date.now() }))), 500)
  sock.on("close", () => clearInterval(iv))
})

server.listen(PORT, "0.0.0.0", () => console.log("listening", PORT))
