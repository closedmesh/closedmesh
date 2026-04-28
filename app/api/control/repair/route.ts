import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { findClosedmeshBin, isPublic, runClosedmesh } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Detect-and-fix endpoint for legacy autostart units that were written by
 * earlier versions of the installer with `--private-only`. That flag tells
 * the runtime to refuse to publish or discover any public mesh, which is
 * the right default for a hand-rolled install but the *wrong* default for
 * users who just downloaded the desktop app expecting closedmesh.com chat
 * to start working as soon as a model loads.
 *
 *   GET  → { ok: true, issues: Issue[] }       (no side effects)
 *   POST → applies the fix, then re-detects.
 *
 * The issues we know how to repair right now:
 *   - Darwin launchd plist:        ~/Library/LaunchAgents/dev.closedmesh.closedmesh.plist
 *   - Linux  systemd --user unit:  ~/.config/systemd/user/closedmesh.service
 *
 * Windows is detected but not auto-repaired — a Scheduled Task definition
 * isn't a flat file the same way, and writing the schtasks XML correctly
 * across locales is fiddly. We surface the issue and tell the user what
 * to run.
 */

export type RepairIssue = {
  kind: "private-only-launchd" | "private-only-systemd" | "private-only-schtasks";
  /** Human-readable description for the dashboard banner. */
  message: string;
  /** Path to the unit file (or task name on Windows). */
  unit: string;
  /** Whether POST /api/control/repair can fix this without manual help. */
  fixable: boolean;
};

type RepairResponse = {
  ok: boolean;
  issues: RepairIssue[];
  /** Per-issue outcome of the most recent POST, when applicable. */
  applied?: Array<{ kind: RepairIssue["kind"]; ok: boolean; message: string }>;
};

const LAUNCHD_PATH = path.join(
  homedir(),
  "Library",
  "LaunchAgents",
  "dev.closedmesh.closedmesh.plist",
);
const SYSTEMD_PATH = path.join(
  homedir(),
  ".config",
  "systemd",
  "user",
  "closedmesh.service",
);

export async function GET() {
  if (isPublic) return forbiddenOnPublic();
  const issues = await detectIssues();
  return NextResponse.json<RepairResponse>({ ok: true, issues });
}

export async function POST() {
  if (isPublic) return forbiddenOnPublic();

  const issues = await detectIssues();
  const applied: NonNullable<RepairResponse["applied"]> = [];

  for (const issue of issues) {
    if (!issue.fixable) {
      applied.push({
        kind: issue.kind,
        ok: false,
        message:
          "This platform's autostart unit can't be repaired automatically — see message.",
      });
      continue;
    }
    try {
      switch (issue.kind) {
        case "private-only-launchd":
          await rewriteUnitFile(LAUNCHD_PATH);
          await reloadLaunchd();
          applied.push({
            kind: issue.kind,
            ok: true,
            message:
              "Updated the launchd plist and restarted the service. Your node should announce itself to the public mesh in a few seconds.",
          });
          break;
        case "private-only-systemd":
          await rewriteUnitFile(SYSTEMD_PATH);
          await reloadSystemd();
          applied.push({
            kind: issue.kind,
            ok: true,
            message:
              "Updated the systemd unit and restarted the service.",
          });
          break;
        default:
          applied.push({
            kind: issue.kind,
            ok: false,
            message: "Unhandled repair kind.",
          });
      }
    } catch (err) {
      applied.push({
        kind: issue.kind,
        ok: false,
        message: err instanceof Error ? err.message : "repair failed",
      });
    }
  }

  // Re-detect so the caller can update its banner state in one round-trip.
  const remaining = await detectIssues();
  return NextResponse.json<RepairResponse>({
    ok: applied.every((a) => a.ok),
    issues: remaining,
    applied,
  });
}

/**
 * Read each known autostart unit. If it exists and contains the literal
 * `--private-only` flag, surface it as a fixable issue. We deliberately
 * don't try to "guess" — only flag units where we can verifiably see the
 * legacy flag, so we don't generate phantom warnings for hand-customised
 * installs.
 */
async function detectIssues(): Promise<RepairIssue[]> {
  const issues: RepairIssue[] = [];

  if (process.platform === "darwin") {
    const plist = await readIfExists(LAUNCHD_PATH);
    if (plist && plist.includes("--private-only")) {
      issues.push({
        kind: "private-only-launchd",
        message:
          "Your autostart service was installed by an older release with --private-only, which hides this Mac from the public mesh. Repair it to make this node visible.",
        unit: LAUNCHD_PATH,
        fixable: true,
      });
    }
  }

  if (process.platform === "linux") {
    const unit = await readIfExists(SYSTEMD_PATH);
    if (unit && unit.includes("--private-only")) {
      issues.push({
        kind: "private-only-systemd",
        message:
          "Your systemd --user unit was installed with --private-only, which keeps this node off the public mesh. Repair it to make this node visible.",
        unit: SYSTEMD_PATH,
        fixable: true,
      });
    }
  }

  if (process.platform === "win32") {
    // Best-effort detection: query the Scheduled Task XML and look for
    // the literal flag in its <Arguments> element. Auto-fix is left to a
    // follow-up release because schtasks /Create cross-locale needs care.
    const task = await readScheduledTask("ClosedMesh");
    if (task && task.includes("--private-only")) {
      issues.push({
        kind: "private-only-schtasks",
        message:
          "Your Scheduled Task is set to --private-only. Re-run install.ps1 to update it, or edit the task arguments manually.",
        unit: "ClosedMesh",
        fixable: false,
      });
    }
  }

  return issues;
}

async function readIfExists(filepath: string): Promise<string | null> {
  try {
    return await fs.readFile(filepath, "utf-8");
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

async function readScheduledTask(name: string): Promise<string | null> {
  // Use schtasks rather than Get-ScheduledTask so we don't depend on
  // PowerShell being on PATH from a Node child process. `runClosedmesh`
  // is misnamed — it's a generic spawn wrapper — and accepts any bin
  // on PATH, so passing "schtasks" works on Windows runners.
  const result = await runClosedmesh(
    "schtasks",
    ["/Query", "/TN", name, "/XML", "ONE"],
    5_000,
  );
  return result.ok ? result.stdout : null;
}

async function rewriteUnitFile(filepath: string): Promise<void> {
  const content = await fs.readFile(filepath, "utf-8");
  // Replace every literal --private-only with --auto. Preserves indentation
  // and adjacent flags. If --auto is somehow already present alongside the
  // legacy flag, we still drop --private-only — the runtime conflicts the
  // two and would refuse to start otherwise.
  let updated = content.replace(/--private-only/g, "--auto");
  // Belt-and-braces: the launchd plist format wraps each arg in <string>;
  // a verbatim "--private-only" string element becomes "--auto", which is
  // exactly what we want. Same for the systemd ExecStart= line.
  if (updated === content) {
    throw new Error("nothing to rewrite — --private-only not found");
  }
  // Collapse accidental "--auto --auto" if --auto was somehow present
  // alongside --private-only before the rewrite.
  updated = updated.replace(/(--auto)(\s+--auto)+/g, "$1");
  await fs.writeFile(filepath, updated, "utf-8");
}

async function reloadLaunchd(): Promise<void> {
  const bin = await findClosedmeshBin();
  if (!bin) {
    throw new Error(
      "closedmesh binary missing; can't restart the launchd unit.",
    );
  }
  // `closedmesh service stop|start` wraps `launchctl bootout|bootstrap`
  // and gives us a single uniform CLI to call cross-platform.
  await runClosedmesh(bin, ["service", "stop"], 10_000);
  const start = await runClosedmesh(bin, ["service", "start"], 15_000);
  if (!start.ok) {
    throw new Error(
      start.stderr ||
        start.stdout ||
        "service start failed after rewriting plist",
    );
  }
}

async function reloadSystemd(): Promise<void> {
  const bin = await findClosedmeshBin();
  if (!bin) {
    throw new Error(
      "closedmesh binary missing; can't restart the systemd unit.",
    );
  }
  // systemd needs a daemon-reload to pick up the rewritten ExecStart.
  // We ignore the result here — the subsequent `service start` will fail
  // loudly if the reload didn't actually take.
  await runClosedmesh("systemctl", ["--user", "daemon-reload"], 10_000);
  await runClosedmesh(bin, ["service", "stop"], 10_000);
  const start = await runClosedmesh(bin, ["service", "start"], 15_000);
  if (!start.ok) {
    throw new Error(
      start.stderr ||
        start.stdout ||
        "service start failed after rewriting unit",
    );
  }
}

function forbiddenOnPublic() {
  return NextResponse.json<RepairResponse>(
    {
      ok: false,
      issues: [],
    },
    { status: 403 },
  );
}
