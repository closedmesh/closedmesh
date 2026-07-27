import { NextResponse } from "next/server";
import { treasuryInfo } from "../../../lib/solana-deposits";
import { RATE_CARD } from "../../../lib/rate-card";
import { microsToUsd } from "../../../lib/rate-card";

/**
 * GET /api/account/treasury — public deposit instructions (no secrets).
 */
export async function GET() {
  const info = await treasuryInfo();
  return NextResponse.json({
    chain: "solana",
    ...info,
    rateCard: {
      daily_driver: {
        prompt_usd_per_mtok: microsToUsd(
          RATE_CARD.daily_driver.customer_prompt_per_mtok_usd_micros,
        ),
        completion_usd_per_mtok: microsToUsd(
          RATE_CARD.daily_driver.customer_completion_per_mtok_usd_micros,
        ),
      },
      capacity: {
        prompt_usd_per_mtok: microsToUsd(
          RATE_CARD.capacity.customer_prompt_per_mtok_usd_micros,
        ),
        completion_usd_per_mtok: microsToUsd(
          RATE_CARD.capacity.customer_completion_per_mtok_usd_micros,
        ),
      },
    },
    apiBase: "https://senda.network/v1",
  });
}
