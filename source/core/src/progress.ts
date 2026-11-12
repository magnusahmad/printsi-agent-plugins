/**
 * When a wait target has been reached (spec 01 §7.11). Targets are stages; an order that ends or needs a person
 * (failed, canceled, under_resolution, file_problem, needs_info) also ends the wait, so the agent sees why.
 */
const STAGE: Record<string, number> = {
  checking: 0,
  quoting: 0,
  quoted: 1,
  expired: 1,
  awaiting_approval: 2,
  submitting: 3,
  accepted: 4,
  in_production: 5,
  shipped: 6,
  ready_for_pickup: 6,
  delivered: 7,
  collected: 7,
};
const TARGET: Record<string, number> = { quoted: 1, settled: 1, paid: 3, accepted: 4, shipped: 6, delivered: 7 };
const STOPS = new Set(["failed", "canceled", "under_resolution", "file_problem", "needs_info"]);

/** Targets that are exact statuses rather than stages: `shipped` would otherwise also match a pickup order. */
const EXACT: Record<string, string[]> = { ready_for_pickup: ["ready_for_pickup", "collected"] };

export const WAIT_TARGET_NAMES = [...Object.keys(TARGET), ...Object.keys(EXACT)];

export function waitReached(status: string, target: string): boolean {
  if (STOPS.has(status)) return true;
  const exact = EXACT[target];
  if (exact) return exact.includes(status);
  const want = TARGET[target];
  const at = STAGE[status];
  return want !== undefined && at !== undefined && at >= want;
}
