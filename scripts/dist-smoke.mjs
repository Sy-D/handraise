// Runs the SHIPPED artifact under node — the consumer's runtime, not bun's.
// Exists because a CJS-interop difference made the QR silently break in dist
// while every bun-driven test stayed green.
import { readFileSync } from "node:fs"

const m = await import("../dist/index.js")
const expected = [
  "raiseHand",
  "handoffQr",
  "scanQrLinks",
  "OPENABLE_SCHEMES",
  "consoleLogger",
  "quietLogger",
  "noopLogger",
  "createNeedHumanTool",
  "needHumanToolSpec",
  "HandraiseError",
  "isHandraiseError",
]
for (const name of expected) {
  if (!(name in m)) {
    console.error(`dist smoke: missing export ${name}`)
    process.exit(1)
  }
}
// The error class has to survive bundling: a consumer branches on `code`, and
// `instanceof` only works if the shipped class is the one the guard tests.
const cause = new Error("EAI_AGAIN api.getsolari.com")
const coded = new m.HandraiseError("relay_start_failed", "no relay", { cause })
if (
  coded.code !== "relay_start_failed" ||
  coded.name !== "HandraiseError" ||
  coded.cause !== cause ||
  !(coded instanceof Error) ||
  !m.isHandraiseError(coded) ||
  m.isHandraiseError(cause)
) {
  console.error("dist smoke: HandraiseError did not survive the bundle")
  process.exit(1)
}

const qr = m.handoffQr(
  `https://example.preview.getsolari.com/?pt_token=${"x".repeat(240)}`,
)
if (!qr?.includes("▄")) {
  console.error("dist smoke: QR did not render under node")
  process.exit(1)
}
// The other direction, and the same trap: `jsqr` is a CommonJS UMD bundle, so
// its default import is exactly the shape that broke `qrcode-terminal` in dist
// while bun stayed green. Decode a real screenshot to prove it survived.
const shot = readFileSync(
  new URL("../src/core/fixtures/qr-page.png", import.meta.url),
)
const links = m.scanQrLinks(shot)
if (links.length !== 1 || links[0].kind !== "url") {
  console.error(
    "dist smoke: the QR decoder did not read the fixture under node",
  )
  process.exit(1)
}

console.log(
  `dist smoke ok — ${expected.length} exports, QR ${qr.split("\n").length} rows, decoded ${links[0].text.length} chars`,
)
