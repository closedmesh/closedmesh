import { NextResponse } from "next/server";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lists every model that's been downloaded onto THIS node — not just the
 * ones currently held in VRAM. Calls `closedmesh models list` and parses
 * its plain-text output (one model id per line, optionally followed by a
 * size suffix like "5.0G"). The CLI's machine-readable JSON mode lands
 * in a future runtime release, until then this is intentionally lenient.
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

  const result = await runClosedmesh(bin, ["models", "list"]);
  if (!result.ok) {
    return NextResponse.json({
      ok: false,
      message:
        result.stderr || result.stdout || "closedmesh models list failed",
      models: [] as LocalModel[],
    });
  }

  const models = parseModelsList(result.stdout);
  return NextResponse.json({ ok: true, models });
}

const SIZE_UNITS: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

function parseModelsList(stdout: string): LocalModel[] {
  const out: LocalModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Tolerate: "Qwen3-8B-Q4_K_M", "Qwen3-8B-Q4_K_M  4.6G",
    // "Qwen3-8B-Q4_K_M\t4881088512".
    const tokens = line.split(/\s+/);
    const id = tokens[0];
    if (!id) continue;
    let sizeBytes: number | null = null;
    if (tokens[1]) {
      const m = tokens[1].match(/^([0-9]+(?:\.[0-9]+)?)([KMGT]?)B?$/i);
      if (m) {
        const num = Number(m[1]);
        const mult = m[2] ? SIZE_UNITS[m[2].toUpperCase()] : 1;
        if (Number.isFinite(num)) sizeBytes = Math.round(num * mult);
      } else {
        const n = Number(tokens[1]);
        if (Number.isFinite(n)) sizeBytes = n;
      }
    }
    out.push({ id, sizeBytes });
  }
  return out;
}
