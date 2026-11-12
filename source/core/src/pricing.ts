/**
 * The only place the service fee is calculated (spec 05 §1).
 *
 * The fee may be at most 10% of the pre-tax subtotal S = C + F, where C is supplier printing + shipping:
 * F ≤ 0.10·(C + F)  ⇔  F ≤ C/9. In general F = floor(C · bps / (10000 − bps)); flooring means cent rounding can never
 * push the fee over the ceiling. Tax is calculated afterwards on S and never enters the fee.
 */

export const MAX_FEE_BPS = 1000;

export interface PriceLines {
  printCents: number;
  shipCents: number;
  feeCents: number;
  subtotalCents: number;
  feeBps: number;
}

export function priceQuote({
  printCents,
  shipCents,
  feeBps,
}: {
  printCents: number;
  shipCents: number;
  feeBps: number;
}): PriceLines {
  if (!Number.isInteger(printCents) || !Number.isInteger(shipCents) || printCents < 0 || shipCents < 0) {
    throw new RangeError("printing and shipping must be non-negative integer cents");
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new RangeError(`fee must be 0–${MAX_FEE_BPS} basis points`);
  }
  const cost = printCents + shipCents;
  const feeCents = Math.floor((cost * feeBps) / (10_000 - feeBps));
  return { printCents, shipCents, feeCents, subtotalCents: cost + feeCents, feeBps };
}

/** Supplier prices arrive in dollars, sometimes with 4 decimals; round up so our cost basis covers the charge. */
export function dollarsToCentsCeil(dollars: number): number {
  return Math.ceil(Math.round(dollars * 1_000_000) / 10_000);
}

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** "450", "450.5", "$450.00" → 45000. Returns null for anything else. */
export function parseUsd(input: string): number | null {
  const m = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}
