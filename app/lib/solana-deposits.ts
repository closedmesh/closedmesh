/**
 * Credit customer balances from Solana USDC transfers into the treasury.
 *
 * Idempotent on transaction signature. Account id = sender wallet (base58).
 */

import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { creditCustomer } from "./customer-ledger";
import {
  MIN_TOPUP_USDC_ATOMIC,
  SOLANA_USDC_MINT,
  solanaRpcUrl,
  solanaTreasuryAddress,
} from "./solana-config";

export type DetectedDeposit = {
  signature: string;
  fromWallet: string;
  amountAtomic: number;
};

/**
 * Treasury USDC owner balance increased; attribute to the wallet that
 * decreased USDC the most in the same tx.
 */
export function extractDepositsByOwnerDelta(
  tx: ParsedTransactionWithMeta | null,
  treasuryWallet: string,
  usdcMint: string = SOLANA_USDC_MINT,
): DetectedDeposit[] {
  if (!tx?.meta || tx.meta.err) return [];
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const sig = tx.transaction.signatures[0] ?? "";
  if (!sig) return [];

  let treasuryDelta = 0;
  for (const postBal of post) {
    if (postBal.mint !== usdcMint) continue;
    if (postBal.owner !== treasuryWallet) continue;
    const preBal = pre.find(
      (b) =>
        b.accountIndex === postBal.accountIndex && b.mint === usdcMint,
    );
    const preAmt = Number(preBal?.uiTokenAmount.amount ?? "0");
    const postAmt = Number(postBal.uiTokenAmount.amount ?? "0");
    treasuryDelta += postAmt - preAmt;
  }
  if (treasuryDelta <= 0) return [];

  let fromWallet = "";
  let maxDecrease = 0;
  for (const p of pre) {
    if (p.mint !== usdcMint) continue;
    if (p.owner === treasuryWallet) continue;
    const postMatch = post.find(
      (b) => b.accountIndex === p.accountIndex && b.mint === usdcMint,
    );
    const preA = Number(p.uiTokenAmount.amount ?? "0");
    const postA = Number(postMatch?.uiTokenAmount.amount ?? "0");
    const dec = preA - postA;
    if (dec > maxDecrease && p.owner) {
      maxDecrease = dec;
      fromWallet = p.owner;
    }
  }
  if (!fromWallet) return [];

  return [
    {
      signature: sig,
      fromWallet,
      amountAtomic: treasuryDelta,
    },
  ];
}

export type SyncResult = {
  scanned: number;
  credited: number;
  skipped: number;
  deposits: Array<{
    signature: string;
    accountId: string;
    micros: number;
  }>;
  errors: string[];
};

/**
 * Scan recent treasury USDC txs and credit matching wallets.
 * When `onlyWallet` is set, only credit that account (user-triggered sync).
 */
export async function syncSolanaDeposits(options?: {
  onlyWallet?: string;
  limit?: number;
}): Promise<SyncResult> {
  const treasury = solanaTreasuryAddress();
  const result: SyncResult = {
    scanned: 0,
    credited: 0,
    skipped: 0,
    deposits: [],
    errors: [],
  };
  if (!treasury) {
    result.errors.push("treasury_unconfigured");
    return result;
  }

  let treasuryPk: PublicKey;
  let mintPk: PublicKey;
  try {
    treasuryPk = new PublicKey(treasury);
    mintPk = new PublicKey(SOLANA_USDC_MINT);
  } catch {
    result.errors.push("invalid_treasury");
    return result;
  }

  const connection = new Connection(solanaRpcUrl(), "confirmed");
  const ata = await getAssociatedTokenAddress(mintPk, treasuryPk);
  const limit = Math.min(50, Math.max(5, options?.limit ?? 20));
  const sigs = await connection.getSignaturesForAddress(ata, { limit });
  result.scanned = sigs.length;

  const only = options?.onlyWallet?.trim() || null;
  const seen = new Set<string>();

  for (const s of sigs) {
    try {
      const tx = await connection.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const found = extractDepositsByOwnerDelta(tx, treasury);
      for (const dep of found) {
        if (seen.has(dep.signature)) continue;
        seen.add(dep.signature);
        if (only && dep.fromWallet !== only) {
          result.skipped += 1;
          continue;
        }
        if (dep.amountAtomic < MIN_TOPUP_USDC_ATOMIC) {
          result.skipped += 1;
          continue;
        }
        // 1 atomic USDC = 1 micro-USD
        const credit = await creditCustomer({
          accountId: dep.fromWallet,
          micros: dep.amountAtomic,
          reason: "usdc_deposit",
          depositId: dep.signature,
        });
        if (!credit.ok) {
          result.errors.push(`${dep.signature}:${credit.error}`);
          continue;
        }
        result.credited += 1;
        result.deposits.push({
          signature: dep.signature,
          accountId: dep.fromWallet,
          micros: dep.amountAtomic,
        });
      }
    } catch (err) {
      result.errors.push(
        `${s.signature}:${err instanceof Error ? err.message : "tx_error"}`,
      );
    }
  }
  return result;
}

export async function treasuryInfo(): Promise<{
  treasury: string | null;
  usdcMint: string;
  minTopupUsd: number;
  configured: boolean;
} | null> {
  const treasury = solanaTreasuryAddress();
  return {
    treasury,
    usdcMint: SOLANA_USDC_MINT,
    minTopupUsd: MIN_TOPUP_USDC_ATOMIC / 1_000_000,
    configured: treasury != null,
  };
}
