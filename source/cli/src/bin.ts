import { run } from "./main.js";
import { serveMcp } from "./mcp.js";

const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
  // Long-running MCP server over stdio (spec 01 §7.21); everything else is one command per process.
  await serveMcp(argv.includes("--sandbox") || process.env.PRINTSI_ENV === "sandbox", process.env);
} else {
  const result = await run(argv);
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}
