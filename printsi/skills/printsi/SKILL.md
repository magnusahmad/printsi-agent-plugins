---
name: printsi
description: Check and prepare PDFs for professional printing, or order printed products for delivery - flyers, cards, brochures, posters, banners, stickers, calendars, canvas and wall prints, mugs, bags, T-shirts and hoodies. Free preflight checks size, bleed, safe areas, image resolution, fonts and colour, with previews and issue messages. Not local printing.
license: MIT
metadata:
  related-skills: "claude-design, stripe-link-cli"
---

# Physical print ordering with printsi

Use this to **check a print file** (free, before anything is ordered), and when the user wants **something printed and
delivered**: "print 50 flyers", "is this flyer print-ready?", "order business cards from card.pdf", "put our logo on
ten T-shirts", "a canvas of this photo". printsi checks the file, quotes the price, gets the user's approval to pay,
places the order with a professional printer and tracks it. It is not for printing on a local printer, and it does
not design: you (or a design skill) make the artwork, printsi checks and prints it.

## 1. Find the product and its file rules

Every product is printed from **one PDF**, but what that PDF must be differs a lot: a flyer wants 3 mm of bleed, a
canvas 30 mm, a mug none, a T-shirt a transparent background. Don't work from memory; ask.

1. `products_list` names what is offered (flyers, postcards, business cards, letterhead, brochures, folded cards,
   stickers, calendars, posters, outdoor posters, banners, canvas, aluminium and acrylic prints, photo tiles, pillows,
   mugs, bags, T-shirts, hoodies, sweatshirts, and whatever has been added since). Each has `aliases`, so "tote",
   "leaflet" or "tee" find their product.
2. `products_show` with the `product`, the options you know and `region` (`US`) returns:
   - **`options`**: what can be chosen. `size`, `stock`, `sides`, `fold` and `orientation` are arguments of their
     own; any other option goes in `option` as `key=value` strings, e.g. `option: ["colour=black", "print=front"]`.
     A value's `allowed_with` says what it can be combined with (a fold only on some sizes, a paper only in some sizes,
     a size only in portrait).
   - **`file_requirements`**: for the options given, the `pages` the PDF needs and what goes on each (`page_map`), the
     trim (`trim_mm` or `trim_in`), `bleed_in`, `safe_in`, the full page size (`page_size_in`), the `orientation`,
     the folded panels (`panels_in`) and the lowest image resolution. Pass the size (and the fold, or a garment's
     `print`) to get one entry instead of every combination. A garment has one entry for each print area on offer;
     the one that applies by default is `front`.
   - **`offers`**: the quantities the printer sells. Add `qty` to ask about one; if it isn't offered the answer names
     the nearest ones. Never round a quantity yourself: ask the user which they want.
3. What the "size" is depends on the product: the sheet for paper products; the **flat, unfolded sheet** for brochures
   and folded cards; the finished face for canvas and wall prints; the item itself for mugs (`classic-11oz`) and bags
   (`tote-38x42cm`); the **garment size** (`s` … `2xl`) for clothing, where the file's size comes from `print`.

## 2. Make the artwork print-ready

If the design is HTML (for example from `claude-design`), lay it out for print and export it with this skill's
script; don't hand a printer a screenshot or a browser "Save as PDF".

### Rules for every product

- **Page size = trim + 2 × bleed**, exactly (`page_size_in`). In the HTML: `@page { size: <width> <height>; margin: 0 }`,
  one page element of exactly that size per PDF page, `margin: 0` on `html, body`. To convert, 1 in = 25.4 mm.
- **Fill the bleed.** Backgrounds and images that touch an edge must run all the way to the page edge. The bleed is
  cut off (or wrapped, or sewn in); a design that stops at the trim line leaves a white sliver.
- **Keep what matters inside the safe area**: text, logos and QR codes at least **bleed + safe** from the page edge.
- Use real units (mm, in, pt), not viewport units. Body text at least 9 pt on paper; much larger on anything read
  from a distance.
- Fonts: any, including web fonts (e.g. a Google Fonts `<link>`): the export waits for them to load, then turns all
  text into outlines, so nothing depends on fonts at the printer.
- Images: on paper at least 300 ppi at their printed size (below 150 the check fails). Large and wall products
  (posters, banners, canvas, aluminium, acrylic, photo tiles, pillows) and garments need 150 ppi (below 100 fails).
  A phone photo is rarely enough for a 24 × 36 in canvas: work out pixels ÷ printed inches before promising a size.
- QR codes: make them with `sh "<this skill's directory>/scripts/qr.sh" <url> qr.svg` and place the SVG as an
  `<img>` on its own white tile, at least 25 mm wide (30 mm+ for scanning from a distance). Never recolour or invert
  the QR to match a dark design: dark-on-white is what phone cameras read reliably from print.
- Colour: the PDF is printed in CMYK. Very saturated screen colours (neon pink, electric teal) come out a little
  duller; choose strong but printable colours (e.g. hot pink `#EC008C`, teal `#00A8B5`, black `#111`) and check the
  preview. Large areas of pure black print as rich black, which is fine for a background.

### By kind of product

| Kind | Products | What the PDF is |
| --- | --- | --- |
| Flat sheets | flyers, postcards, business cards, letterhead, stickers | One page per printed side: 1 page prints one side, 2 pages print both. Stickers are one-sided, one sticker per sheet with no cut shape, and most sizes have no bleed. |
| Folded | brochures, folded cards | The flat sheet, always 2 pages: **page 1 the outside, page 2 the inside**. See below. |
| Calendars | calendars | 13 pages, one-sided: the front sheet, then January to December. The wire runs along the top edge, so keep the top (and everything else) 10 mm inside the trim. |
| Large and wall | posters, outdoor posters, banners, canvas, aluminium and acrylic prints, photo tiles, pillows | One page. The bleed is much larger than on paper and differs by product, from 1.5 mm (photo tiles) to 50 mm (banners). See below. |
| Print area | mugs, bags | One page that **is** the printed area: no bleed, nothing is cut. See below. |
| Garments | T-shirts, premium T-shirts, hoodies, sweatshirts | One page that is the print area, on a **transparent background**. See below. |

**Folded products.** `panels_in` lists the panel widths left to right for each side (top to bottom when it says
`across: height`, a card that folds at the top). `page_map` says where the front cover sits: on the outside page it
is the **right-hand** panel for a half, tri- or Z-fold; a gate fold has the two front flaps left and right with the
back cover in the middle; a top-fold card has the front cover on the **top half, upside down**, and the back cover
below it. The inside page reads left to right as opened. Keep text and logos the safe distance away from every fold
as well as from the edges (a background or image may cross a fold). The check warns with `CONTENT_ON_FOLD` when it
finds text or artwork on a fold, but **don't rely on it**: the export below turns text into outlines, which it can
miss, and it can't read text inside a placed image. Look at the fold lines drawn on the check's preview and make
sure nothing that matters sits on one.

**Canvas, banners and the other large products.**
- Canvas: the size is the front face. The file adds 30 mm on every edge (about 42 mm on a few sizes; use the
  `bleed_in` given): the 20 mm nearest the face wraps round the side of the frame and is seen, the rest is trimmed.
  Carry the picture or a plain colour through it, and keep faces and text well inside the front.
- Banners have metal eyelets around the edge: keep everything that matters 1 in inside the trim.
- Pillows add 20 mm on every edge for the seam.
- Canvas, aluminium and acrylic prints, photo tiles and pillows are sold one to five at a time; `offers` says what
  each product sells.

**Mugs and bags.** The page is the print area exactly as `file_requirements` gives it (200 × 88 mm on a classic mug,
which wraps round it; 240 × 310 mm on a tote). There is no bleed, so nothing needs to reach the edge. White is not
printed: white areas show the mug's or bag's own colour, so design for the `colour` chosen and don't rely on white
ink on a dark one.

**Garments.** `size` is the garment size, `colour` the garment colour (`option: ["colour=navy"]`), and `print` is
where the one print goes. Today that is the `front` (the default; 14 × 16 in on a T-shirt, 14 × 8 in on a hoodie).
`products_show` lists any other area on offer under `print` (a back, left-chest or sleeve print), each with its own
print area in `file_requirements`. Offer only the areas it lists: if the user wants one that isn't there,
say it isn't available yet rather than sending that design as a front print.
- The PDF page is that print area and its **background must be transparent**. Anything left behind the design is
  printed, a white box included (white is printed as white ink). In the HTML set no background on `html`, `body` or
  the page element, and don't cover the page with a rectangle or a photo unless a printed box is what is wanted; the
  check warns with `BACKGROUND_PRINTS`.
- No bleed and no safe margin. Artwork smaller than the page keeps its place in the print area, so position the
  design on the page where it should sit on the garment (a chest design high on the front area, not centred).
- Choose colours that show on the garment colour: light artwork for dark garments, dark for light ones.
- Export with `rgb` as the last argument (see below): garments are printed from RGB, with white ink where the design
  is white.
- One size, one colour and one print per order. Shirts in three sizes are three orders with the same file; a front
  and a back print on the same garment are not offered yet.

### Export and look

```bash
sh "<this skill's directory>/scripts/print-ready.sh" design.html design-print.pdf <trim-width-mm> <trim-height-mm> <bleed-mm> [cmyk|rgb]
```

For example a US Letter flyer is `215.9 279.4 3.175`, a classic mug `200 88 0`, a 12 × 16 in canvas `304.8 406.4 30`
and the front of a T-shirt `355.6 406.4 0 rgb`. The script renders with Chrome, converts to CMYK (or, with `rgb`,
leaves the colours as designed: use that for garments and nothing else), outlines text and sets the TrimBox and
BleedBox on every page; a page left transparent stays transparent. Then look at what will actually print, not the
HTML: render the PDF to an image and check it (colours shift slightly in CMYK, and anything outside the safe area
gets close to the cut):

```bash
gs -q -o preview-%02d.png -sDEVICE=png16m -r60 design-print.pdf
```

A garment file is drawn on nothing, so on a white preview white or pale artwork is invisible (the preview that
`check` returns is on white too). To see it on the garment, paint the garment's colour behind the page, as red,
green and blue from 0 to 1 (here near-black):

```bash
gs -q -o preview-on-garment.png -sDEVICE=png16m -r30 -c "<< /BeginPage { pop 0.07 0.07 0.07 setrgbcolor clippath fill } >> setpagedevice" -f design-print.pdf
```

## 3. Check, quote and order (printsi tools)

1. **Check the file first** (free; creates no order): `check` with the PDF path, `product` and the same options as
   the order will have (`size`, `fold`, `option: ["colour=…"]` …), e.g. flyer and `8.5x11`, or brochure, `25.5x11`
   and `trifold`. Leave an option out and the file is checked against the default: a file made for another print
   area of a garment, checked without `print`, fails as the wrong size for the front. The result includes each page's preview as an image, with
   trim, safe area, folds and each issue marked: look at it before deciding what to change. Fix every `error` issue in the source and export again; printsi
   never edits artwork. Mention warnings. In Hermes Desktop the printsi pane shows the same page and issues to the
   user. If a check is still running, run the `resume` command it returns: it has the original options, so the result
   matches this check.
2. **Delivery**: orders in the contiguous US are delivered to the door, priced in USD. Some products are printed
   abroad and shipped in, which takes longer and often leaves one delivery choice; the quote says when to expect it,
   so tell the user the dates before they pay, above all when they have a deadline (`deliver_by` on the order). There are no pickup points today;
   `pickup_points` says so.
3. **Create an unpaid draft**: `order_create` with `file`, `product`, the options, `qty` and `ship_to` (the user's
   address as an object, with a phone and email). It creates a draft with quotes and buys nothing. Pass a
   `client_ref` (your own reference, e.g. the project name): re-running create with the same reference returns the
   same order instead of a duplicate, so use it whenever you might retry. Keep the order id and the order token it
   returns.
4. **Tell the user the quote** from the `summary`: total in the local currency, what's included, when it's ready.
   Estimates aren't guarantees.
5. **Buy only with the user's go-ahead**: `order_purchase` with the order and `quote` (usually
   `recommended_quote_id`) requests the purchase and returns an `approval_url`. It charges nothing. Give the user that
   link; they review and pay on Stripe's page. Their card is held, and charged only once the printer accepts the job.
   You never handle card details.
6. **Wait and track**: `order_wait` with `for: "accepted"` (repeat on timeout), later `order_show` for tracking.

## 4. When something goes wrong: tickets and feedback

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

- One product, one file, one set of options and one address per order.
- Never invent the user's approval or address.
- Mention warnings from the check; they don't block ordering.
