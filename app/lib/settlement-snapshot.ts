/**
 * 5.D-audit — public settlement aggregates (no peer↔wallet dump).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { sumCustomerBalances } from "./customer-ledger";
import { sumPendingRefundMicros } from "./customer-refunds";
import {
  countPendingPeerPayouts,
  listRecentPeerPayouts,
  sumPaidOutPeerUsd,
  sumPendingPeerPayoutMicros,
  sumPeerUsdLiabilities,
} from "./peer-earnings";
import { microsToUsd } from "./rate-card";
import {
  SOLANA_USDC_MINT,
  solanaPayerAddress,
  solanaRpcUrl,
  solanaTreasuryAddress,
} from "./solana-config";

async function usdcBalanceAtomic(
  owner: string,
): Promise<{ atomic: number | null; error?: string }> {
  try {
    const connection = new Connection(solanaRpcUrl(), "confirmed");
    const ata = await getAssociatedTokenAddress(
      new PublicKey(SOLANA_USDC_MINT),
      new PublicKey(owner),
    );
    const bal = await connection.getTokenAccountBalance(ata);
    return { atomic: Number(bal.value.amount) };
  } catch (err) {
    return {
      atomic: null,
      error: err instanceof Error ? err.message : "balance_read_failed",
    };
  }
}

export type SettlementSnapshot = {
  ok: true;
  asOf: string;
  unit: "USD";
  rail: "solana_usdc";
  liabilities: {
    customer_usd: number;
    peer_usd: number;
    pending_refunds_usd: number;
    pending_peer_payouts_usd: number;
    total_usd: number;
  };
  paid_out: {
    peer_usd: number;
    pending_payout_tickets: number;
  };
  treasury: {
    address: string | null;
    usdc: number | null;
    error?: string;
  };
  payer: {
    address: string | null;
    usdc: number | null;
    error?: string;
  };
  /** Sent payouts only — no peer ids or full wallets. */
  recent_payouts: Array<{
    id: string;
    usd: number;
    status: string;
    createdAt: string;
    txSignature: string | null;
    solscanUrl: string | null;
  }>;
  note: string;
};

export async function buildSettlementSnapshot(): Promise<SettlementSnapshot> {
  const [
    customer,
    peer,
    pendingRefunds,
    pendingPayouts,
    paidOut,
    pendingCount,
    recent,
  ] = await Promise.all([
    sumCustomerBalances(),
    sumPeerUsdLiabilities(),
    sumPendingRefundMicros(),
    sumPendingPeerPayoutMicros(),
    sumPaidOutPeerUsd(),
    countPendingPeerPayouts(),
    listRecentPeerPayouts(15),
  ]);

  const liability = customer + peer + pendingRefunds + pendingPayouts;
  const treasuryAddr = solanaTreasuryAddress();
  const payerAddr = solanaPayerAddress();

  const [treasuryBal, payerBal] = await Promise.all([
    treasuryAddr
      ? usdcBalanceAtomic(treasuryAddr)
      : Promise.resolve({ atomic: null as number | null, error: "unconfigured" }),
    payerAddr
      ? usdcBalanceAtomic(payerAddr)
      : Promise.resolve({
          atomic: null as number | null,
          error: "unconfigured",
        }),
  ]);

  const recent_payouts = recent
    .filter((p) => p.status === "sent" && p.txSignature)
    .slice(0, 10)
    .map((p) => ({
      id: p.id,
      usd: microsToUsd(p.micros),
      status: p.status,
      createdAt: p.createdAt,
      txSignature: p.txSignature ?? null,
      solscanUrl: p.txSignature
        ? `https://solscan.io/tx/${p.txSignature}`
        : null,
    }));

  return {
    ok: true,
    asOf: new Date().toISOString(),
    unit: "USD",
    rail: "solana_usdc",
    liabilities: {
      customer_usd: microsToUsd(customer),
      peer_usd: microsToUsd(peer),
      pending_refunds_usd: microsToUsd(pendingRefunds),
      pending_peer_payouts_usd: microsToUsd(pendingPayouts),
      total_usd: microsToUsd(liability),
    },
    paid_out: {
      peer_usd: microsToUsd(paidOut),
      pending_payout_tickets: pendingCount,
    },
    treasury: {
      address: treasuryAddr,
      usdc:
        treasuryBal.atomic == null ? null : microsToUsd(treasuryBal.atomic),
      error: treasuryBal.error,
    },
    payer: {
      address: payerAddr,
      usdc: payerBal.atomic == null ? null : microsToUsd(payerBal.atomic),
      error: payerBal.error,
    },
    recent_payouts,
    note: "Public aggregates only — peer↔wallet binds are not listed. Verify payouts on Solscan via tx signatures.",
  };
}
