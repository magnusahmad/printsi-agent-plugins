/**
 * printsi for Hermes Desktop: one pane that shows what the agent's printsi tools just did.
 *
 *   Preflight  the page drawn to scale as the check describes it (bleed, trim or print area, safe
 *              area, fold lines) with each issue marked where it is, and the fix for it.
 *   Order      where the order stands (quote, pay, print, ship, delivered), the price, and the button
 *              to review and pay.
 *
 * It only listens: every value comes from the results of this package's own MCP tools
 * (`mcp__printsi__*`), read from the gateway's `tool.complete` events. It makes no network calls,
 * reads no files, and calls no tools. The one thing it does outside the window is open the printsi
 * payment page in the browser when the user presses the pay button.
 */

import { atom, Button, host, Tip, useValue } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------------------------------
// Reading tool results
// ---------------------------------------------------------------------------------------------------

/** `mcp__printsi__order_show` -> `order_show`; anything that is not a printsi tool -> null. */
function printsiTool(name) {
  const match = /^mcp_{1,2}printsi_{1,2}([a-z_]+)$/.exec(String(name ?? ''))

  return match ? match[1] : null
}

/** JSON from a string, also when Hermes has wrapped it in its untrusted-result notice. */
function parse(value) {
  if (typeof value !== 'string') {
    return value && typeof value === 'object' ? value : null
  }

  const tryParse = source => {
    try {
      const parsed = JSON.parse(source)

      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
  const first = value.indexOf('{')
  const last = value.lastIndexOf('}')

  return tryParse(value) ?? (first >= 0 && last > first ? tryParse(value.slice(first, last + 1)) : null)
}

/** The envelope inside one parsed MCP result: `{ result: <text>, structuredContent: <envelope> }`. */
function envelopeIn(value) {
  if (!value) {
    return null
  }

  const structured = parse(value.structuredContent) ?? (typeof value.result === 'object' ? value.result : null)

  if (structured && 'ok' in structured) {
    return structured
  }

  if ('ok' in value && 'data' in value) {
    return value
  }

  if (typeof value.result === 'string') {
    // The structured half is missing: the server writes the data as the last JSON line of the text.
    const lines = value.result.split('\n').filter(line => line.startsWith('{'))
    const data = parse(lines[lines.length - 1])

    return data && (data.check || data.order) ? { ok: true, data } : null
  }

  return null
}

/**
 * The envelope from the cut-off start of a larger JSON document. Desktop caps a tool result in the
 * event at 64 KB; a result with an attached preview image is larger, so the event carries
 * `{ output: <the first 32 KB of the result's JSON>, truncated: true }`. The envelope is a few KB
 * and sits in the first text part, complete, as a JSON string literal: decode each complete string
 * literal in the fragment and take the first that holds an envelope.
 */
function envelopeInFragment(fragment) {
  let at = fragment.indexOf('"')

  while (at >= 0) {
    let end = at + 1

    while (end < fragment.length && fragment[end] !== '"') {
      end += fragment[end] === '\\' ? 2 : 1
    }

    if (end >= fragment.length) {
      return null
    }

    // Only a long literal can hold an envelope; short ones are keys and labels.
    if (end - at > 200) {
      let decoded = null

      try {
        decoded = JSON.parse(fragment.slice(at, end + 1))
      } catch {
        decoded = null
      }

      const found = typeof decoded === 'string' ? envelopeIn(parse(decoded)) : null

      if (found) {
        return found
      }
    }

    at = fragment.indexOf('"', end + 1)
  }

  return null
}

/**
 * The printsi envelope ({ ok, data }) from a tool result. Hermes hands an MCP result over as an
 * object or its JSON string. When the call returned images to a vision model, the result is
 * instead `{ _multimodal, content: [text parts, images], text_summary }`, the text may carry
 * Hermes's untrusted-result notice around the JSON, and Desktop may have cut the whole thing off.
 */
function envelopeOf(result) {
  const value = parse(result)

  if (value?.truncated === true && typeof (value.output ?? value.error) === 'string') {
    return envelopeInFragment(value.output ?? value.error)
  }

  if (!value?._multimodal) {
    return envelopeIn(value)
  }

  const texts = [value.text_summary, ...(Array.isArray(value.content) ? value.content.map(part => part?.text) : [])]

  for (const candidate of texts) {
    const found = typeof candidate === 'string' ? envelopeIn(parse(candidate)) : null

    if (found) {
      return found
    }
  }

  return null
}

const text = value => (typeof value === 'string' ? value : '')
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** The page the file was checked against, in inches: `check.layout` from the API, or null from an older one. */
function slimLayout(layout) {
  const w = number(layout?.trim_in?.width)
  const h = number(layout?.trim_in?.height)

  if (!w || !h || w <= 0 || h <= 0) {
    return null
  }

  const mm = [number(layout.trim_mm?.width), number(layout.trim_mm?.height)]

  return {
    w,
    h,
    mm: mm[0] && mm[1] ? mm : null,
    bleed: Math.max(0, number(layout.bleed_in) ?? 0),
    safe: Math.max(0, number(layout.safe_in) ?? 0),
    folds: (Array.isArray(layout.folds) ? layout.folds : [])
      .slice(0, 16)
      .map(fold => ({ page: number(fold?.page) ?? 1, down: fold?.axis === 'y', at: number(fold?.at_in) }))
      .filter(fold => fold.at !== null && fold.at > 0),
    transparent: layout.background === 'transparent'
  }
}

/** Keep only what the pane draws. Never the order token, the address lines, the phone or the email. */
function slimCheck(check) {
  const options = check.spec?.options ?? {}

  return {
    id: text(check.id),
    file: text(check.file?.name),
    pages: number(check.file?.pages) ?? 1,
    product: text(check.spec?.product),
    size: text(String(options.size ?? '')),
    sides: number(Number(options.sides)) ?? null,
    fold: text(options.fold),
    colour: text(options.colour),
    print: text(options.print),
    layout: slimLayout(check.layout),
    status: text(check.status),
    result: text(check.result),
    errors: number(check.counts?.error) ?? 0,
    warnings: number(check.counts?.warning) ?? 0,
    checksRun: Array.isArray(check.checks_run) ? check.checks_run.length : 0,
    preview: check.previews?.[0]
      ? { width: number(check.previews[0].width), height: number(check.previews[0].height) }
      : null,
    issues: (Array.isArray(check.issues) ? check.issues : []).slice(0, 12).map(issue => ({
      code: text(issue.code),
      severity: text(issue.severity),
      page: number(issue.page),
      observed: text(issue.observed),
      fix: text(issue.fix),
      region:
        issue.region && number(issue.region.width_in)
          ? {
              x: number(issue.region.x_in) ?? 0,
              y: number(issue.region.y_in) ?? 0,
              w: number(issue.region.width_in),
              h: number(issue.region.height_in) ?? 0
            }
          : null
    })),
    at: Date.now()
  }
}

function slimOrder(order, purchase, previous) {
  const chosen =
    (order.quotes ?? []).find(quote => quote.id === order.recommended_quote_id) ?? (order.quotes ?? [])[0]
  const to = order.ship_to ?? {}

  return {
    id: text(order.id),
    status: text(order.status),
    product: text(order.spec?.product),
    size: text(String(order.spec?.size ?? '')),
    quantity: number(order.spec?.quantity),
    file: text(order.file?.name),
    place: [text(to.city) || text(to.district), text(to.state) || text(to.country)].filter(Boolean).join(', '),
    // A paid order no longer lists quotes: keep the one it was bought on.
    quote: chosen
      ? {
          total: number(chosen.price?.total),
          display: text(chosen.price?.total_display),
          printing: number(chosen.price?.printing),
          shipping: number(chosen.price?.shipping),
          fee: number(chosen.price?.service_fee),
          tax: number(chosen.price?.tax),
          service: text(chosen.shipping?.label),
          earliest: text(chosen.delivery?.arrival?.earliest),
          latest: text(chosen.delivery?.arrival?.latest)
        }
      : (previous?.quote ?? null),
    payUrl: purchase ? text(purchase.approval_url) : (previous?.payUrl ?? ''),
    payAmount: purchase ? number(purchase.amount?.amount) : (previous?.payAmount ?? null),
    failure: text(order.failure?.message),
    at: Date.now()
  }
}

// ---------------------------------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------------------------------

const PRODUCTS = { flyer: 'Flyers', poster: 'Posters', brochure: 'Brochures', 'business-card': 'Business cards', postcard: 'Postcards', sticker: 'Stickers', letterhead: 'Letterhead', 'outdoor-poster': 'Outdoor posters', banner: 'Banners', calendar: 'Calendars', 'folded-card': 'Folded cards', canvas: 'Canvas prints', 'metal-print': 'Aluminium prints', 'acrylic-print': 'Acrylic prints', 'photo-tile': 'Photo tiles', mug: 'Mugs', bag: 'Bags', pillow: 'Pillows', 't-shirt': 'T-shirts', 'premium-t-shirt': 'Premium T-shirts', hoodie: 'Hoodies', sweatshirt: 'Sweatshirts' }
const SIZES = { '8.5x11': 'US Letter', '5.5x8.5': 'Half Letter', a3: 'A3', a4: 'A4', a5: 'A5', '11x17': 'Tabloid' }
const FOLDS = { half: 'half fold', trifold: 'tri-fold', z: 'Z-fold', gate: 'gate fold', w: 'W-fold', 'roll-4': 'roll fold' }
const MM = 1 / 25.4
const A_SIZES = {
  a2: [420 * MM, 594 * MM],
  a3: [297 * MM, 420 * MM],
  a4: [210 * MM, 297 * MM],
  a5: [148.5 * MM, 210 * MM],
  a6: [105 * MM, 148.5 * MM],
  a7: [74 * MM, 105 * MM]
}
/** Flat paper products: without a layout from the API, their size and the usual bleed are enough to draw them. */
const FLAT = new Set(['flyer', 'postcard', 'business-card', 'letterhead', 'sticker', 'poster'])

const money = cents => (cents === null || cents === undefined ? '' : `$${(cents / 100).toFixed(2)}`)
const ACRONYMS = /\b(rgb|cmyk|pdf|ppi|dpi|qr|icc)\b/gi
const sentence = code => {
  const words = String(code).toLowerCase().replaceAll('_', ' ')

  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(ACRONYMS, word => word.toUpperCase())
}

function day(iso) {
  const date = new Date(`${iso}T12:00:00`)

  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** `l` -> `L`, `2xl` -> `2XL`, `a6` -> `A6`: a garment or paper size. Any other by its everyday name, or as it is. */
const sizeName = size => SIZES[size] ?? (/^(\d?x{0,2}[sml]|\dxl|a\d)$/.test(size) ? size.toUpperCase() : size)
const trimmed = value => String(Number(value.toFixed(2)))

/**
 * What to draw, in inches: the trim (or print area), bleed, safe area and fold lines.
 *
 * From the layout the check came with. A result without one (an older API) is drawn from its size when the product
 * is a flat sheet, and otherwise as the page's outline alone (`known: false`): no bleed or safe line is invented,
 * and no issue is placed, because nothing says how large the page is.
 */
function geometry(check) {
  const layout = check.layout
  const preview = check.preview?.width && check.preview?.height ? check.preview : null

  if (layout) {
    const [a, b, unit] = layout.mm ? [...layout.mm, 'mm'] : [layout.w, layout.h, 'in']

    return scaled({ ...layout, area: layout.bleed === 0, label: `${trimmed(a)} × ${trimmed(b)} ${unit}` })
  }

  const metric = A_SIZES[check.size]
  const sized = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm)?$/.exec(check.size)
  const mm = Boolean(metric || sized?.[3])

  if (FLAT.has(check.product) && (metric || sized)) {
    let [w, h] = metric ?? [Number(sized[1]) * (mm ? MM : 1), Number(sized[2]) * (mm ? MM : 1)]

    if (preview && preview.width !== preview.height && preview.width > preview.height !== w > h) {
      ;[w, h] = [h, w]
    }

    const bleed = mm ? 3 * MM : 0.125

    return scaled({
      w,
      h,
      bleed,
      safe: check.product === 'poster' ? 0.25 : bleed,
      folds: [],
      transparent: false,
      area: false,
      label: mm ? `${trimmed(w / MM)} × ${trimmed(h / MM)} mm` : `${trimmed(w)} × ${trimmed(h)} in`
    })
  }

  // Nothing says how large the page is: its shape from the preview, or an upright sheet while the check runs.
  const long = preview ? Math.max(preview.width, preview.height) : 11
  const [w, h] = preview ? [preview.width / long, preview.height / long] : [8.5 / long, 1]

  return { w: w * 10, h: h * 10, bleed: 0, safe: 0, drawnBleed: 0, drawnSafe: 0, folds: [], transparent: false, area: false, known: false, label: '' }
}

/**
 * Drawn to scale, except that a bleed or safe area is never thinner than 3% of the long side: at true scale a 3 mm
 * margin on an A3 sheet is a hairline, and the three boxes would read as one. One that is zero is not drawn.
 */
function scaled(g) {
  const least = Math.max(g.w, g.h) * 0.03

  return { ...g, known: true, drawnBleed: g.bleed > 0 ? Math.max(g.bleed, least) : 0, drawnSafe: g.safe > 0 ? Math.max(g.safe, least) : 0 }
}

/** Only ever open printsi's own payment pages. */
function payLink(url) {
  try {
    const parsed = new URL(url)
    const ours = /^printsi-api-(live|sandbox)\.magnus-ahmad\.workers\.dev$/.test(parsed.hostname)

    return parsed.protocol === 'https:' && ours && parsed.pathname.startsWith('/approve/') ? parsed.href : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------------------------------

const C = {
  text: 'var(--ui-text-primary)',
  soft: 'var(--ui-text-secondary)',
  faint: 'var(--ui-text-tertiary)',
  ghost: 'var(--ui-text-quaternary)',
  line: 'var(--ui-stroke-secondary)',
  card: 'var(--ui-bg-card)',
  accent: 'var(--ui-accent)',
  good: 'var(--ui-green)',
  warn: 'var(--ui-orange)',
  bad: 'var(--ui-red)'
}
const tint = (color, amount) => `color-mix(in srgb, ${color} ${amount}%, transparent)`
const tone = severity => (severity === 'error' ? C.bad : severity === 'warning' ? C.warn : C.faint)

const S = {
  pane: { height: '100%', overflowY: 'auto', padding: '14px 14px 20px', fontSize: 12, lineHeight: 1.45, color: C.text },
  label: { fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.faint },
  row: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: 11 },
  clip: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  rule: { height: 1, background: C.line, opacity: 0.6, margin: '18px 0 16px', border: 0 }
}

function Dot({ color, size = 7 }) {
  return jsx('span', {
    'aria-hidden': true,
    style: { display: 'inline-block', width: size, height: size, borderRadius: '50%', background: color, flex: 'none' }
  })
}

// ---------------------------------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------------------------------

function verdict(check) {
  if (check.unread) {
    return { color: C.faint, title: 'Checked', detail: 'The result is in the chat.' }
  }

  if (check.status && check.status !== 'complete') {
    return { color: C.faint, title: 'Checking…', detail: 'The check is still running.' }
  }

  if (check.result === 'fail') {
    const count = check.errors || check.issues.filter(issue => issue.severity === 'error').length || 1

    return { color: C.bad, title: 'Not print-ready', detail: `${count} ${count === 1 ? 'issue' : 'issues'} to fix` }
  }

  if (check.result === 'pass_with_warnings') {
    const count = check.warnings || 1

    return { color: C.warn, title: 'Print-ready', detail: `${count} ${count === 1 ? 'warning' : 'warnings'} to look at` }
  }

  return {
    color: C.good,
    title: 'Print-ready',
    detail: check.checksRun ? `All ${check.checksRun} checks passed` : 'All checks passed'
  }
}

const DASH = { bleed: '4 3', safe: '1 3', fold: '7 3 1 3' }

/**
 * The page to scale: bleed (dashed), trim or print area (solid), safe area (dotted), fold lines (dash-dot) and each
 * issue where it sits. A garment's page is chequered: it is transparent, and only the design is printed.
 */
function PageDiagram({ check, page, active, onHover }) {
  const g = geometry(check)
  const W = g.w + g.drawnBleed * 2
  const H = g.h + g.drawnBleed * 2
  const pad = Math.max(W, H) * 0.04
  const unit = Math.max(W, H) / 100
  const passed = check.result === 'pass' && check.status === 'complete'
  // An issue's place is in inches from the trim: without the page's size there is nowhere to put it.
  const marked = check.issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => g.known && issue.region && (issue.page ?? 1) === page)
  const folds = g.folds.filter(fold => fold.page === page)
  const stroke = { vectorEffect: 'non-scaling-stroke', fill: 'none' }
  const chequer = `printsi-clear-${String(check.id).replace(/[^\w-]/g, '')}`
  const cell = unit * 3
  const parts = [g.label, g.area ? 'print area' : '', g.transparent ? 'transparent background' : '', folds.length ? `${folds.length} fold ${folds.length === 1 ? 'line' : 'lines'}` : '']
  // Each issue's number sits at the top-left of its region. Two regions that start at the same corner (text too
  // close to the top edge and to the left edge) would stack their numbers: the later one moves along its region.
  const radius = unit * 3.4
  const numbers = []
  const numberAt = (x, y, w, h) => {
    let at = [x + unit * 5, y + unit * 5]

    for (let tries = 0; tries < 12 && numbers.some(other => Math.hypot(other[0] - at[0], other[1] - at[1]) < radius * 2.2); tries++) {
      at = w >= h ? [at[0] + radius * 2.4, at[1]] : [at[0], at[1] + radius * 2.4]
    }

    numbers.push(at)

    return at
  }

  return jsxs('svg', {
    viewBox: `${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`,
    role: 'img',
    'aria-label': `Page ${page}, ${parts.filter(Boolean).join(', ')}, with ${marked.length} marked ${marked.length === 1 ? 'issue' : 'issues'}`,
    style: { display: 'block', width: '100%', maxHeight: 264, margin: '0 auto' },
    children: [
      g.transparent
        ? jsx('defs', {
            children: jsxs('pattern', {
              id: chequer,
              x: g.drawnBleed,
              y: g.drawnBleed,
              width: cell * 2,
              height: cell * 2,
              patternUnits: 'userSpaceOnUse',
              children: [
                jsx('rect', { width: cell * 2, height: cell * 2, fill: C.card }),
                jsx('rect', { width: cell, height: cell, fill: tint(C.ghost, 28) }),
                jsx('rect', { x: cell, y: cell, width: cell, height: cell, fill: tint(C.ghost, 28) })
              ]
            })
          })
        : null,
      g.drawnBleed > 0
        ? jsx('rect', { x: 0, y: 0, width: W, height: H, stroke: C.ghost, strokeWidth: 1, strokeDasharray: DASH.bleed, ...stroke })
        : null,
      jsx('rect', {
        x: g.drawnBleed,
        y: g.drawnBleed,
        width: g.w,
        height: g.h,
        vectorEffect: 'non-scaling-stroke',
        fill: g.transparent ? `url(#${chequer})` : passed ? tint(C.good, 7) : C.card,
        stroke: passed ? C.good : C.soft,
        strokeWidth: 1.25
      }),
      g.drawnSafe > 0
        ? jsx('rect', {
            x: g.drawnBleed + g.drawnSafe,
            y: g.drawnBleed + g.drawnSafe,
            width: Math.max(0, g.w - g.drawnSafe * 2),
            height: Math.max(0, g.h - g.drawnSafe * 2),
            stroke: C.ghost,
            strokeWidth: 1,
            strokeDasharray: DASH.safe,
            ...stroke
          })
        : null,
      // A fold runs the whole page, through the bleed, as the sheet is folded after it is cut.
      ...folds.map((fold, index) =>
        jsx(
          'line',
          {
            x1: fold.down ? 0 : g.drawnBleed + fold.at,
            y1: fold.down ? g.drawnBleed + fold.at : 0,
            x2: fold.down ? W : g.drawnBleed + fold.at,
            y2: fold.down ? g.drawnBleed + fold.at : H,
            stroke: C.faint,
            strokeWidth: 1,
            strokeDasharray: DASH.fold,
            ...stroke
          },
          `fold-${index}`
        )
      ),
      ...marked.map(({ issue, index }) => {
        const color = tone(issue.severity)
        const x = Math.min(Math.max(g.drawnBleed + issue.region.x, 0), W)
        const y = Math.min(Math.max(g.drawnBleed + issue.region.y, 0), H)
        const w = Math.min(issue.region.w, W - x)
        const h = Math.min(issue.region.h, H - y)
        const [cx, cy] = numberAt(x, y, w, h)
        const on = active === index

        return jsxs(
          'g',
          {
            onMouseEnter: () => onHover(index),
            onMouseLeave: () => onHover(null),
            style: { cursor: 'default' },
            children: [
              jsx('rect', {
                x,
                y,
                width: w,
                height: h,
                rx: unit * 0.8,
                vectorEffect: 'non-scaling-stroke',
                fill: tint(color, on ? 26 : 13),
                stroke: color,
                strokeWidth: on ? 2 : 1.25,
                style: { transition: 'fill 120ms ease' }
              }),
              jsx('circle', { cx, cy, r: radius, fill: color }),
              jsx('text', {
                x: cx,
                y: cy,
                textAnchor: 'middle',
                dominantBaseline: 'central',
                fontSize: unit * 4.2,
                fontWeight: 700,
                fill: 'var(--ui-bg-editor, var(--ui-bg-primary))',
                children: String(index + 1)
              })
            ]
          },
          index
        )
      }),
      passed
        ? jsx('path', {
            d: `M ${W / 2 - unit * 9} ${H / 2} l ${unit * 6} ${unit * 6} l ${unit * 12} ${-unit * 13}`,
            stroke: C.good,
            strokeWidth: 2.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            ...stroke
          })
        : null
    ]
  })
}

function Legend({ g, page, pages, onPage }) {
  // A folded sheet's two pages are its two sides.
  const side = g.folds.length > 0 && pages === 2 ? ` · ${page === 1 ? 'outside' : 'inside'}` : ''
  const swatch = dash =>
    jsx('svg', {
      width: 16,
      height: 6,
      'aria-hidden': true,
      children: jsx('line', { x1: 0, y1: 3, x2: 16, y2: 3, stroke: 'currentColor', strokeWidth: 1.25, strokeDasharray: dash })
    })
  const item = (dash, name) =>
    jsxs('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 }, children: [swatch(dash), name] })
  const turn = (to, glyph, name) =>
    jsx('button', {
      type: 'button',
      'aria-label': name,
      disabled: to < 1 || to > pages,
      onClick: () => onPage(to),
      style: {
        background: 'none',
        border: 0,
        padding: '0 4px',
        font: 'inherit',
        color: 'inherit',
        cursor: to < 1 || to > pages ? 'default' : 'pointer',
        opacity: to < 1 || to > pages ? 0.35 : 1
      },
      children: glyph
    })

  return jsxs('div', {
    style: { marginTop: 10, fontSize: 10, color: C.faint, display: 'grid', gap: 6, justifyItems: 'center' },
    children: [
      pages > 1
        ? jsxs('div', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 2, color: C.soft, fontSize: 11 },
            children: [turn(page - 1, '‹', 'Previous page'), `Page ${page} of ${pages}${side}`, turn(page + 1, '›', 'Next page')]
          })
        : null,
      g.known
        ? jsxs('div', {
            style: { display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' },
            children: [
              g.drawnBleed > 0 ? item(DASH.bleed, 'bleed') : null,
              item('', g.area ? 'print area' : 'trim'),
              g.drawnSafe > 0 ? item(DASH.safe, 'safe') : null,
              g.folds.length > 0 ? item(DASH.fold, 'fold') : null,
              jsx('span', { style: { color: C.ghost }, children: g.transparent ? `${g.label} · transparent` : g.label })
            ]
          })
        : null
    ]
  })
}

function IssueRow({ issue, index, active, onHover }) {
  const color = tone(issue.severity)

  return jsxs('li', {
    onMouseEnter: () => onHover(index),
    onMouseLeave: () => onHover(null),
    style: {
      display: 'flex',
      gap: 9,
      padding: '8px 9px',
      margin: '0 -9px',
      borderRadius: 6,
      background: active ? tint(color, 9) : 'transparent',
      transition: 'background 120ms ease'
    },
    children: [
      jsx('span', {
        'aria-hidden': true,
        style: {
          flex: 'none',
          width: 16,
          height: 16,
          marginTop: 1,
          borderRadius: '50%',
          background: color,
          color: 'var(--ui-bg-editor, var(--ui-bg-primary))',
          fontSize: 10,
          fontWeight: 700,
          display: 'grid',
          placeItems: 'center'
        },
        children: index + 1
      }),
      jsxs('div', {
        style: { minWidth: 0 },
        children: [
          jsxs('div', {
            style: { fontWeight: 600 },
            children: [sentence(issue.code), issue.page ? jsx('span', { style: { color: C.faint, fontWeight: 400 }, children: ` · page ${issue.page}` }) : null]
          }),
          issue.observed ? jsx('div', { style: { color: C.soft, marginTop: 2 }, children: issue.observed }) : null,
          issue.fix ? jsx('div', { style: { color: C.faint, marginTop: 3 }, children: issue.fix }) : null
        ]
      })
    ]
  })
}

function Preflight({ check }) {
  const [active, setActive] = useState(null)
  const pages = Math.max(1, check.pages)
  const [page, setPage] = useState(() => check.issues.find(issue => issue.region)?.page ?? 1)
  const v = verdict(check)
  const g = geometry(check)
  // What was chosen: a fold, a colour and where a garment is printed say more than the number of sides.
  const chosen = [FOLDS[check.fold] ?? check.fold, check.colour, check.print].filter(Boolean)
  const spec = [
    PRODUCTS[check.product] ?? sentence(check.product),
    sizeName(check.size),
    ...(chosen.length > 0 ? chosen : [check.sides ? `${check.sides}-sided` : ''])
  ]
    .filter(Boolean)
    .join(' · ')

  return jsxs('section', {
    children: [
      jsx('div', { style: S.label, children: 'Preflight' }),
      jsxs('div', {
        style: { ...S.row, alignItems: 'center', marginTop: 10 },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
            children: [
              jsx(Dot, { color: v.color, size: 9 }),
              jsx('span', { style: { fontSize: 15, fontWeight: 650, letterSpacing: '-0.01em' }, children: v.title })
            ]
          }),
          jsx('span', { style: { color: C.soft, flex: 'none' }, children: v.detail })
        ]
      }),
      jsxs('div', {
        style: { ...S.row, marginTop: 4, color: C.faint },
        children: [
          jsx(Tip, { label: check.file, children: jsx('span', { style: { ...S.mono, ...S.clip, flex: '1 1 0' }, children: check.file }) }),
          jsx('span', { style: { flex: 'none' }, children: spec })
        ]
      }),
      jsx('div', { style: { marginTop: 16 }, children: jsx(PageDiagram, { check, page, active, onHover: setActive }) }),
      jsx(Legend, { g, page, pages, onPage: setPage }),
      check.issues.length > 0
        ? jsx('ol', {
            style: { listStyle: 'none', margin: '12px 0 0', padding: 0 },
            children: check.issues.map((issue, index) =>
              jsx(
                IssueRow,
                {
                  issue,
                  index,
                  active: active === index,
                  onHover: hovered => {
                    setActive(hovered)

                    if (hovered !== null && issue.region && issue.page) {
                      setPage(issue.page)
                    }
                  }
                },
                `${issue.code}-${index}`
              )
            )
          })
        : null
    ]
  })
}

// ---------------------------------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------------------------------

const STEPS = ['Quote', 'Pay', 'Print', 'Ship', 'Delivered']
/** How many steps are done, and whether the next one is waiting on something. */
const PROGRESS = {
  quoted: [1, 'Quote ready'],
  awaiting_approval: [1, 'Waiting for payment'],
  submitting: [2, 'Sending to the printer'],
  accepted: [2, 'Accepted by the printer'],
  in_production: [2, 'Printing'],
  shipped: [4, 'On its way'],
  ready_for_pickup: [4, 'Ready to collect'],
  delivered: [5, 'Delivered'],
  collected: [5, 'Collected']
}
const STOPPED = {
  canceled: 'Canceled',
  failed: 'Not placed',
  expired: 'Quote expired',
  under_resolution: 'Being looked into',
  file_problem: 'File needs fixing',
  needs_info: 'More details needed'
}

function Steps({ done, stopped }) {
  const color = stopped ? C.ghost : done >= STEPS.length ? C.good : C.accent

  return jsx('ol', {
    style: { display: 'grid', gridTemplateColumns: `repeat(${STEPS.length}, 1fr)`, listStyle: 'none', margin: '14px 0 0', padding: 0 },
    children: STEPS.map((name, index) => {
      const reached = index < done
      const current = !stopped && index === done

      return jsxs(
        'li',
        {
          style: { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
          'aria-current': current ? 'step' : undefined,
          children: [
            index > 0
              ? jsx('span', {
                  'aria-hidden': true,
                  style: {
                    position: 'absolute',
                    top: 5,
                    right: '50%',
                    width: '100%',
                    height: 2,
                    background: reached || current ? color : C.line,
                    opacity: reached || current ? 1 : 0.6
                  }
                })
              : null,
            jsx('span', {
              'aria-hidden': true,
              style: {
                position: 'relative',
                width: 12,
                height: 12,
                borderRadius: '50%',
                boxSizing: 'border-box',
                background: reached ? color : 'var(--ui-bg-editor, var(--ui-bg-primary))',
                border: `2px solid ${reached || current ? color : C.line}`,
                boxShadow: current ? `0 0 0 4px ${tint(C.accent, 18)}` : 'none'
              }
            }),
            jsx('span', {
              style: { fontSize: 10, color: reached || current ? C.text : C.faint, fontWeight: current ? 600 : 400 },
              children: name
            })
          ]
        },
        name
      )
    })
  })
}

function PriceLine({ name, cents, strong }) {
  return jsxs('div', {
    style: { ...S.row, color: strong ? C.text : C.soft, fontWeight: strong ? 600 : 400 },
    children: [jsx('span', { children: name }), jsx('span', { style: { fontVariantNumeric: 'tabular-nums' }, children: money(cents) })]
  })
}

function Order({ order, os }) {
  const [done, status] = PROGRESS[order.status] ?? [0, '']
  const stopped = STOPPED[order.status]
  const quote = order.quote
  const total = quote?.display || money(order.payAmount ?? quote?.total)
  const link = order.status === 'awaiting_approval' ? payLink(order.payUrl) : null
  const title = [order.quantity ? `${order.quantity} ×` : '', PRODUCTS[order.product] ?? sentence(order.product), sizeName(order.size)]
    .filter(Boolean)
    .join(' ')
  const arrives = quote?.earliest && quote?.latest ? `${day(quote.earliest)} – ${day(quote.latest)}` : ''

  return jsxs('section', {
    children: [
      jsx('div', { style: S.label, children: 'Order' }),
      jsxs('div', {
        style: { ...S.row, marginTop: 10 },
        children: [
          jsx('span', { style: { fontSize: 15, fontWeight: 650, letterSpacing: '-0.01em', ...S.clip }, children: title }),
          jsx('span', { style: { fontSize: 15, fontWeight: 650, fontVariantNumeric: 'tabular-nums', flex: 'none' }, children: total })
        ]
      }),
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 7, marginTop: 4, color: stopped ? C.warn : C.soft },
        children: [jsx(Dot, { color: stopped ? C.warn : done >= 5 ? C.good : C.accent }), stopped ?? status ?? sentence(order.status)]
      }),
      jsx(Steps, { done, stopped: Boolean(stopped) }),
      order.status === 'quoted'
        ? jsx('div', {
            style: { marginTop: 12, fontSize: 11, color: C.faint },
            children: 'Nothing is ordered yet. Tell Hermes to go ahead and it will bring you a payment link.'
          })
        : null,
      order.failure ? jsx('div', { style: { marginTop: 12, color: C.soft }, children: order.failure }) : null,
      link
        ? jsx('div', {
            style: { marginTop: 16 },
            children: jsx(Button, {
              style: { width: '100%' },
              onClick: () => os.openExternal(link),
              children: `Review and pay ${total}`
            })
          })
        : null,
      link
        ? jsx('div', {
            style: { marginTop: 7, fontSize: 11, color: C.faint, textAlign: 'center' },
            children: 'Opens Stripe in your browser. Your card is held until the printer accepts.'
          })
        : null,
      quote
        ? jsxs('div', {
            style: { display: 'grid', gap: 4, marginTop: 16 },
            children: [
              jsx(PriceLine, { name: 'Printing', cents: quote.printing }),
              jsx(PriceLine, { name: quote.service ? `Delivery · ${quote.service}` : 'Delivery', cents: quote.shipping }),
              jsx(PriceLine, { name: 'Service fee', cents: quote.fee }),
              quote.tax ? jsx(PriceLine, { name: 'Tax', cents: quote.tax }) : null,
              jsx('div', { style: { height: 1, background: C.line, opacity: 0.6, margin: '4px 0' } }),
              jsx(PriceLine, { name: 'Total', cents: quote.total, strong: true })
            ]
          })
        : null,
      jsxs('div', {
        style: { display: 'grid', gap: 4, marginTop: 14, color: C.soft },
        children: [
          order.place ? jsxs('div', { style: S.row, children: [jsx('span', { style: { color: C.faint }, children: 'To' }), order.place] }) : null,
          arrives && done < 5
            ? jsxs('div', { style: S.row, children: [jsx('span', { style: { color: C.faint }, children: 'Arrives' }), arrives] })
            : null,
          jsxs('div', {
            style: S.row,
            children: [
              jsx('span', { style: { color: C.faint, flex: 'none' }, children: 'Order' }),
              jsx(Tip, {
                label: 'Copy order id',
                children: jsx('button', {
                  type: 'button',
                  onClick: () => os.writeClipboard(order.id).then(ok => ok && host.notify({ kind: 'info', message: 'Order id copied' })),
                  style: { ...S.mono, ...S.clip, color: 'inherit', background: 'none', border: 0, padding: 0, cursor: 'pointer' },
                  children: order.id
                })
              })
            ]
          })
        ]
      })
    ]
  })
}

// ---------------------------------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------------------------------

function Empty() {
  return jsxs('div', {
    style: { height: '100%', display: 'grid', placeContent: 'center', justifyItems: 'center', gap: 10, padding: 24, textAlign: 'center' },
    children: [
      jsxs('svg', {
        width: 44,
        height: 56,
        viewBox: '0 0 44 56',
        'aria-hidden': true,
        style: { color: C.ghost },
        children: [
          jsx('rect', { x: 1, y: 1, width: 42, height: 54, fill: 'none', stroke: 'currentColor', strokeDasharray: '4 3' }),
          jsx('rect', { x: 5, y: 5, width: 34, height: 46, fill: 'none', stroke: C.faint })
        ]
      }),
      jsx('div', { style: { fontSize: 13, fontWeight: 600, color: C.text }, children: 'Nothing checked yet' }),
      jsx('div', {
        style: { fontSize: 12, color: C.faint, maxWidth: 220 },
        children: 'Ask Hermes to check a PDF for print, or to print it. The page and the order show up here.'
      })
    ]
  })
}

function Pane({ $state, os }) {
  const { check, order } = useValue($state)

  if (!check && !order) {
    return jsx(Empty, {})
  }

  return jsxs('div', {
    style: S.pane,
    children: [
      check ? jsx(Preflight, { check }, check.id) : null,
      check && order ? jsx('hr', { style: S.rule }) : null,
      order ? jsx(Order, { order, os }, order.id) : null
    ]
  })
}

export default {
  id: 'printsi',
  name: 'printsi',
  register(ctx) {
    const saved = ctx.storage.get('state', null)
    const $state = atom({ check: saved?.check ?? null, order: saved?.order ?? null })

    const update = patch => {
      $state.set({ ...$state.get(), ...patch })
      ctx.storage.set('state', $state.get())
    }

    /** A check that is running, or one whose result could not be read: never an older verdict. */
    const placeholder = (args, extra) => ({
      id: `pending-${Date.now()}`,
      file: text(args?.pdf).split(/[\\/]/).pop() ?? '',
      pages: 1,
      product: text(args?.product),
      size: text(String(args?.size ?? '')).toLowerCase(),
      sides: null,
      fold: '',
      colour: '',
      print: '',
      layout: null,
      status: 'running',
      result: '',
      errors: 0,
      warnings: 0,
      checksRun: 0,
      preview: null,
      issues: [],
      at: Date.now(),
      ...extra
    })

    ctx.onEvent('tool.start', event => {
      const payload = event?.payload ?? {}

      if (printsiTool(payload.name) === 'check') {
        update({ check: placeholder(payload.args) })
      }
    })

    ctx.onEvent('tool.complete', event => {
      const payload = event?.payload ?? {}
      const tool = printsiTool(payload.name)
      const envelope = tool ? envelopeOf(payload.result) : null

      if (!envelope || envelope.ok !== true || !envelope.data) {
        // A check that failed to run, or a result this pane could not read: clear the old verdict.
        if (tool === 'check' && $state.get().check?.status === 'running') {
          update({ check: envelope && envelope.ok === false ? null : placeholder(payload.args, { status: 'complete', unread: true }) })
        }

        return
      }

      if (tool === 'check' && envelope.data.check) {
        update({ check: slimCheck(envelope.data.check) })
      } else if (tool.startsWith('order_') && envelope.data.order?.id) {
        const current = $state.get().order
        const previous = current?.id === envelope.data.order.id ? current : null

        update({ order: slimOrder(envelope.data.order, envelope.data.purchase, previous) })
      }
    })

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'printsi',
      data: { placement: 'right', width: '320px' },
      render: () => jsx(Pane, { $state, os: ctx.os })
    })
  }
}
