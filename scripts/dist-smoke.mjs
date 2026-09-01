// Runs the SHIPPED artifact under node — the consumer's runtime, not bun's.
// Exists because a CJS-interop difference made the QR silently break in dist
// while every bun-driven test stayed green.
const m = await import("../dist/index.js")
const expected = ["raiseHand", "handoffQr", "consoleLogger", "quietLogger", "noopLogger", "createNeedHumanTool", "needHumanToolSpec"]
for (const name of expected) {
  if (!(name in m)) { console.error(`dist smoke: missing export ${name}`); process.exit(1) }
}
const qr = m.handoffQr(`https://example.preview.getsolari.com/?pt_token=${"x".repeat(240)}`)
if (!qr || !qr.includes("▄")) { console.error("dist smoke: QR did not render under node"); process.exit(1) }
console.log(`dist smoke ok — ${expected.length} exports, QR ${qr.split("\n").length} rows`)
