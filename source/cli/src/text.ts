import type { Envelope } from "@internal/core";

/** Human rendering of an envelope (spec 01 §4.4). Not a stable format; agents should use JSON. */
export function renderText(envelope: Envelope): string {
  const lines: string[] = [];
  if (envelope.ok) {
    if (envelope.summary) lines.push(envelope.summary);
    else lines.push(JSON.stringify(envelope.data, null, 2));
  } else {
    lines.push(`Error ${envelope.error.code}: ${envelope.error.message}`);
    const allowed = envelope.error.details?.allowed ?? envelope.error.details?.available;
    if (Array.isArray(allowed)) lines.push(`  Allowed: ${allowed.join(", ")}`);
  }
  for (const w of envelope.warnings ?? []) lines.push(`Warning: ${w.message}`);
  if (envelope.next_actions.length > 0) {
    lines.push("", "Next:");
    for (const a of envelope.next_actions) {
      lines.push(`  ${a.description}${a.command ? `\n    ${a.command}` : ""}${a.url ? `\n    ${a.url}` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
