import { NextResponse } from "next/server";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lists every model that's been downloaded onto THIS node — not just the
 * ones currently held in VRAM. Calls `closedmesh models installed` and
 * parses its decorated text output into `{ id, sizeBytes }` records.
 *
 * The CLI's `installed` output is grouped by model and looks roughly like:
 *
 *   💾 Installed models
 *   📁 HF cache: /Users/al/.cache/huggingface/hub
 *
 *   📦 Qwen3-8B-Q4_K_M
 *      type: 🦙 GGUF
 *      size: 5.0GB 📏
 *      owner: mesh-managed
 *      …
 *
 *   📦 Qwen3-0.6B-Q4_K_M
 *      …
 *
 * Earlier versions of this route called `closedmesh models list`, which
 * doesn't exist as a subcommand and silently fell through to printing the
 * recommended-models catalog. The result was a Models page peppered with
 * "Custom model — not in our catalog" rows whose IDs were the first token
 * of each catalog header line ("•", "📚", "Qwen3", "Small", …). The new
 * subcommand and parser fix that.
 */

export type LocalModel = {
  id: string;
  /** Bytes on disk if the CLI reported it; null otherwise. */
  sizeBytes: number | null;
};

export async function GET() {
  if (isPublic) {
    return NextResponse.json({
      ok: false,
      message: "Model management isn't exposed on the hosted public site.",
      models: [] as LocalModel[],
    });
  }

  const bin = await findClosedmeshBin();
  if (!bin) {
    return NextResponse.json({
      ok: false,
      message: "closedmesh binary not found on this machine.",
      models: [] as LocalModel[],
    });
  }

  const result = await runClosedmesh(bin, ["models", "installed"]);
  if (!result.ok) {
    return NextResponse.json({
      ok: false,
      message:
        result.stderr || result.stdout || "closedmesh models installed failed",
      models: [] as LocalModel[],
    });
  }

  const models = parseInstalledOutput(result.stdout);
  return NextResponse.json({ ok: true, models });
}

const SIZE_UNITS: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/**
 * Parse the indented `📦 <id>` blocks from `closedmesh models installed`.
 *
 * We deliberately don't try to parse every key — just the model ID (the
 * line that starts with the package emoji) and the on-disk size (the
 * `size:` row). Everything else (capabilities, draft model, last-used
 * timestamp) is shown by the CLI for human convenience but isn't needed
 * by the dashboard.
 */
function parseInstalledOutput(stdout: string): LocalModel[] {
  const out: LocalModel[] = [];
  let currentId: string | null = null;
  let currentSize: number | null = null;

  const flush = () => {
    if (currentId) out.push({ id: currentId, sizeBytes: currentSize });
    currentId = null;
    currentSize = null;
  };

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();

    // Block headers look like "📦 Qwen3-8B-Q4_K_M". The package emoji is
    // U+1F4E6; we accept either the emoji or a literal "Model:" prefix
    // for forward-compatibility if the CLI switches to plain text later.
    const headerMatch = line.match(/^(?:📦|Model:)\s+(\S+)\s*$/);
    if (headerMatch) {
      flush();
      currentId = headerMatch[1];
      continue;
    }

    if (!currentId) continue;

    // size lines look like "   size: 5.0GB 📏" (occasionally with a
    // trailing emoji). Extract the leading number + unit.
    const sizeMatch = line.match(
      /^\s*size:\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)B?(?:\s|$)/i,
    );
    if (sizeMatch) {
      const num = Number(sizeMatch[1]);
      const mult = sizeMatch[2] ? SIZE_UNITS[sizeMatch[2].toUpperCase()] : 1;
      if (Number.isFinite(num)) currentSize = Math.round(num * mult);
    }
  }
  flush();
  return out;
}
