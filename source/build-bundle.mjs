// Copies the built CLI to the plugin as its MCP server, and prints its checksum.
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
const out = new URL("../printsi/server/printsi.mjs", import.meta.url);
copyFileSync(new URL("./cli/dist/cli.js", import.meta.url), out);
console.log(`printsi/server/printsi.mjs sha256 ${createHash("sha256").update(readFileSync(out)).digest("hex")}`);
