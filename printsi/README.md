# printsi

Check a print-ready PDF for free, then have it professionally printed and delivered, from your agent.

printsi is a portable Agent Plugin (Agent Plugins v1: `plugin.json`, `mcp.json` and a skill; no Python). It starts the
`printsi` CLI as a local MCP server, so the agent can read the PDF on your disk, check it against the printer's
requirements, get a quote and ask you to pay.

## What it does

1. **Checks the file.** Bleed, trim size, safe areas, image resolution, fonts and colour, with page previews and a fix
   for each issue. Checking is free and creates no order.
2. **Quotes it.** Printing, tracked delivery and the service fee for your address, in USD.
3. **Asks you to pay.** The agent gets a link; you review the order and pay on Stripe's checkout page. Your card is held
   and charged only once the printer accepts the job.
4. **Tracks it.** Order status and tracking, plus a support ticket if something goes wrong.

The bundled skill also helps the agent turn an HTML design into a print-ready PDF (exact size with bleed, CMYK, outlined
text) and make a print-sharp QR code.

## Where and what

- **Delivery:** the contiguous United States and DC.
- **Products today:** flyers and leaflets (US Letter and Half Letter), on 170 gsm gloss or silk, one or two sides.
  Other products and regions appear in `products_list` and `capabilities` as they open.

## Requirements

- Node.js 18 or later (`npx` runs the pinned CLI, `printsi@0.2.1`, from npm).
- Optional, only for the skill's helper scripts: Google Chrome or Chromium and Ghostscript (`print-ready.sh`), and
  [uv](https://docs.astral.sh/uv/) (`qr.sh`).

## Tools

Read-only: `capabilities`, `products_list`, `products_show`, `address_validate`, `pickup_points`, `order_show`,
`order_list`, `order_wait`, `order_events`, `ticket_show`, `ticket_list`.

Change something (Hermes asks first, because the server is marked `untrusted`): `check` (uploads the PDF),
`order_create`, `order_update`, `order_quote`, `order_purchase`, `order_cancel`, `ticket_create`, `feedback`.

## What to know before installing

- **Network.** Calls the printsi API at `https://printsi-api-live.magnus-ahmad.workers.dev`. `npx` downloads
  `printsi@0.2.1` from the npm registry on first run. The optional `qr.sh` script downloads `segno` from PyPI through
  `uvx`. Nothing else is contacted.
- **Your files.** The PDF you ask it to check or print is uploaded to printsi and stored for the check and the order.
- **Your details.** The delivery name, address, phone and email you give are sent to printsi and to the print supplier
  that makes and ships the order. Order emails go to the address you give.
- **Money.** The plugin never takes or sees card details and cannot pay on its own. `order_purchase` only returns a
  link; a person pays on Stripe. Prints are made to order: once the printer accepts a job it can't be cancelled or
  refunded, except when it arrives faulty or is lost.
- **No account, one stored key.** You don't sign up or paste a key. On first use printsi creates its own guest key for
  the API and keeps it, with the tokens of your orders, in this plugin's own data folder in the Hermes profile
  (`PRINTSI_CONFIG_DIR`). Each profile gets its own. It reads no other tool's credentials and no other credential
  store.
- **Local processes.** Hermes starts `npx -y printsi@0.2.1 mcp` as a local stdio server. The optional helper scripts
  run Chrome and Ghostscript locally.
- **No telemetry.** The package sets `PRINTSI_TELEMETRY=0`. There are no update checks in MCP mode and nothing updates
  itself; a new CLI version reaches you only through a new catalog pin.

## Support

Ask the agent to file a ticket (`ticket_create`), or write to printsi@agentmail.to.
[Terms of sale](https://printsi-api-live.magnus-ahmad.workers.dev/terms) ·
[Privacy](https://printsi-api-live.magnus-ahmad.workers.dev/privacy)

printsi is operated by Ahmad Company Limited (Hong Kong). MIT licensed.
