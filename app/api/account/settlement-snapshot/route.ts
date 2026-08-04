import { NextResponse } from "next/server";
import { buildSettlementSnapshot } from "../../../lib/settlement-snapshot";

/**
 * GET /api/account/settlement-snapshot — public 5.D-audit aggregates.
 * No auth. No peer↔wallet dump.
 */
export async function GET() {
  try {
    const snap = await buildSettlementSnapshot();
    return NextResponse.json(snap, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "snapshot_failed",
        detail: err instanceof Error ? err.message : "unknown",
      },
      { status: 500 },
    );
  }
}
