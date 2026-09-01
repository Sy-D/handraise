/**
 * The demo portal behind `npx handraise`: one page with a 2FA wall, plus the
 * RFC 6238 maths the CLI needs to print the code that opens it.
 *
 * Why this file exists at all. The repo already has a richer target in
 * `test-app/`, but `test-app/` is not in the published package — `files` ships
 * `dist` only. A reviewer who runs `npx handraise` downloads the tarball and
 * nothing else, so the demo has to carry its own target. Hence a radically
 * reduced copy: one route, no login step, no cookies, no session.
 *
 * The server below is a JavaScript string, not a module. `startPortal()` in
 * cli.ts writes it into a Solari sandbox and starts it with the guest's own
 * Node 18, so it must be valid ESM with ZERO dependencies. It is written with
 * quoted strings and `+` rather than template literals for one blunt reason:
 * every backtick and every `${` in here would need escaping to survive the
 * TypeScript template literal that holds it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/** The port the portal listens on inside the sandbox, and the one we preview. */
export const PORTAL_PORT = 4100

/** RFC 4648 base32, the alphabet every authenticator app speaks. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** SHA-1, 6 digits, 30-second step: the parameters the portal below verifies. */
const DIGITS = 6
const STEP_SECONDS = 30

/** Encode bytes as an unpadded base32 string. */
export function base32Encode(bytes: Uint8Array): string {
  let out = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET.charAt((buffer >>> bits) & 0x1f)
    }
  }
  if (bits > 0) out += BASE32_ALPHABET.charAt((buffer << (5 - bits)) & 0x1f)
  return out
}

/** Decode an unpadded or padded base32 string back to bytes. */
export function base32Decode(secret: string): Uint8Array {
  const clean = secret.replace(/[\s=]/g, "").toUpperCase()
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`invalid base32 character: ${char}`)
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

/** A fresh secret for one demo run. 20 bytes is the RFC 4226 recommendation. */
export function generatePortalSecret(): string {
  return base32Encode(randomBytes(20))
}

/** RFC 4226 HOTP over an already-decoded key. */
export function hotp(key: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  message.writeUInt32BE(counter >>> 0, 4)
  const mac = createHmac("sha1", key).update(message).digest()
  const offset = mac.readUInt8(mac.length - 1) & 0x0f
  const truncated = mac.readUInt32BE(offset) & 0x7fffffff
  return String(truncated % 10 ** DIGITS).padStart(DIGITS, "0")
}

/** The code a phone would show for `secret` at `atMs`. */
export function totp(secret: string, atMs: number = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(atMs / 1000 / STEP_SECONDS))
}

/**
 * Milliseconds until the current code expires.
 *
 * The CLI reprints on this boundary rather than on a fixed interval: a code
 * printed 2 seconds before it rolls over is a code the human types too late.
 */
export function msUntilNextCode(atMs: number = Date.now()): number {
  const stepMs = STEP_SECONDS * 1000
  return stepMs - (atMs % stepMs)
}

/** Verify the way the portal does: constant-time, +/-1 step of clock drift. */
export function verifyTotp(
  secret: string,
  candidate: string,
  atMs: number = Date.now(),
): boolean {
  if (!/^[0-9]{6}$/.test(candidate)) return false
  const key = base32Decode(secret)
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS)
  const candidateBytes = Buffer.from(candidate, "utf8")
  let matched = false
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(key, counter + drift), "utf8")
    // No short-circuit: every window in range costs the same time.
    if (timingSafeEqual(expected, candidateBytes)) matched = true
  }
  return matched
}

/**
 * The whole portal: `GET /` asks for six digits, `POST /` checks them,
 * `GET /healthz` says `ok` so the deploy knows the public URL is live.
 *
 * There is no cookie and no session. The success page is the POST response
 * itself, which is all the demo needs: the CLI looks for
 * `[data-testid="signed-in"]` on the page it handed over, right after the
 * human hands it back.
 */
export const PORTAL_SERVER_JS = `/**
 * handraise demo portal — deployed into a Solari sandbox by "npx handraise".
 * Node 18, ESM, zero dependencies. Do not add an import.
 */
import crypto from "node:crypto"
import http from "node:http"

const PORT = Number(process.env.PORT || 4100)
const SECRET = process.env.TOTP_SECRET || ""
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const MAX_BODY_BYTES = 4 * 1024

function base32Decode(input) {
  const clean = input.replace(/[\\s=]/g, "").toUpperCase()
  const bytes = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error("invalid base32 character")
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

function hotp(key, counter) {
  const message = Buffer.alloc(8)
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  message.writeUInt32BE(counter >>> 0, 4)
  const mac = crypto.createHmac("sha1", key).update(message).digest()
  const offset = mac.readUInt8(mac.length - 1) & 0x0f
  const truncated = mac.readUInt32BE(offset) & 0x7fffffff
  return String(truncated % 1000000).padStart(6, "0")
}

/** RFC 6238: SHA-1, 30-second step, plus or minus one step of clock drift. */
function verifyTotp(candidate) {
  if (!/^[0-9]{6}$/.test(candidate)) return false
  const key = base32Decode(SECRET)
  const step = Math.floor(Date.now() / 1000 / 30)
  const given = Buffer.from(candidate, "utf8")
  let matched = false
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(key, step + drift), "utf8")
    // Constant time, and never short-circuit: every window costs the same.
    if (crypto.timingSafeEqual(expected, given)) matched = true
  }
  return matched
}

const STYLES = [
  ":root{color-scheme:light}*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f8;color:#12151a;",
  "font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}",
  ".card{width:min(360px,calc(100vw - 32px));background:#fff;padding:28px;border:1px solid #e4e7eb;border-radius:12px;",
  "box-shadow:0 1px 2px rgba(16,24,40,.04),0 10px 28px rgba(16,24,40,.06)}",
  ".brand{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:-.01em;margin-bottom:22px}",
  ".brand i{width:10px;height:10px;border-radius:50%;background:#2f6df6}",
  "h1{font-size:19px;margin:0 0 4px;letter-spacing:-.015em}",
  ".sub{margin:0 0 20px;color:#5b6472;font-size:14px}",
  "label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}",
  "input{width:100%;padding:10px 12px;font-size:20px;text-align:center;letter-spacing:.35em;",
  "font-variant-numeric:tabular-nums;border:1px solid #d4d9df;border-radius:8px;background:#fff;color:inherit}",
  "input:focus{outline:2px solid #2f6df6;outline-offset:-1px;border-color:#2f6df6}",
  "button{width:100%;margin-top:14px;padding:11px 12px;font:inherit;font-weight:500;color:#fff;",
  "background:#12151a;border:0;border-radius:8px;cursor:pointer}",
  ".error{margin-bottom:16px;padding:9px 12px;font-size:13px;color:#9f1239;background:#fef2f2;",
  "border:1px solid #fecdd3;border-radius:8px}",
  ".ok{display:inline-block;margin-bottom:16px;padding:3px 9px;font-size:12px;font-weight:500;color:#065f46;",
  "background:#ecfdf5;border:1px solid #a7f3d0;border-radius:999px}",
  ".foot{margin-top:18px;font-size:12px;color:#8b939f;text-align:center}",
].join("")

function page(title, inner) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + title + " \\u2014 Aurora Bank</title><style>" + STYLES + "</style></head>" +
    '<body><main class="card"><div class="brand"><i></i>Aurora Bank</div>' + inner +
    '<p class="foot">Demo target for handraise. Not a real bank.</p></main></body></html>'
}

function askPage(error) {
  const box = error
    ? '<p class="error" data-testid="error" role="alert">' + error + "</p>"
    : ""
  return page(
    "Two-factor",
    "<h1>Two-factor authentication</h1>" +
      '<p class="sub">Enter the 6-digit code from your authenticator app.</p>' +
      box +
      '<form method="post" action="/" data-testid="totp-form">' +
      '<label for="code">Authentication code</label>' +
      '<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" ' +
      'pattern="[0-9]{6}" maxlength="6" placeholder="000000" data-testid="totp-code" required autofocus>' +
      '<button type="submit" data-testid="totp-submit">Verify</button></form>',
  )
}

function donePage() {
  return page(
    "Signed in",
    '<p class="ok" data-testid="verified">Two-factor verified</p>' +
      '<h1 data-testid="signed-in">Signed in as ada</h1>' +
      '<p class="sub">A human did the one step the agent could not. It can drive again.</p>',
  )
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" })
  res.end(body)
  return status
}

async function route(req, res, url) {
  const method = req.method || "GET"
  if (url.pathname === "/healthz") return send(res, 200, "text/plain; charset=utf-8", "ok")
  if (url.pathname === "/" && method === "GET") {
    return send(res, 200, "text/html; charset=utf-8", askPage(null))
  }
  if (url.pathname === "/" && method === "POST") {
    const code = (new URLSearchParams(await readBody(req)).get("code") || "").trim()
    const ok = verifyTotp(code)
    if (!ok) {
      return send(res, 401, "text/html; charset=utf-8", askPage("That code is not valid. Try again."))
    }
    return send(res, 200, "text/html; charset=utf-8", donePage())
  }
  return send(res, 404, "text/html; charset=utf-8", page("Not found", "<h1>Page not found</h1>"))
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now()
  const url = new URL(req.url || "/", "http://localhost")
  const event = { evt: "http_request", method: req.method, path: url.pathname }
  route(req, res, url)
    .then((status) => {
      event.status = status
    })
    .catch((error) => {
      event.status = 500
      event.error = String(error && error.message ? error.message : error)
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "internal error")
    })
    .finally(() => {
      event.duration_ms = Date.now() - startedAt
      console.log(JSON.stringify(event))
    })
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ evt: "listening", port: PORT }))
})
`
