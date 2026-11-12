import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { AppError, BRAND, type Envelope, type Warning } from "@internal/core";
import { apiRequest, request } from "./http.js";
import { withCredential } from "./session.js";
import type { Settings } from "./settings.js";

/** Matches the API's limit while uploads stream through the Worker (apps/api/src/routes/files.ts). */
const MAX_BYTES = 100 * 1024 * 1024;
const LONG_POLL_S = 25;

export interface CheckInput {
  file: string;
  product: string;
  options: Record<string, string>;
  previewDir: string | undefined;
  allIssues: boolean;
}

interface CheckView {
  id: string;
  status: "queued" | "running" | "complete" | "error";
  previews: { page: number; url: string }[];
}

/** `check <pdf>` (spec 01 §7.3): local checks, upload (deduplicated by hash), server check, optional previews. */
export async function runCheck(
  settings: Settings,
  vars: Record<string, string | undefined>,
  input: CheckInput,
): Promise<Envelope> {
  const deadline = Date.now() + settings.timeoutMs;
  const path = resolve(input.file);
  const local = await inspectLocalFile(path);
  return withCredential(settings, vars, (warnings) => checkUploaded(settings, input, path, local, deadline, warnings));
}

async function checkUploaded(
  settings: Settings,
  input: CheckInput,
  path: string,
  { bytes, sha256 }: { bytes: number; sha256: string },
  deadline: number,
  initialWarnings: Warning[],
): Promise<Envelope> {
  const warnings = [...initialWarnings];
  const fileId = await uploadFile(settings, path, { bytes, sha256 }, deadline);

  let envelope = await expectOk(
    await apiRequest(settings, {
      method: "POST",
      path: "/v1/checks",
      json: { file_id: fileId, spec: { product: input.product, options: input.options } },
      deadline,
    }),
  );
  let check = (envelope.data as { check: CheckView }).check;
  let polled = false;
  const query = (wait: number) => ({ wait_seconds: String(wait), ...(input.allIssues && { all_issues: "true" }) });
  while ((check.status === "queued" || check.status === "running") && Date.now() < deadline - 1000) {
    const wait = Math.min(LONG_POLL_S, Math.floor((deadline - Date.now()) / 1000) - 1);
    envelope = await expectOk(
      await apiRequest(settings, { path: `/v1/checks/${check.id}`, query: query(wait), deadline }),
    );
    check = (envelope.data as { check: CheckView }).check;
    polled = true;
  }
  // A reused (already complete) check comes back from the POST with grouped issues; fetch the full list.
  if (input.allIssues && !polled && check.status === "complete") {
    envelope = await expectOk(
      await apiRequest(settings, { path: `/v1/checks/${check.id}`, query: query(0), deadline }),
    );
    check = (envelope.data as { check: CheckView }).check;
  }
  let nextActions = envelope.next_actions;
  if (check.status === "queued" || check.status === "running") {
    // Re-run with the same arguments: the upload and the check are reused, so the options must match the original.
    const args: Record<string, unknown> = {
      _: [input.file],
      product: input.product,
      ...input.options,
      ...(input.previewDir && { "preview-dir": input.previewDir }),
      ...(input.allIssues && { "all-issues": true }),
    };
    const resume = {
      kind: "command" as const,
      description: "Resume the check with the same options.",
      op: "check",
      args,
      requires_human: false,
      spends_money: false,
    };
    nextActions = [resume];
    warnings.push({
      code: "CHECK_STILL_RUNNING",
      message: `The check hadn't finished within the timeout. Run the resume command again; the upload and check are reused.`,
    });
  }

  if (input.previewDir && check.status === "complete" && check.previews.length > 0) {
    const dir = resolve(input.previewDir);
    await mkdir(dir, { recursive: true });
    for (const preview of check.previews) {
      const res = await request(settings, { path: preview.url, deadline, headers: { Accept: "image/png" } });
      if (!res.ok)
        throw new AppError(
          "unavailable",
          "PREVIEW_DOWNLOAD_FAILED",
          `Couldn't download page ${preview.page} preview (${res.status}).`,
        );
      const localPath = join(dir, `page-${preview.page}.png`);
      await writeFile(localPath, new Uint8Array(await res.arrayBuffer()));
      Object.assign(preview, { local_path: localPath });
    }
  }
  return { ...envelope, next_actions: nextActions, warnings: [...(envelope.warnings ?? []), ...warnings] };
}

/** Uploads a local PDF unless the server already holds identical bytes for this principal; returns the file id. */
export async function uploadFile(
  settings: Settings,
  path: string,
  { bytes, sha256 }: { bytes: number; sha256: string },
  deadline: number,
): Promise<string> {
  const created = await expectOk(
    await apiRequest(settings, {
      method: "POST",
      path: "/v1/files",
      json: { name: basename(path), bytes, sha256, content_type: "application/pdf", purpose: "artwork" },
      deadline,
    }),
  );
  const { file, upload } = created.data as {
    file: { id: string };
    upload: { url: string; method: "PUT"; headers: Record<string, string> } | null;
  };
  if (upload) {
    await expectOk(
      await apiRequest(settings, {
        method: upload.method,
        path: upload.url,
        headers: upload.headers,
        body: () => Readable.toWeb(createReadStream(path)) as unknown as ReadableStream,
        deadline,
      }),
    );
  }
  return file.id;
}

export async function inspectLocalFile(path: string): Promise<{ bytes: number; sha256: string }> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw new AppError("invalid_request", "FILE_NOT_FOUND", `No file at ${path}.`, { param: "pdf" });
  }
  if (size > MAX_BYTES) {
    throw new AppError(
      "invalid_request",
      "FILE_TOO_LARGE",
      `${basename(path)} is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`,
      {
        param: "pdf",
        details: { bytes: size, max_bytes: MAX_BYTES },
      },
    );
  }
  // PDF readers accept the header anywhere in the first 1024 bytes.
  const handle = await open(path, "r");
  const head = Buffer.alloc(1024);
  try {
    await handle.read(head, 0, 1024, 0);
  } finally {
    await handle.close();
  }
  if (!head.includes("%PDF-")) {
    throw new AppError(
      "invalid_request",
      "NOT_PDF",
      `${basename(path)} isn't a PDF. Only print-ready PDFs are accepted: export or convert the design to PDF first, with 0.125 in bleed (see \`${BRAND.name} products show <product>\` for exact sizes).`,
      { param: "pdf" },
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { bytes: size, sha256: hash.digest("hex") };
}

export async function expectOk(envelope: Envelope): Promise<Envelope & { ok: true }> {
  if (!envelope.ok) {
    throw new AppError(envelope.error.type, envelope.error.code, envelope.error.message, {
      ...(envelope.error.param !== undefined && { param: envelope.error.param }),
      ...(envelope.error.details !== undefined && { details: envelope.error.details }),
      retryable: envelope.error.retryable,
      nextActions: envelope.next_actions,
    });
  }
  return envelope;
}
