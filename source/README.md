# Source of the printsi MCP server

`printsi/server/printsi.mjs` is built from the TypeScript in this folder, and nothing else.

- `cli/src`: the printsi CLI, which is also the MCP server (`mcp.ts`).
- `core/src`: the shared pieces it imports: the response envelope, errors, brand constants and price formatting.
- The only runtime library is [zod](https://github.com/colinhacks/zod), bundled in.

## Rebuild and compare

```bash
cd source
npm ci
npm run build
git diff --exit-code ../printsi/server/printsi.mjs
```

`npm run build` bundles `cli/src/bin.ts` into one unminified ES module with tsup (esbuild), copies it to
`printsi/server/printsi.mjs` and prints its SHA-256. With the versions in `package-lock.json` the output is identical
to the committed file, so the last command prints nothing.

The API these tools call is not in this repository.
