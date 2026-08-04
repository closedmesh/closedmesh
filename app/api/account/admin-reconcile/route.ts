import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { sumCustomerBalances } from "../../../lib/customer-ledger";
import {
  countPendingPeerPayouts,
  sumPaidOutPeerUsd,
  sumPeerUsdLiabilities,
  sumPendingPeerPayoutMicros,
} from "../../../lib/peer-earnings";
import { sumPendingRefundMicros } from "../../../lib/customer-refunds";
import { microsToUsd } from "../../../lib/rate-card";
import {
  SOLANA_USDC_MINT,
  solanaPayerAddress,
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
  const paidOut = await sumPaidOutPeerUsd();
  const pendingTicketCount = await countPendingPeerPayouts();
  const liability = customer + peer + pendingRefunds + pendingPayouts;

  async function readUsdc(owner: string | null): Promise<{
    address: string | null;
    usdc_atomic: number | null;
    usdc: number | null;
    error?: string;
  }> {
    if (!owner) {
      return { address: null, usdc_atomic: null, usdc: null, error: "unconfigured" };
    }
    try {
      const connection = new Connection(solanaRpcUrl(), "confirmed");
      const ata = await getAssociatedTokenAddress(
        new PublicKey(SOLANA_USDC_MINT),
        new PublicKey(owner),
      );
      const bal = await connection.getTokenAccountBalance(ata);
      const atomic = Number(bal.value.amount);
      return {
        address: owner,
        usdc_atomic: atomic,
        usdc: microsToUsd(atomic),
      };
    } catch (err) {
      return {
        address: owner,
        usdc_atomic: null,
        usdc: null,
        error: err instanceof Error ? err.message : "read_failed",
      };
    }
  }

  const treasury = await readUsdc(solanaTreasuryAddress());
  const payer = await readUsdc(solanaPayerAddress());
  const onChain =
    (treasury.usdc_atomic ?? 0) + (payer.usdc_atomic ?? 0);
  const gap =
    treasury.usdc_atomic == null && payer.usdc_atomic == null
      ? null
      : onChain - liability;
  const alert =
    gap != null && Math.abs(gap) > 1_000_000
      ? gap < 0
        ? "onchain_short"
        : "onchain_surplus"
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
    paid_out: {
      peer_usd_micros: paidOut,
      peer_usd: microsToUsd(paidOut),
      pending_payout_tickets: pendingTicketCount,
    },
    treasury,
    payer,
    onchain_usdc_micros:
      treasury.usdc_atomic == null && payer.usdc_atomic == null
        ? null
        : onChain,
    gap_usd_micros: gap,
    gap_usd: gap == null ? null : microsToUsd(gap),
    alert,
  });
}
