---
name: printsi
description: Check and prepare PDFs for professional printing, or order printed copies for delivery. Free preflight checks bleed, dimensions, safe areas, image resolution, fonts and colour, with previews and issue messages. Not local printing.
license: MIT
metadata:
  related-skills: "claude-design, stripe-link-cli"
---

# Physical print ordering with printsi

Use this to **check a print file** (free, before anything is ordered), and when the user wants **printed copies made and
delivered or collected**: "print 50 flyers", "is this flyer print-ready?", "order business cards from card.pdf".
printsi checks the file, quotes the price, gets the user's approval to pay, places the order with a professional printer
and tracks it. It is not for printing on a local printer, and it does not design: you (or a design skill) make the
artwork, printsi checks and prints it.

## 1. Make the artwork print-ready

Printers need an exact-size PDF with bleed. If the design is HTML (for example from `claude-design`), lay it out for
print and export it with this skill's script; don't hand a printer a screenshot or a browser "Save as PDF".

1. Get the size: trim size, bleed and safe margin for the product, from `products_show`. US flyers need **0.125 in
   (3.175 mm) bleed and a 0.125 in safe area**. Trims: US Letter 8.5 × 11 in (215.9 × 279.4 mm), Half Letter
   5.5 × 8.5 in (139.7 × 215.9 mm).
2. Lay out the HTML page at **trim + 2 × bleed**, e.g. US Letter: `@page { size: 8.75in 11.25in; margin: 0 }`, one page
   element exactly that size, `margin: 0` on `html, body`.
   - Backgrounds and images that touch an edge must run all the way to the page edge (into the bleed).
   - Keep text, logos and QR codes at least **bleed + safe margin** (0.25 in) inside the page edge.
   - Use real units (mm, pt) for print, not viewport units. Body text at least 9 pt; headlines can be very large.
   - Fonts: any, including web fonts (e.g. a Google Fonts `<link>`): the export waits for them to load, then turns all
     text into outlines, so nothing depends on fonts at the printer.
   - Images at least 300 ppi at their printed size (below 150 ppi the check fails; below 300 it warns).
   - QR codes: make them with `sh "<this skill's directory>/scripts/qr.sh" <url> qr.svg` and place the SVG as an
     `<img>` on its own white tile, at least 25 mm wide (30 mm+ for scanning from a distance). Never recolour or invert
     the QR to match a dark design: dark-on-white is what phone cameras read reliably from print.
   - Colour: the PDF is printed in CMYK. Very saturated screen colours (neon pink, electric teal) come out a little
     duller; choose strong but printable colours (e.g. hot pink `#EC008C`, teal `#00A8B5`, black `#111`) and check the
     preview. Large areas of pure black print as rich black, which is fine for a background.
3. Export:

   ```bash
   sh "<this skill's directory>/scripts/print-ready.sh" flyer.html flyer-print.pdf 215.9 279.4 3.175
   ```

   It renders with Chrome, converts to CMYK, outlines text and sets the TrimBox and BleedBox. Then look at what will
   actually print, not the HTML: render the PDF to an image and check it (colours shift slightly in CMYK, and anything
   outside the safe area gets close to the cut):

   ```bash
   gs -q -o flyer-preview.png -sDEVICE=png16m -r60 flyer-print.pdf
   ```

## 2. Check, quote and order (printsi tools)

1. **Check the file first** (free; creates no order): `check` with the PDF path, `product` and `size` (e.g. flyer, 8.5x11).
   Fix every `error` issue in the source and export again; printsi never edits artwork. Mention warnings. If a check is
   still running, run the `resume` command it returns: it has the original options, so the result matches this check.
2. **Ask what's offered** when unsure: `products_show` with `region` (US) and `qty` says whether a quantity is
   offered and names the nearest ones. Never round a quantity yourself.
3. **Delivery**: orders in the contiguous US are delivered to the door, priced in USD. There are no pickup points
   today; `pickup_points` says so.
4. **Create an unpaid draft**: `order_create` with `file`, `product`, options (`size`, …), `qty` and `ship_to` (the
   user's address as an object, with a phone and email). It creates a draft with
   quotes and buys nothing. Pass a `client_ref` (your own reference, e.g. the project name): re-running create with the
   same reference returns the same order instead of a duplicate, so use it whenever you might retry. Keep the order id
   and the order token it returns.
5. **Tell the user the quote** from the `summary`: total in the local currency, what's included, when it's ready.
   Estimates aren't guarantees.
6. **Buy only with the user's go-ahead**: `order_purchase` with the order and `quote` (usually
   `recommended_quote_id`) requests the purchase and returns an `approval_url`. It charges nothing. Give the user that
   link; they review and pay on Stripe's page. Their card is held, and charged only once the printer accepts the job.
   You never handle card details.
7. **Wait and track**: `order_wait` with `for: "accepted"` (repeat on timeout), later `order_show` for tracking.

## 3. When something goes wrong: tickets and feedback

- **File a ticket** with `ticket_create` when printsi itself misbehaves or an order needs a person: a check that
  never finishes, an order stuck or failed, a payment problem, a delivery that hasn't arrived, a result you think is
  wrong. Pass `order` when it's about an order (its history is attached for us), a `category` (`order_problem`,
  `check_problem`, `payment`, `bug`, `question`, `other`) and a `message` saying what happened and what was expected,
  with error codes and `request_id`s. Ask the user before filing, and don't file for things you can fix (artwork
  issues from `check` are normal results, not tickets).
- Tell the user the ticket id. A person reads every ticket and replies to the email that paid for the order. Check on
  it later with `ticket_show`; `ticket_list` lists what's been filed.
- **Feedback**: when the user says something about printsi worth passing on (praise, a missing product, a confusing
  step), offer to send it with `feedback` (`message`, optional `rating` 1–5). Don't ask for feedback unprompted.
- Order updates (received, accepted, shipped or ready, delivered) are emailed to the payer automatically.

## Rules

- One product and one address per order.
- Never invent the user's approval or address.
- Mention warnings from the check; they don't block ordering.
