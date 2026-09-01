/**
 * The demo portal's maths, and the contract between the two copies of it.
 *
 * The TOTP code is the one number in `npx handraise` that has to be right:
 * the terminal prints it, a human types it on a phone, and a *second*
 * implementation — the JavaScript string in PORTAL_SERVER_JS, running inside
 * the sandbox — decides whether it is correct. Two implementations of the same
 * RFC is exactly the shape of bug that survives a green typecheck, so both are
 * pinned to RFC 6238's own vectors here.
 */
import { describe, expect, test } from "bun:test"
import {
  base32Decode,
  base32Encode,
  generatePortalSecret,
  hotp,
  msUntilNextCode,
  PORTAL_SERVER_JS,
  totp,
  verifyTotp,
} from "./cli-guest"

/** RFC 6238 Appendix B seed for SHA-1: the ASCII string "12345678901234567890". */
const RFC_SEED_ASCII = "12345678901234567890"
const RFC_SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

/**
 * RFC 6238 Appendix B, SHA-1 rows: [unix seconds, 8-digit TOTP].
 *
 * The portal is a 6-digit app, and `truncated % 10 ** 6` is the last six digits
 * of `truncated % 10 ** 8`, so the expected 6-digit code is the tail of each
 * published vector.
 */
const RFC_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
]

const STEP_MS = 30_000

describe("base32", () => {
  test("encodes the RFC seed to the well-known base32 string", () => {
    expect(base32Encode(Buffer.from(RFC_SEED_ASCII, "utf8"))).toBe(
      RFC_SEED_BASE32,
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

  test("tolerates padding, lowercase and whitespace", () => {
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==")).toEqual(
      base32Decode(RFC_SEED_BASE32),
    )
  })

  test("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("ABC1")).toThrow(/invalid base32/)
  })
})

describe("totp", () => {
  test("matches every RFC 6238 SHA-1 vector", () => {
    for (const [unixSeconds, eightDigits] of RFC_VECTORS) {
      expect(totp(RFC_SEED_BASE32, unixSeconds * 1000)).toBe(
        eightDigits.slice(-6),
      )
    }
  })

  test("hotp matches the RFC 4226 counter values behind those vectors", () => {
    const key = base32Decode(RFC_SEED_BASE32)
    for (const [unixSeconds, eightDigits] of RFC_VECTORS) {
      expect(hotp(key, Math.floor(unixSeconds / 30))).toBe(
        eightDigits.slice(-6),
      )
    }
  })

  test("holds the same code for a whole 30-second step, then changes", () => {
    const at = 1_700_000_010_000
    const stepStart = at - (at % STEP_MS)
    expect(totp(RFC_SEED_BASE32, stepStart)).toBe(
      totp(RFC_SEED_BASE32, stepStart + STEP_MS - 1),
    )
    expect(totp(RFC_SEED_BASE32, stepStart)).not.toBe(
      totp(RFC_SEED_BASE32, stepStart + STEP_MS),
    )
  })

  test("msUntilNextCode counts down to the step boundary", () => {
    // 1_700_000_010_000 is exactly divisible by 30_000: a step boundary.
    expect(msUntilNextCode(1_700_000_010_000)).toBe(STEP_MS)
    expect(msUntilNextCode(1_700_000_010_000 + 11_000)).toBe(STEP_MS - 11_000)
  })

  test("generatePortalSecret returns a fresh 160-bit base32 secret", () => {
    const secret = generatePortalSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(secret).not.toBe(generatePortalSecret())
  })
})

describe("verifyTotp", () => {
  const at = 1_700_000_010_000

  test("accepts the current code", () => {
    expect(verifyTotp(RFC_SEED_BASE32, totp(RFC_SEED_BASE32, at), at)).toBe(
      true,
    )
  })

  test("accepts one step of drift either way, so a slow thumb still lands", () => {
    for (const drift of [-STEP_MS, STEP_MS]) {
      expect(
        verifyTotp(RFC_SEED_BASE32, totp(RFC_SEED_BASE32, at + drift), at),
      ).toBe(true)
    }
  })

  test("rejects two steps of drift", () => {
    for (const drift of [-2 * STEP_MS, 2 * STEP_MS]) {
      expect(
        verifyTotp(RFC_SEED_BASE32, totp(RFC_SEED_BASE32, at + drift), at),
      ).toBe(false)
    }
  })

  test("rejects anything that is not six digits", () => {
    for (const candidate of ["", "12345", "1234567", "12345a", " 123456"]) {
      expect(verifyTotp(RFC_SEED_BASE32, candidate, at)).toBe(false)
    }
  })
})

describe("portal server source", () => {
  test("is deployable: ES module, no dependency beyond node builtins", () => {
    const imports = PORTAL_SERVER_JS.match(/^import .* from "(.*)"$/gm) ?? []
    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) expect(line).toContain('from "node:')
  })

  test("carries the markers the CLI and the reviewer depend on", () => {
    // reachedSignedIn() in cli.ts looks for exactly this selector.
    expect(PORTAL_SERVER_JS).toContain('data-testid="signed-in"')
    // The human types into this field on their phone.
    expect(PORTAL_SERVER_JS).toContain('data-testid="totp-code"')
    // startPortal() polls this route before it hands the URL to the browser.
    expect(PORTAL_SERVER_JS).toContain('url.pathname === "/healthz"')
  })

  test("verifies the same RFC parameters the terminal prints for", () => {
    expect(PORTAL_SERVER_JS).toContain('crypto.createHmac("sha1", key)')
    expect(PORTAL_SERVER_JS).toContain("Math.floor(Date.now() / 1000 / 30)")
    expect(PORTAL_SERVER_JS).toContain("% 1000000")
    expect(PORTAL_SERVER_JS).toContain("for (const drift of [-1, 0, 1])")
  })

  test("survived hand-escaping into a TypeScript template literal", () => {
    // A stray backtick or `${` here means the escaping went wrong and the
    // sandbox would get a file that does not parse.
    expect(PORTAL_SERVER_JS).not.toContain("`")
    expect(PORTAL_SERVER_JS).not.toContain("${")
  })
})
