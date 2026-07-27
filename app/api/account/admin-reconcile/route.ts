import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { sumCustomerBalances } from "../../../lib/customer-ledger";
import {
  sumPeerUsdLiabilities,
  sumPendingPeerPayoutMicros,
} from "../../../lib/peer-earnings";
import { sumPendingRefundMicros } from "../../../lib/customer-refunds";
import { microsToUsd } from "../../../lib/rate-card";
import {
  SOLANA_USDC_MINT,
  solanaRpcUrl,
  solanaTreasuryAddress,
} from "../../../lib/solana-config";

function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return req.headers.get("authorization")?.trim() === `Bearer ${secret}`;
}

/**
 * GET /api/account/admin-reconcile — Redis liabilities vs treasury USDC ATA.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const customer = await sumCustomerBalances();
  const peer = await sumPeerUsdLiabilities();
  const pendingRefunds = await sumPendingRefundMicros();
  const pendingPayouts = await sumPendingPeerPayoutMicros();
  const liability = customer + peer + pendingRefunds + pendingPayouts;

  let treasuryAtomic: number | null = null;
  let treasuryError: string | undefined;
  const treasury = solanaTreasuryAddress();
  if (treasury) {
    try {
      const connection = new Connection(solanaRpcUrl(), "confirmed");
      const ata = await getAssociatedTokenAddress(
        new PublicKey(SOLANA_USDC_MINT),
        new PublicKey(treasury),
      );
      const bal = await connection.getTokenAccountBalance(ata);
      treasuryAtomic = Number(bal.value.amount);
    } catch (err) {
      treasuryError = err instanceof Error ? err.message : "treasury_read_failed";
    }
  } else {
    treasuryError = "treasury_unconfigured";
  }

  const gap =
    treasuryAtomic == null ? null : treasuryAtomic - liability;
  const alert =
    gap != null && Math.abs(gap) > 1_000_000
      ? gap < 0
        ? "treasury_short"
        : "treasury_surplus"
      : null;

  return NextResponse.json({
    ok: true,
    liabilities: {
      customer_usd_micros: customer,
      peer_usd_micros: peer,
      pending_refunds_usd_micros: pendingRefunds,
      pending_peer_payouts_usd_micros: pendingPayouts,
      total_usd_micros: liability,
      total_usd: microsToUsd(liability),
    },
    treasury: {
      address: treasury,
      usdc_atomic: treasuryAtomic,
      usdc: treasuryAtomic == null ? null : microsToUsd(treasuryAtomic),
      error: treasuryError,
    },
    gap_usd_micros: gap,
    gap_usd: gap == null ? null : microsToUsd(gap),
    alert,
  });
}
