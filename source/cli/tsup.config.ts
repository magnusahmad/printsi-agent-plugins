import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  entry: { cli: "src/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node18",
  bundle: true,
  noExternal: [/.*/], // ship a single file with no runtime dependencies (spec 01 §12)
  // Readable on purpose: the Hermes plugin catalog reviews what a plugin runs, and this file is what npx fetches.
  minify: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  define: { __CLI_VERSION__: JSON.stringify(version) },
});
