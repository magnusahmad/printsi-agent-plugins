# printsi

A Hermes plugin that gets a PDF professionally printed and delivered. It gives the agent 19 tools, run by a local
server that ships in this folder, and gives Hermes Desktop a pane that shows the page and the order.

## What the agent can do with it

| Step | Tools | What happens |
|---|---|---|
| Check the file | `check` | Reads the PDF from your disk, runs a real preflight (bleed, trim size, safe areas, image resolution, fonts, colour) and returns each issue with where it is and how to fix it, plus the page preview as an image. Free; creates no order. |
| Find what's offered | `capabilities`, `products_list`, `products_show`, `address_validate`, `pickup_points` | Products, sizes, stocks, quantities and where delivery is available. |
| Quote and order | `order_create`, `order_update`, `order_quote` | An unpaid draft with a price for printing, tracked delivery and the service fee, for your address. |
| Pay | `order_purchase` | Returns a link. You review the order and pay on Stripe's page; the agent never sees a card. The card is held and charged only when the printer accepts the job. |
| Follow it | `order_show`, `order_list`, `order_wait`, `order_events`, `order_cancel` | Status from accepted to delivered, with tracking. |
| Get help | `ticket_create`, `ticket_show`, `ticket_list`, `feedback` | A support ticket with the order's history attached. |

None of this can be done by instructions alone: the server reads and uploads the file, talks to the printsi API, keeps
the order's access token, and returns structured results the agent and the pane both read.

## The Desktop pane

With the plugin's Desktop half switched on (Capabilities → Plugins), a **printsi** pane sits beside the chat:

- **Preflight.** The page drawn to scale with bleed, trim and safe area, each issue numbered where it sits on the
  page, and the fix for it underneath. Hover an issue to find it on the page. A print-ready file turns green.
- **Order.** Where the order stands (Quote, Pay, Print, Ship, Delivered), the price breakdown, the delivery window,
  and a **Review and pay** button once the agent has requested the purchase.

The pane only listens to the results of this plugin's own tools. It makes no network calls, reads no files and calls
no tools. Its one action outside the window is opening printsi's payment page in your browser when you press the
button. It needs tool progress to be on (the default) to receive results.

## Where and what

- **Delivery:** the contiguous United States and DC.
- **Products today:** flyers and leaflets (US Letter and Half Letter), on 170 gsm gloss or silk, one or two sides.
  Other products and regions appear in `products_list` and `capabilities` as they open.

## What's in the package

| Path | What it is |
|---|---|
| `plugin.json`, `mcp.json` | Portable Agent Plugins v1 manifest. The server is marked `untrusted`, so Hermes asks before every tool that is not read-only. Only tools that send nothing of yours off the machine are marked read-only (`capabilities`, `products_*`, `order_show`, `order_list`, `order_wait`, `order_events`, `ticket_show`, `ticket_list`); `check` (uploads the PDF), `address_validate` and `pickup_points` (send the address) and every tool that changes something ask first. |
| `server/printsi.mjs` | The MCP server and everything it runs: one readable, unminified JavaScript file, started as `node ${PLUGIN_ROOT}/server/printsi.mjs mcp`. Nothing is downloaded at run time. It is the printsi CLI (also on npm as `printsi`) built into a single file; its only bundled library is zod (see `server/THIRD-PARTY-NOTICES.txt`). |
| `desktop/plugin.js` | The Desktop pane. Imports only `@hermes/plugin-sdk` and React. |
| `skills/printsi/` | A short guide for the agent, and two helper scripts for making artwork print-ready. |

## Requirements

- Node.js 18 or later on PATH.
- Optional, only for the skill's helper scripts: Google Chrome or Chromium and Ghostscript (`print-ready.sh`), and
  [uv](https://docs.astral.sh/uv/) (`qr.sh`).

## What to know before installing

- **Network.** The server calls the printsi API at `https://printsi-api-live.magnus-ahmad.workers.dev` and nothing
  else. The optional `qr.sh` script downloads `segno` from PyPI through `uvx`.
- **Your files.** The PDF you ask it to check or print is uploaded to printsi and stored for the check and the order.
  That PDF is the only file a tool argument can name: an address is passed as an object, never as a file path. A
  check saves its page previews to a temp folder the server creates; a tool cannot choose where files are written.
- **Your details.** The delivery name, address, phone and email you give are sent to printsi and to the print supplier
  that makes and ships the order. Order emails go to the address you give.
- **Money.** The plugin never takes or sees card details and cannot pay on its own. `order_purchase` only returns a
  link; a person pays on Stripe. Prints are made to order: once an order is paid it can't be cancelled or refunded,
  except when it arrives faulty or is lost.
- **No account, one stored key.** You don't sign up or paste a key. On first use printsi creates its own guest key for
  the API and keeps it, with the tokens of your orders, in this plugin's own data folder in the Hermes profile
  (`PRINTSI_CONFIG_DIR`). Each profile gets its own. It reads no other tool's credentials and no other credential
  store.
- **Local processes.** Hermes starts the server as a local stdio process. The optional helper scripts run Chrome and
  Ghostscript locally.
- **No telemetry.** The package sets `PRINTSI_TELEMETRY=0`. There are no update checks and nothing updates itself; a
  new version reaches you only through a new catalog pin.

## Support

Ask the agent to file a ticket (`ticket_create`), or write to printsi@agentmail.to.
[Terms of sale](https://printsi-api-live.magnus-ahmad.workers.dev/terms) ·
[Privacy](https://printsi-api-live.magnus-ahmad.workers.dev/privacy)

printsi is operated by Ahmad Company Limited (Hong Kong). MIT licensed.
