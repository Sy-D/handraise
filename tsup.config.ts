import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  // Types are for consumers of the library. `dist/cli.js` is a `bin`, nobody
  // imports it, and a `cli.d.ts` would only be dead weight in the tarball.
  dts: { entry: "src/index.ts" },
  // Off on purpose. With splitting on, esbuild would move the code both entries
  // share into a chunk and rewrite `dist/index.js` to import it — changing the
  // published entry point for every existing consumer, to save one file.
  splitting: false,
  // `src/cli.ts` imports `./index.js` and this keeps that import in the output,
  // so `dist/cli.js` loads `dist/index.js` at runtime instead of bundling a
  // second copy of the whole library into the tarball.
  external: ["./index.js"],
  clean: true,
  target: "node18",
  // The `#!/usr/bin/env node` line lives at the top of src/cli.ts; esbuild
  // hoists it to the top of the output. A tsup `banner` would apply to every
  // entry, putting a shebang on dist/index.js too.
  // The relay ships as a string constant (guest-source.ts), so no assets to copy.
})
