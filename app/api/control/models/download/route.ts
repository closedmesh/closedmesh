import { spawn } from "node:child_process";
import { findClosedmeshBin, isPublic } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Downloads a model onto this node by shelling out to
 * `closedmesh models download <id>` and forwarding stdout/stderr to the
 * client as newline-delimited JSON.
 *
 * Why NDJSON over SSE: same reasoning as /api/control/install — the AI
 * SDK monopolises EventSource semantics for /api/chat, so a plain
 * `text/x-ndjson` body keeps the client wiring simple.
 *
 * Each line is one of:
 *   {"kind":"stdout","text":"…"}
 *   {"kind":"stderr","text":"…"}
 *   {"kind":"progress","percent":12.5,"bytes":15728640,"total":134217728}
 *   {"kind":"done","ok":true,"code":0}
 *   {"kind":"error","message":"…"}
 *
 * The `progress` event is parsed out of the CLI's progress bar lines on
 * a best-effort basis so the dashboard can render a real bar instead of
 * a stream of unintelligible carriage returns.
 */
type Body = { id?: string };

const ALLOWED_ID = /^[A-Za-z0-9._\-]{1,128}$/;

export async function POST(req: Request) {
  if (isPublic) {
    return new Response(
      JSON.stringify({
        ok: false,
        message: "Model downloads aren't available on the hosted public site.",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonErr(400, "Body must be JSON.");
  }
  const id = (body.id ?? "").trim();
  if (!ALLOWED_ID.test(id)) {
    return jsonErr(
      400,
      "Invalid model id. Expected something like Qwen3-8B-Q4_K_M.",
    );
  }

  const bin = await findClosedmeshBin();
  if (!bin) {
    return jsonErr(404, "closedmesh binary not found on this machine.");
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      };

      send({ kind: "stdout", text: `closedmesh models download ${id}` });

      const child = spawn(bin, ["models", "download", id], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const handle = (chunk: string, kind: "stdout" | "stderr") => {
        // The CLI's progress bar uses \r to redraw a single line; split
        // on either CR or LF so we capture each redraw as its own event.
        for (const raw of chunk.split(/\r|\n/)) {
          const line = raw.trim();
          if (!line) continue;
          send({ kind, text: line });
          const progress = parseProgress(line);
          if (progress) send({ kind: "progress", ...progress });
        }
      };

      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (c: string) => handle(c, "stdout"));
      child.stderr.on("data", (c: string) => handle(c, "stderr"));
      child.on("error", (err) => {
        send({ kind: "error", message: err.message });
        controller.close();
      });
      child.on("close", (code) => {
        send({ kind: "done", ok: code === 0, code: code ?? -1 });
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function jsonErr(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/**
 * Tries to extract a (bytes, total) pair from a progress line. Two
 * common shapes from llama.cpp / huggingface_hub style downloaders:
 *
 *   "Downloading model.gguf:  37%  1.86G/5.00G"
 *   "[#####     ] 50%  2.5GB / 5.0GB"
 *   "1234/4096 MB"
 */
function parseProgress(
  line: string,
): { percent: number; bytes: number; total: number } | null {
  const m =
    line.match(
      /([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)B?\s*\/\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)B?/i,
    ) ?? null;
  if (!m) {
    const pct = line.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pct) {
      const percent = Math.min(100, Math.max(0, Number(pct[1])));
      return { percent, bytes: 0, total: 0 };
    }
    return null;
  }
  const a = Number(m[1]);
  const b = Number(m[3]);
  const aUnit = (m[2] || "B").toUpperCase();
  const bUnit = (m[4] || "B").toUpperCase();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  const bytes = Math.round(a * (SIZE_UNITS[aUnit] ?? 1));
  const total = Math.round(b * (SIZE_UNITS[bUnit] ?? 1));
  return {
    percent: Math.min(100, Math.max(0, (bytes / total) * 100)),
    bytes,
    total,
  };
}
