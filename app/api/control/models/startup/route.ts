import { NextResponse } from "next/server";
import {
  CONFIG_PATH,
  readConfigFile,
  readStartupModels,
  writeConfigFile,
  writeStartupModels,
  type StartupModel,
} from "../../_config-toml";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Manage which model(s) the local runtime loads on boot.
 *
 *   GET  → { ok, models: StartupModel[], configPath }
 *   POST { model: "Qwen3-8B-Q4_K_M", ctxSize?: 8192 }
 *        → replaces the [[models]] section with this single entry,
 *          then bounces the autostart unit so the runtime picks it up.
 *   DELETE → clears [[models]] entirely (node will start, but immediately
 *            warn it has no startup model).
 *
 * Why "replace" rather than "append": the desktop UI exposes a single
 * "Make this my startup model" button per row, which is what 95% of users
 * want for a single-Mac contributor flow. Power users with multi-model
 * setups can edit ~/.closedmesh/config.toml by hand — this endpoint is a
 * convenience layer for the common case, not the only path.
 */

type StartupModelInput = {
  model?: string;
  ctxSize?: number;
};

type StartupResponse =
  | {
      ok: true;
      models: StartupModel[];
      configPath: string;
      restart?: { ok: boolean; message: string };
    }
  | { ok: false; message: string; models?: StartupModel[]; configPath?: string };

export async function GET() {
  if (isPublic) return forbiddenOnPublic();

  try {
    const content = await readConfigFile();
    const models = readStartupModels(content);
    return NextResponse.json<StartupResponse>({
      ok: true,
      models,
      configPath: CONFIG_PATH,
    });
  } catch (err) {
    return NextResponse.json<StartupResponse>(
      {
        ok: false,
        message: err instanceof Error ? err.message : "read failed",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  if (isPublic) return forbiddenOnPublic();

  let body: StartupModelInput;
  try {
    body = (await req.json()) as StartupModelInput;
  } catch {
    return NextResponse.json<StartupResponse>(
      { ok: false, message: "expected JSON body { model, ctxSize? }" },
      { status: 400 },
    );
  }

  const model = (body.model ?? "").trim();
  if (!model) {
    return NextResponse.json<StartupResponse>(
      { ok: false, message: "missing 'model' (catalog id or canonical ref)" },
      { status: 400 },
    );
  }
  if (model.length > 256 || /[\r\n"\\]/.test(model)) {
    return NextResponse.json<StartupResponse>(
      { ok: false, message: "model id contains illegal characters" },
      { status: 400 },
    );
  }

  const ctxSize =
    typeof body.ctxSize === "number" && Number.isFinite(body.ctxSize)
      ? Math.max(1, Math.floor(body.ctxSize))
      : undefined;

  const next: StartupModel = { model, ctxSize };

  let updated: string;
  try {
    const existing = await readConfigFile();
    updated = writeStartupModels(existing, [next]);
    await writeConfigFile(updated);
  } catch (err) {
    return NextResponse.json<StartupResponse>(
      {
        ok: false,
        message:
          err instanceof Error
            ? `write failed: ${err.message}`
            : "write failed",
        configPath: CONFIG_PATH,
      },
      { status: 500 },
    );
  }

  const restart = await bounceService();

  return NextResponse.json<StartupResponse>({
    ok: true,
    models: readStartupModels(updated),
    configPath: CONFIG_PATH,
    restart,
  });
}

export async function DELETE() {
  if (isPublic) return forbiddenOnPublic();

  try {
    const existing = await readConfigFile();
    const cleared = writeStartupModels(existing, []);
    await writeConfigFile(cleared);
    const restart = await bounceService();
    return NextResponse.json<StartupResponse>({
      ok: true,
      models: [],
      configPath: CONFIG_PATH,
      restart,
    });
  } catch (err) {
    return NextResponse.json<StartupResponse>(
      {
        ok: false,
        message: err instanceof Error ? err.message : "clear failed",
      },
      { status: 500 },
    );
  }
}

/**
 * Stop and re-start the autostart unit so the runtime re-reads
 * config.toml. Best-effort — if the service isn't installed (e.g. user
 * runs the binary by hand) we still return a useful message.
 *
 * The restart takes a few seconds because the runtime reloads weights
 * into memory. We return immediately after the service-start command
 * exits; the caller can poll /api/control/status to watch the model
 * actually come up.
 */
async function bounceService(): Promise<{ ok: boolean; message: string }> {
  const bin = await findClosedmeshBin();
  if (!bin) {
    return {
      ok: false,
      message:
        "Saved config, but the closedmesh binary isn't on this machine yet — install it first.",
    };
  }

  // `service stop` exits non-zero if the unit was already stopped, which
  // is fine. We treat both stop outcomes as "ok to start now".
  await runClosedmesh(bin, ["service", "stop"], 10_000);
  const start = await runClosedmesh(bin, ["service", "start"], 15_000);
  if (start.ok) {
    return {
      ok: true,
      message:
        "Saved. Restarting the runtime — your model will be available in a few seconds.",
    };
  }
  return {
    ok: false,
    message:
      start.stderr ||
      start.stdout ||
      "Saved config, but the autostart service didn't restart cleanly. Try `closedmesh service start` from a terminal.",
  };
}

function forbiddenOnPublic() {
  return NextResponse.json<StartupResponse>(
    {
      ok: false,
      message: "Startup-model management isn't exposed on the hosted public site.",
    },
    { status: 403 },
  );
}
