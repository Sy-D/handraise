/**
 * The decoder, against images rather than mocks.
 *
 *   bun test src/core/qr-scan.test.ts
 *
 * Two kinds of input, on purpose. `src/core/fixtures/qr-page.png` is a real
 * 1280x800 screenshot taken by a real Solari cloud browser — colour type 2
 * (RGB) with the whole range of PNG scanline filters in it, which is the shape
 * production actually feeds this code, and which nothing synthetic reproduces.
 * Regenerate it with `bun --env-file=.env scripts/measure-qr-decode.ts`. The
 * rest are generated here from the `qrcode` dev dependency, so the small, dense,
 * rotated, absent and doubled cases cost no binary in the repository.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import jsQR from "jsqr"
import QRCode from "qrcode"

import { decodePng, type RgbaImage } from "./png"
import { NEVER_OPENABLE } from "./qr-fixtures"
import {
  classifyLink,
  MAX_LINK_CHARS,
  OPENABLE_SCHEMES,
  scanImage,
  scanQrLinks,
} from "./qr-scan"

const FIXTURE = fileURLToPath(
  new URL("./fixtures/qr-page.png", import.meta.url),
)

/** The screenshot that failed the first live e2e run; see the test that uses it. */
const CENTRED_FIXTURE = fileURLToPath(
  new URL("./fixtures/qr-centred.png", import.meta.url),
)

/** The payload the fixture's page was drawn with; see the measurement script. */
const FIXTURE_PAYLOAD = `https://verify.example.com/device?token=${"a1b2c3d4".repeat(20)}`

async function qrImage(text: string, scale = 6): Promise<RgbaImage> {
  return decodePng(await QRCode.toBuffer(text, { scale, margin: 2 }))
}

/** A white canvas, the quiet zone every QR code needs around it. */
function blank(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(255)
  return { data, width, height }
}

function paste(into: RgbaImage, image: RgbaImage, x: number, y: number): void {
  for (let row = 0; row < image.height; row++) {
    const from = row * image.width * 4
    into.data.set(
      image.data.subarray(from, from + image.width * 4),
      ((y + row) * into.width + x) * 4,
    )
  }
}

/** Quarter turn clockwise, exactly — no resampling, so nothing else changes. */
function rotate90(image: RgbaImage): RgbaImage {
  const turned = blank(image.height, image.width)
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * 4
      const to = (x * turned.width + (image.height - 1 - y)) * 4
      turned.data.set(image.data.subarray(from, from + 4), to)
    }
  }
  return turned
}

// --- the images -----------------------------------------------------------

test("a real cloud-browser screenshot decodes to the link it carries", () => {
  const links = scanQrLinks(readFileSync(FIXTURE))
  expect(links).toEqual([{ text: FIXTURE_PAYLOAD, kind: "url" }])
})

test("a symbol the page resampled decodes, though the plain pass cannot", () => {
  // This screenshot failed the first live run of the e2e, and it is kept
  // exactly as it came off the browser. The code in it is large, centred and
  // perfectly sharp to the eye — but the page drew a 534px image at 420 CSS
  // px, so a module is 4.9 pixels wide and `jsQR`'s fixed 8x8 binarizer blocks
  // straddle the module boundaries. The plain pass finds nothing; a tight crop
  // of the very same pixels decodes. See docs/measurements/05-qr.md.
  const shot = readFileSync(CENTRED_FIXTURE)
  const image = decodePng(shot)
  expect(jsQR(image.data, image.width, image.height)).toBeNull()

  const links = scanQrLinks(shot)
  expect(links).toHaveLength(1)
  expect(links[0]?.kind).toBe("url")
  expect(links[0]?.text).toContain("/verified?pt_token=")
})

test("a small symbol decodes", async () => {
  expect(scanImage(await qrImage("https://example.com/a", 3))).toEqual([
    "https://example.com/a",
  ])
})

test("a dense symbol decodes", async () => {
  // 900 characters is version 27 or so: far past anything a login page draws,
  // and the case where a wrong scanline filter shows up as garbage rather than
  // as a failure to find the code at all.
  const long = `https://example.com/?q=${"x".repeat(900)}`
  expect(scanImage(await qrImage(long, 5))).toEqual([long])
})

test("a symbol turned on its side decodes", async () => {
  const upright = await qrImage("https://example.com/rotated", 6)
  expect(scanImage(rotate90(upright))).toEqual(["https://example.com/rotated"])
})

test("a page with no code decodes to nothing", () => {
  expect(scanImage(blank(600, 400))).toEqual([])
})

test("two codes on one screen are both reported", async () => {
  // Six finder patterns in one image defeat jsQR's locator outright: the
  // whole-page pass below finds neither of these. What rescues it is the tiled
  // second look, and this is the test that holds that fallback in place — see
  // docs/measurements/05-qr.md and the comment on `readTiles`.
  const first = await qrImage("https://example.com/first", 9)
  const second = await qrImage("https://example.com/second", 9)
  const page = blank(1280, 800)
  paste(page, first, 80, 200)
  paste(page, second, 700, 200)

  const found = scanImage(page)
  expect(found.sort()).toEqual([
    "https://example.com/first",
    "https://example.com/second",
  ])
})

test("the same code is not reported twice", async () => {
  // Masking a symbol that has been read is what stops the second pass from
  // finding the first one again and calling it a second code.
  expect(scanImage(await qrImage("https://example.com/once", 6))).toEqual([
    "https://example.com/once",
  ])
})

// --- what the phone may open ----------------------------------------------

test("the openable schemes are the ones a device-change code uses", () => {
  expect([...OPENABLE_SCHEMES].sort()).toEqual([
    "http:",
    "https:",
    "mailto:",
    "otpauth:",
    "tel:",
  ])
})

test("a link in an openable scheme is a url", () => {
  for (const text of [
    "https://example.com/verify?token=abc",
    "http://192.168.0.4:8080/pair",
    "tel:+4915112345678",
    "mailto:help@example.com",
    "otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP&issuer=Example",
  ]) {
    expect(classifyLink(text)).toEqual({ text, kind: "url" })
  }
})

test("everything else is text, and stays readable as text", () => {
  for (const text of [
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "file:///etc/passwd",
    "intent://scan/#Intent;scheme=zxing;end",
    "vbscript:msgbox(1)",
    "WIFI:S:GuestNet;T:WPA;P:hunter2;;",
    "BEGIN:VCARD\nVERSION:3.0\nFN:Ada\nEND:VCARD",
    "just a sentence someone printed on a poster",
    "",
  ]) {
    expect(classifyLink(text).kind).toBe("text")
  }
})

test("a link that reads as one host and goes to another is not a url", () => {
  for (const text of NEVER_OPENABLE) {
    expect(classifyLink(text).kind).toBe("text")
  }
})

test("a scheme hidden behind whitespace is not a url", () => {
  // The URL parser drops tabs and newlines, so it would report `https:` for a
  // string whose visible first line says something else entirely. What the
  // parser validated and what the phone would show have to be one string.
  expect(classifyLink("https://exa\tmple.com/x").kind).toBe("text")
  expect(classifyLink("https://example.com/x evil").kind).toBe("text")
})

test("surrounding whitespace is trimmed rather than making a link untouchable", () => {
  expect(classifyLink("  https://example.com/x\n")).toEqual({
    text: "https://example.com/x",
    kind: "url",
  })
})

test("an absurdly long payload is capped and demoted to text", () => {
  const huge = `https://example.com/?q=${"y".repeat(4000)}`
  const link = classifyLink(huge)
  expect(link.text).toHaveLength(MAX_LINK_CHARS)
  expect(link.text).toBe(huge.slice(0, MAX_LINK_CHARS))
  // Still a valid URL after the cut, and deliberately still openable: the cap
  // is about what a phone can render, not about what a scheme may do.
  expect(link.kind).toBe("url")
})

// --- the PNG decoder ------------------------------------------------------

test("a PNG the decoder cannot read says so instead of guessing", async () => {
  // Colour type 3 (palette). Nothing here produces one, and a decoder path
  // with no input is a path nobody has run — so it is refused by name.
  const palette = await QRCode.toBuffer("https://example.com", {
    scale: 4,
    margin: 2,
    // SAFETY: `qrcode` writes a palette PNG when told to use two colours; the
    // option is not in its published types, and this test exists to prove the
    // decoder rejects exactly that file.
    type: "png",
  })
  // The generated file is RGBA, so build the refusal case by hand instead:
  // take its header and claim colour type 3.
  const forged = Buffer.from(palette)
  forged[25] = 3
  expect(() => decodePng(forged)).toThrow(/unsupported PNG/)
})

test("something that is not a PNG at all says so", () => {
  expect(() => decodePng(Buffer.from("not a png, just some bytes"))).toThrow(
    /not a PNG/,
  )
})

/** A PNG with a chosen IHDR and a chosen (already deflated) IDAT payload. */
function forgePng(width: number, height: number, idat: Buffer): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, "ascii")
    // The CRC is never checked by this decoder, so zero is honest filler.
    return Buffer.concat([head, body, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

test("a zip bomb is refused at the size its own header promised", () => {
  // A tiny image whose IDAT decompresses to 64 MB. Without a bound the inflate
  // allocates all of it and then decodes the first 200 bytes as a valid 8x8
  // picture — 815 KB in, 873 MB of RSS, and no error at all. The header says
  // how many bytes a PNG's image data comes to, so the inflate is capped by it.
  const bomb = forgePng(8, 8, deflateSync(Buffer.alloc(64 * 1024 * 1024)))
  expect(bomb.length).toBeLessThan(200_000)

  const before = process.memoryUsage().rss
  expect(() => decodePng(bomb)).toThrow()
  const grew = (process.memoryUsage().rss - before) / (1024 * 1024)
  // The bomb is 64 MB uncompressed; refusing it must not cost 64 MB.
  expect(grew).toBeLessThan(32)
})

test("a header that claims more pixels than any screen is refused", () => {
  // 65535x65535 is four billion pixels, and every allocation in the decoder is
  // sized from these two numbers. Refused before a byte is inflated.
  expect(() =>
    decodePng(forgePng(65_535, 65_535, deflateSync(Buffer.alloc(64)))),
  ).toThrow(/past the .* cap/)
})
