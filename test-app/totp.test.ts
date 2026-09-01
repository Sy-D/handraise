import { describe, expect, test } from "bun:test"
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  msUntilNextStep,
  totp,
  totpCounter,
  verifyTotp,
} from "./totp"

/** RFC 6238 Appendix B seed for SHA-1: the ASCII string "12345678901234567890". */
const RFC_SEED_ASCII = "12345678901234567890"
const RFC_SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

/** RFC 6238 Appendix B, SHA-1 rows: [unix seconds, 8-digit TOTP]. */
const RFC_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
]

describe("base32", () => {
  test("encodes the RFC seed to the well-known base32 string", () => {
    expect(base32Encode(Buffer.from(RFC_SEED_ASCII, "utf8"))).toBe(
      RFC_SEED_BASE32,
    )
  })

  test("decodes back to the original bytes", () => {
    expect(Buffer.from(base32Decode(RFC_SEED_BASE32)).toString("utf8")).toBe(
      RFC_SEED_ASCII,
    )
  })

  test("tolerates padding, lowercase and whitespace", () => {
    const padded = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq=="
    expect(Buffer.from(base32Decode(padded))).toEqual(
      Buffer.from(base32Decode(RFC_SEED_BASE32)),
    )
  })

  test("round-trips arbitrary byte lengths", () => {
    for (let length = 1; length <= 24; length++) {
      const bytes = new Uint8Array(length).map(
        (_, index) => (index * 37 + length) & 0xff,
      )
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes)
    }
  })

  test("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("ABC1")).toThrow(/invalid base32/)
  })
})

describe("RFC 6238 test vectors (SHA-1)", () => {
  for (const [unixSeconds, expected8] of RFC_VECTORS) {
    test(`T=${unixSeconds} -> ${expected8}`, () => {
      const atMs = unixSeconds * 1000
      expect(totp(RFC_SEED_BASE32, { atMs, digits: 8 })).toBe(expected8)
      // A 6-digit code is the same truncated binary taken mod 10^6, which is
      // exactly the last six digits of the 8-digit code.
      expect(totp(RFC_SEED_BASE32, { atMs })).toBe(expected8.slice(-6))
    })
  }

  test("the counter is the 30-second step, and the high 32-bit word is used", () => {
    expect(totpCounter(59_000)).toBe(1)
    expect(totpCounter(20_000_000_000_000)).toBe(666_666_666)
    // Counter above 2^32 exercises the high word of the 8-byte HOTP message.
    const key = base32Decode(RFC_SEED_BASE32)
    expect(hotp(key, 2 ** 32 + 1)).not.toBe(hotp(key, 1))
  })
})

describe("verifyTotp", () => {
  const secret = generateTotpSecret()

  test("accepts the current code", () => {
    const now = Date.now()
    expect(verifyTotp(secret, totp(secret, { atMs: now }), { atMs: now })).toBe(
      true,
    )
  })

  test("accepts one step of drift either side", () => {
    const now = Date.now()
    for (const drift of [-30_000, 30_000]) {
      const code = totp(secret, { atMs: now + drift })
      expect(verifyTotp(secret, code, { atMs: now })).toBe(true)
    }
  })

  test("rejects two steps of drift", () => {
    const now = Date.now()
    for (const drift of [-60_000, 60_000]) {
      const code = totp(secret, { atMs: now + drift })
      expect(verifyTotp(secret, code, { atMs: now })).toBe(false)
    }
  })

  test("rejects another secret's code", () => {
    const now = Date.now()
    expect(
      verifyTotp(secret, totp(generateTotpSecret(), { atMs: now }), {
        atMs: now,
      }),
    ).toBe(false)
  })

  test("rejects malformed input without throwing", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56"]) {
      expect(verifyTotp(secret, bad)).toBe(false)
    }
  })
})

describe("secrets and timing", () => {
  test("generateTotpSecret returns 20 decodable bytes and is not constant", () => {
    const secret = generateTotpSecret()
    expect(base32Decode(secret)).toHaveLength(20)
    expect(secret).not.toBe(generateTotpSecret())
  })

  test("msUntilNextStep counts down inside the step", () => {
    expect(msUntilNextStep(0)).toBe(30_000)
    expect(msUntilNextStep(29_000)).toBe(1_000)
    expect(msUntilNextStep(30_000)).toBe(30_000)
    const now = Date.now()
    expect(totp(secretFor(now), { atMs: now })).toBe(
      totp(secretFor(now), { atMs: now + msUntilNextStep(now) - 1 }),
    )
  })
})

/** One stable secret per timestamp, so the assertion above compares like with like. */
function secretFor(atMs: number): string {
  return base32Encode(Buffer.from(String(atMs).padStart(20, "0"), "utf8"))
}
