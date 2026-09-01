/**
 * Drive the mobile UI for real, locally: start the relay, play the agent side
 * with a genuine screencast JPEG, and print everything the phone sends back.
 *
 *   bun spikes/a/ui-probe.ts 39231
 *
 * Then point a browser at http://127.0.0.1:39231/ and use it. Every tap, char,
 * key, scroll, handback and abort shows up on stdout as `HUMAN <json>`.
 */
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"

const port = Number(process.argv[2] ?? 39231)
const serverPath = fileURLToPath(new URL("../../src/relay/guest/server.js", import.meta.url))
const framePath = fileURLToPath(new URL("../s2/sample-frame.jpg", import.meta.url))
const jpeg = readFileSync(framePath).toString("base64")

const relay = spawn(process.execPath, [serverPath, String(port)], { stdio: "inherit" })
process.on("exit", () => relay.kill("SIGKILL"))
await Bun.sleep(400)

const agent = new WebSocket(`ws://127.0.0.1:${port}/ws?role=agent`)
agent.on("open", () => {
  agent.send(JSON.stringify({ type: "state", reason: "GitHub is asking for a 2FA code" }))
  agent.send(
    JSON.stringify({
      type: "frame",
      data: jpeg,
      meta: {
        deviceWidth: 1280,
        deviceHeight: 800,
        jpegWidth: 800,
        jpegHeight: 500,
        pageScaleFactor: 1,
      },
    }),
  )
  console.log(`READY http://127.0.0.1:${port}/  (frame ${jpeg.length} b64 chars)`)
})
agent.on("message", (raw: Buffer) => console.log("HUMAN", raw.toString("utf8")))

await Bun.sleep(120_000)
