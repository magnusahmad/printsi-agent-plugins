/**
 * printsi for Hermes Desktop: one pane that shows what the agent's printsi tools just did.
 *
 *   Preflight  the page drawn to scale (bleed, trim, safe area) with each issue marked where it is,
 *              and the fix for it.
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
 * The printsi envelope ({ ok, data }) from a tool result. Hermes hands an MCP result over as an
 * object or its JSON string. When the call returned images to a vision model, the result is
 * instead `{ _multimodal, content: [text parts, images], text_summary }`, and the text may carry
 * Hermes's untrusted-result notice around the JSON.
 */
function envelopeOf(result) {
  const value = parse(result)

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

const PRODUCTS = { flyer: 'Flyers', poster: 'Posters', brochure: 'Brochures', 'business-card': 'Business cards' }
const SIZES = { '8.5x11': 'US Letter', '5.5x8.5': 'Half Letter', a3: 'A3', a4: 'A4', a5: 'A5', '11x17': 'Tabloid' }
const MM = 1 / 25.4
const A_SIZES = { a3: [297 * MM, 420 * MM], a4: [210 * MM, 297 * MM], a5: [148.5 * MM, 210 * MM] }

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

/** Trim size, bleed and safe area in inches, from the size option (and the preview's shape, for orientation). */
function geometry(check) {
  const metric = A_SIZES[check.size]
  const inches = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(check.size)
  let [w, h] = metric ?? (inches ? [Number(inches[1]), Number(inches[2])] : [8.5, 11])
  const bleed = metric ? 3 * MM : 0.125
  const safe = check.product === 'poster' ? 0.25 : bleed
  const landscape = check.preview?.width && check.preview?.height && check.preview.width > check.preview.height

  if (landscape !== w > h && check.preview?.width) {
    ;[w, h] = [h, w]
  }

  const mm = value => Number((value / MM).toFixed(1))
  // Drawn to scale, except that bleed and safe area are never thinner than 3% of the long side: at true scale a
  // 3 mm margin on an A3 sheet is a hairline, and the three boxes would read as one.
  const least = Math.max(w, h) * 0.03

  return {
    w,
    h,
    bleed: Math.max(bleed, least),
    safe: Math.max(safe, least),
    label: metric ? `${mm(w)} × ${mm(h)} mm` : `${w} × ${h} in`
  }
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

/** The page to scale: bleed (dashed), trim (solid), safe area (dotted) and each issue where it sits. */
function PageDiagram({ check, page, active, onHover }) {
  const g = geometry(check)
  const W = g.w + g.bleed * 2
  const H = g.h + g.bleed * 2
  const pad = Math.max(W, H) * 0.04
  const unit = Math.max(W, H) / 100
  const passed = check.result === 'pass' && check.status === 'complete'
  const marked = check.issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => issue.region && (issue.page ?? 1) === page)
  const stroke = { vectorEffect: 'non-scaling-stroke', fill: 'none' }

  return jsxs('svg', {
    viewBox: `${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`,
    role: 'img',
    'aria-label': `Page ${page}, ${g.label}, with ${marked.length} marked ${marked.length === 1 ? 'issue' : 'issues'}`,
    style: { display: 'block', width: '100%', maxHeight: 264, margin: '0 auto' },
    children: [
      jsx('rect', { x: 0, y: 0, width: W, height: H, stroke: C.ghost, strokeWidth: 1, strokeDasharray: '4 3', ...stroke }),
      jsx('rect', {
        x: g.bleed,
        y: g.bleed,
        width: g.w,
        height: g.h,
        vectorEffect: 'non-scaling-stroke',
        fill: passed ? tint(C.good, 7) : C.card,
        stroke: passed ? C.good : C.soft,
        strokeWidth: 1.25
      }),
      jsx('rect', {
        x: g.bleed + g.safe,
        y: g.bleed + g.safe,
        width: Math.max(0, g.w - g.safe * 2),
        height: Math.max(0, g.h - g.safe * 2),
        stroke: C.ghost,
        strokeWidth: 1,
        strokeDasharray: '1 3',
        ...stroke
      }),
      ...marked.map(({ issue, index }) => {
        const color = tone(issue.severity)
        const x = Math.min(Math.max(g.bleed + issue.region.x, 0), W)
        const y = Math.min(Math.max(g.bleed + issue.region.y, 0), H)
        const w = Math.min(issue.region.w, W - x)
        const h = Math.min(issue.region.h, H - y)
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
              jsx('circle', { cx: x + unit * 5, cy: y + unit * 5, r: unit * 3.4, fill: color }),
              jsx('text', {
                x: x + unit * 5,
                y: y + unit * 5,
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

function Legend({ label, page, pages, onPage }) {
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
            children: [turn(page - 1, '‹', 'Previous page'), `Page ${page} of ${pages}`, turn(page + 1, '›', 'Next page')]
          })
        : null,
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' },
        children: [item('4 3', 'bleed'), item('', 'trim'), item('1 3', 'safe'), jsx('span', { style: { color: C.ghost }, children: label })]
      })
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
  const spec = [PRODUCTS[check.product] ?? sentence(check.product), SIZES[check.size] ?? check.size, check.sides ? `${check.sides}-sided` : '']
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
      jsx(Legend, { label: geometry(check).label, page, pages, onPage: setPage }),
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
  const title = [order.quantity ? `${order.quantity} ×` : '', PRODUCTS[order.product] ?? sentence(order.product), SIZES[order.size] ?? order.size]
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
