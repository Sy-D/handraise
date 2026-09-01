/**
 * RFC 6238 TOTP (and the RFC 4226 HOTP underneath it) in ~100 lines of
 * `node:crypto`. No dependency, because the e2e's scripted "human" needs to
 * compute the same code the test app expects, and pulling an npm package in for
 * six digits of HMAC would be silly.
 *
 * Mirrors test-app/guest/app.js exactly: SHA-1, 30-second step, 6 digits,
 * +/-1 step of clock tolerance on verification.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** Default TOTP parameters, matching Google Authenticator and the test app. */
export const DEFAULT_DIGITS = 6
export const DEFAULT_STEP_SECONDS = 30

export interface TotpOptions {
  /** Point in time to generate for. Default: now. */
  atMs?: number
  /** Number of digits in the code. Default: 6. */
  digits?: number
  /** Length of one time step in seconds. Default: 30. */
  stepSeconds?: number
}

export interface VerifyTotpOptions extends TotpOptions {
  /** How many steps of clock drift to accept either side. Default: 1. */
  window?: number
}

/** Encode bytes as an unpadded RFC 4648 base32 string. */
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

/** Decode an RFC 4648 base32 string. Padding and whitespace are tolerated. */
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

/** A fresh random base32 secret. 20 bytes is what RFC 4226 recommends for SHA-1. */
export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength))
}

/** RFC 4226 HOTP for an already-decoded key. */
export function hotp(
  key: Uint8Array,
  counter: number,
  digits = DEFAULT_DIGITS,
): string {
  const message = Buffer.alloc(8)
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  message.writeUInt32BE(counter >>> 0, 4)
  const mac = createHmac("sha1", key).update(message).digest()
  const offset = mac.readUInt8(mac.length - 1) & 0x0f
  const truncated = mac.readUInt32BE(offset) & 0x7fffffff
  return String(truncated % 10 ** digits).padStart(digits, "0")
}

/** The time step a moment falls into. */
export function totpCounter(
  atMs: number = Date.now(),
  stepSeconds = DEFAULT_STEP_SECONDS,
): number {
  return Math.floor(atMs / 1000 / stepSeconds)
}

/** The current TOTP code for a base32 secret. */
export function totp(secret: string, options: TotpOptions = {}): string {
  const stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS
  const counter = totpCounter(options.atMs ?? Date.now(), stepSeconds)
  return hotp(base32Decode(secret), counter, options.digits ?? DEFAULT_DIGITS)
}

/**
 * Milliseconds until the current code expires.
 *
 * The e2e uses this: a human handoff that starts 400 ms before a step boundary
 * types a code that is already stale by the time it lands. Wait it out.
 */
export function msUntilNextStep(
  atMs: number = Date.now(),
  stepSeconds = DEFAULT_STEP_SECONDS,
): number {
  const stepMs = stepSeconds * 1000
  return stepMs - (atMs % stepMs)
}

/** Verify a code the way the test app does: constant-time, +/-1 step by default. */
export function verifyTotp(
  secret: string,
  candidate: string,
  options: VerifyTotpOptions = {},
): boolean {
  const digits = options.digits ?? DEFAULT_DIGITS
  if (!new RegExp(`^[0-9]{${digits}}$`).test(candidate)) return false
  const stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS
  const window = options.window ?? 1
  const key = base32Decode(secret)
  const counter = totpCounter(options.atMs ?? Date.now(), stepSeconds)
  const candidateBytes = Buffer.from(candidate, "utf8")
  let matched = false
  for (let drift = -window; drift <= window; drift++) {
    const expected = Buffer.from(hotp(key, counter + drift, digits), "utf8")
    // No short-circuit: every window in range costs the same time.
    if (timingSafeEqual(expected, candidateBytes)) matched = true
  }
  return matched
}
