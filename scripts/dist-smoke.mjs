// Runs the SHIPPED artifact under node — the consumer's runtime, not bun's.
// Exists because a CJS-interop difference made the QR silently break in dist
// while every bun-driven test stayed green.
const m = await import("../dist/index.js")
const expected = [
  "raiseHand",
  "handoffQr",
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
if (!qr || !qr.includes("▄")) {
  console.error("dist smoke: QR did not render under node")
  process.exit(1)
}
console.log(
  `dist smoke ok — ${expected.length} exports, QR ${qr.split("\n").length} rows`,
)
