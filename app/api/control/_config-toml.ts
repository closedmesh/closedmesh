import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Tiny line-based reader/writer for `~/.closedmesh/config.toml`.
 *
 * The runtime accepts a fairly rich TOML schema (see closedmesh-llm's
 * plugin/config.rs) but the desktop only needs to manage `[[models]]`
 * blocks — the rest stays whatever the user / installer wrote.
 *
 * We deliberately don't pull in a TOML library: the file is short,
 * structurally simple, and the alternative is shipping a parser to a
 * Next.js function for the sake of replacing two lines. The line-based
 * walker preserves comments, custom whitespace and unrelated sections
 * (`[gpu]`, `[[plugin]]`, …) byte-for-byte.
 */

export const CONFIG_PATH = path.join(homedir(), ".closedmesh", "config.toml");

/** Top-level array-of-tables headers we treat as "[[models]] starts". */
const MODELS_HEADER = /^\s*\[\[\s*models\s*\]\]\s*$/i;
/** Any other section header — terminates whatever section we're inside. */
const ANY_HEADER = /^\s*\[\[?[^\]]+\]\]?\s*$/;

export type StartupModel = {
  /** Catalog id or canonical HF ref, e.g. "Qwen3-8B-Q4_K_M". */
  model: string;
  /** Optional context size override. */
  ctxSize?: number;
};

/**
 * Parse the file's `[[models]]` blocks. Unknown keys are ignored — we only
 * surface the ones the desktop UI cares about so they round-trip cleanly.
 */
export function readStartupModels(content: string): StartupModel[] {
  const out: StartupModel[] = [];
  let current: Partial<StartupModel> | null = null;

  const flush = () => {
    if (current && current.model) {
      out.push({ model: current.model, ctxSize: current.ctxSize });
    }
    current = null;
  };

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (MODELS_HEADER.test(line)) {
      flush();
      current = {};
      continue;
    }
    if (ANY_HEADER.test(line)) {
      flush();
      continue;
    }
    if (!current) continue;

    // Strip TOML inline comments (best-effort — doesn't try to handle `#`
    // inside quoted strings, which our managed entries don't use).
    const noComment = line.replace(/\s+#.*$/, "");
    const m = noComment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1];
    const valueRaw = m[2];

    if (key === "model") {
      current.model = unquote(valueRaw);
    } else if (key === "ctx_size") {
      const n = Number(valueRaw);
      if (Number.isFinite(n)) current.ctxSize = n;
    }
  }
  flush();
  return out;
}

/**
 * Replace every existing `[[models]]` block with the supplied list, while
 * preserving everything else in the file (other sections, comments, blank
 * lines). If the input had no `[[models]]` blocks, the new ones are
 * appended at the end of the file.
 */
export function writeStartupModels(
  content: string,
  models: StartupModel[],
): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];

  let inModelsBlock = false;
  for (const raw of lines) {
    const line = raw;
    if (MODELS_HEADER.test(line)) {
      inModelsBlock = true;
      continue;
    }
    if (ANY_HEADER.test(line) && inModelsBlock) {
      inModelsBlock = false;
      // fall through — this header (a different section) is preserved
    }
    if (inModelsBlock) continue;
    kept.push(line);
  }

  // Trim trailing blank lines from the kept body so we don't accumulate
  // unbounded whitespace across edits.
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();

  if (models.length === 0) {
    return kept.join("\n") + (kept.length > 0 ? "\n" : "");
  }

  const blocks: string[] = [];
  for (const m of models) {
    blocks.push("[[models]]");
    blocks.push(`model = "${escapeString(m.model)}"`);
    if (typeof m.ctxSize === "number" && Number.isFinite(m.ctxSize)) {
      blocks.push(`ctx_size = ${Math.floor(m.ctxSize)}`);
    }
    blocks.push("");
  }

  // Ensure exactly one blank line between body and the new section, with
  // a trailing newline so editors don't yell.
  const body = kept.join("\n");
  const joiner = body.length > 0 ? "\n\n" : "";
  return body + joiner + blocks.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Read `~/.closedmesh/config.toml` from disk, returning `""` if it
 * doesn't exist yet — that's a valid first-run state we want to handle
 * by writing a fresh file rather than failing.
 */
export async function readConfigFile(): Promise<string> {
  try {
    return await fs.readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw err;
  }
}

/** Write the file, ensuring the parent directory exists. */
export async function writeConfigFile(content: string): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, content, "utf-8");
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return t;
}

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
