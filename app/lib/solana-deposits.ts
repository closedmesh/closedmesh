/**
 * Credit customer balances from Solana USDC transfers into the treasury.
 *
 * Idempotent on transaction signature. Account id = sender wallet (base58).
 *
 * Attribution preference:
 *  1. Parsed SPL Token transfer / transferChecked into a treasury-owned USDC ATA
 *  2. Token-balance delta match (treasury gain == sender loss)
 *  3. Largest USDC decrease among non-treasury owners (legacy fallback)
 */

import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { creditCustomer } from "./customer-ledger";
import {
  MIN_TOPUP_USDC_ATOMIC,
  MIN_WITHDRAW_USDC_ATOMIC,
  SOLANA_USDC_MINT,
  solanaPayoutsConfigured,
  solanaRpcProvider,
  solanaRpcUrl,
  solanaTreasuryAddress,
} from "./solana-config";

export type DetectedDeposit = {
  signature: string;
  fromWallet: string;
  amountAtomic: number;
  /** How we attributed the sender. */
  attribution: "spl_transfer" | "balance_match" | "largest_decrease";
};

type TokenBal = {
  accountIndex: number;
  mint: string;
  owner?: string;
  amount: number;
};

function tokenBals(
  rows:
    | NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"]
    | null
    | undefined,
): TokenBal[] {
  if (!rows) return [];
  return rows.map((b) => ({
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner,
    amount: Number(b.uiTokenAmount.amount ?? "0"),
  }));
}

function accountKeyBase58(
  tx: ParsedTransactionWithMeta,
  index: number,
): string | null {
  const key = tx.transaction.message.accountKeys[index];
  if (!key) return null;
  if (typeof key === "object" && key !== null && "pubkey" in key) {
    const pk = (key as { pubkey: PublicKey }).pubkey;
    return typeof pk?.toBase58 === "function" ? pk.toBase58() : String(pk);
  }
  return String(key);
}

function walkParsedInstructions(
  tx: ParsedTransactionWithMeta,
): Array<ParsedInstruction | PartiallyDecodedInstruction> {
  const out: Array<ParsedInstruction | PartiallyDecodedInstruction> = [];
  const outer = tx.transaction.message.instructions ?? [];
  for (const ix of outer) out.push(ix);
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) out.push(ix);
  }
  return out;
}

/**
 * Prefer explicit SPL transfers into treasury-owned USDC accounts.
 */
export function extractDepositsFromSplTransfers(
  tx: ParsedTransactionWithMeta | null,
  treasuryWallet: string,
  usdcMint: string = SOLANA_USDC_MINT,
): DetectedDeposit[] {
  if (!tx?.meta || tx.meta.err) return [];
  const sig = tx.transaction.signatures[0] ?? "";
  if (!sig) return [];

  const post = tokenBals(tx.meta.postTokenBalances);
  const treasuryAtas = new Set(
    post
      .filter((b) => b.mint === usdcMint && b.owner === treasuryWallet)
      .map((b) => accountKeyBase58(tx, b.accountIndex))
      .filter((x): x is string => !!x),
  );
  if (treasuryAtas.size === 0) return [];

  const out: DetectedDeposit[] = [];
  for (const ix of walkParsedInstructions(tx)) {
    if (!("parsed" in ix) || !ix.parsed || typeof ix.parsed !== "object") {
      continue;
    }
    const parsed = ix.parsed as {
      type?: string;
      info?: Record<string, unknown>;
    };
    const type = parsed.type;
    if (type !== "transfer" && type !== "transferChecked") continue;
    const info = parsed.info ?? {};
    const destination = String(info.destination ?? "");
    if (!treasuryAtas.has(destination)) continue;

    if (type === "transferChecked") {
      const mint = String(info.mint ?? "");
      if (mint && mint !== usdcMint) continue;
    }

    let amountAtomic = 0;
    if (type === "transferChecked" && info.tokenAmount) {
      const ta = info.tokenAmount as { amount?: string };
      amountAtomic = Number(ta.amount ?? "0");
    } else {
      amountAtomic = Number(info.amount ?? "0");
    }
    if (!Number.isFinite(amountAtomic) || amountAtomic <= 0) continue;

    const authority = String(info.authority ?? info.source ?? "");
    // Prefer authority (owner signing); fall back to source ATA owner via pre balances.
    let fromWallet = authority;
    if (!fromWallet || fromWallet === destination) {
      const pre = tokenBals(tx.meta.preTokenBalances);
      const source = String(info.source ?? "");
      const srcIdx = tx.transaction.message.accountKeys.findIndex((_, i) => {
        return accountKeyBase58(tx, i) === source;
      });
      const owner = pre.find((b) => b.accountIndex === srcIdx)?.owner;
      fromWallet = owner ?? "";
    }
    // Authority for transferChecked is the owner wallet — good.
    // If authority looks like an ATA (unlikely), try fee payer.
    if (!fromWallet) {
      fromWallet = accountKeyBase58(tx, 0) ?? "";
    }
    if (!fromWallet || fromWallet === treasuryWallet) continue;

    out.push({
      signature: sig,
      fromWallet,
      amountAtomic,
      attribution: "spl_transfer",
    });
  }

  // Merge duplicate attributions in one tx (sum amounts, keep first).
  if (out.length <= 1) return out;
  const bySender = new Map<string, DetectedDeposit>();
  for (const d of out) {
    const prev = bySender.get(d.fromWallet);
    if (!prev) bySender.set(d.fromWallet, { ...d });
    else {
      prev.amountAtomic += d.amountAtomic;
    }
  }
  return [...bySender.values()];
}

/**
 * Treasury USDC owner balance increased; attribute by matching decrease or
 * largest decrease among non-treasury owners.
 */
export function extractDepositsByOwnerDelta(
  tx: ParsedTransactionWithMeta | null,
  treasuryWallet: string,
  usdcMint: string = SOLANA_USDC_MINT,
): DetectedDeposit[] {
  if (!tx?.meta || tx.meta.err) return [];
  const pre = tokenBals(tx.meta.preTokenBalances);
  const post = tokenBals(tx.meta.postTokenBalances);
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
    treasuryDelta += postBal.amount - (preBal?.amount ?? 0);
  }
  if (treasuryDelta <= 0) return [];

  // Prefer a sender whose USDC decrease exactly matches treasury gain.
  const decreases: Array<{ owner: string; dec: number }> = [];
  for (const p of pre) {
    if (p.mint !== usdcMint) continue;
    if (p.owner === treasuryWallet || !p.owner) continue;
    const postMatch = post.find(
      (b) => b.accountIndex === p.accountIndex && b.mint === usdcMint,
    );
    const dec = p.amount - (postMatch?.amount ?? 0);
    if (dec > 0) decreases.push({ owner: p.owner, dec });
  }

  const exact = decreases.find((d) => d.dec === treasuryDelta);
  if (exact) {
    return [
      {
        signature: sig,
        fromWallet: exact.owner,
        amountAtomic: treasuryDelta,
        attribution: "balance_match",
      },
    ];
  }

  let fromWallet = "";
  let maxDecrease = 0;
  for (const d of decreases) {
    if (d.dec > maxDecrease) {
      maxDecrease = d.dec;
      fromWallet = d.owner;
    }
  }
  if (!fromWallet) return [];

  return [
    {
      signature: sig,
      fromWallet,
      amountAtomic: treasuryDelta,
      attribution: "largest_decrease",
    },
  ];
}

/** Combined extractor: SPL first, then balance heuristics. */
export function extractDeposits(
  tx: ParsedTransactionWithMeta | null,
  treasuryWallet: string,
  usdcMint: string = SOLANA_USDC_MINT,
): DetectedDeposit[] {
  const fromSpl = extractDepositsFromSplTransfers(tx, treasuryWallet, usdcMint);
  if (fromSpl.length > 0) return fromSpl;
  return extractDepositsByOwnerDelta(tx, treasuryWallet, usdcMint);
}

function looksLikeBase58Wallet(addr: string): boolean {
  // Reject empty / too-short; Solana pubkeys are 32–44 base58 chars.
  if (!addr || addr.length < 32 || addr.length > 48) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr);
}

export type SyncResult = {
  scanned: number;
  credited: number;
  skipped: number;
  quarantined: number;
  deposits: Array<{
    signature: string;
    accountId: string;
    micros: number;
    attribution: DetectedDeposit["attribution"];
  }>;
  quarantine: Array<{
    signature: string;
    fromWallet: string;
    amountAtomic: number;
    reason: string;
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
    quarantined: 0,
    deposits: [],
    quarantine: [],
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
      const found = extractDeposits(tx, treasury);
      for (const dep of found) {
        const dedupeKey = `${dep.signature}:${dep.fromWallet}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        if (only && dep.fromWallet !== only) {
          result.skipped += 1;
          continue;
        }
        if (dep.amountAtomic < MIN_TOPUP_USDC_ATOMIC) {
          result.skipped += 1;
          continue;
        }
        // Auto-credit only high-confidence attribution; quarantine the rest.
        if (dep.attribution === "largest_decrease") {
          result.quarantined += 1;
          result.quarantine.push({
            signature: dep.signature,
            fromWallet: dep.fromWallet,
            amountAtomic: dep.amountAtomic,
            reason: "largest_decrease",
          });
          continue;
        }
        if (!looksLikeBase58Wallet(dep.fromWallet)) {
          result.quarantined += 1;
          result.quarantine.push({
            signature: dep.signature,
            fromWallet: dep.fromWallet,
            amountAtomic: dep.amountAtomic,
            reason: "invalid_wallet",
          });
          continue;
        }
        // Prefer owner wallets; reject if authority fell back to source ATA
        // that isn't a valid standalone account id pattern (same check).
        try {
          const pk = new PublicKey(dep.fromWallet);
          if (!pk.toBase58()) throw new Error("bad");
        } catch {
          result.quarantined += 1;
          result.quarantine.push({
            signature: dep.signature,
            fromWallet: dep.fromWallet,
            amountAtomic: dep.amountAtomic,
            reason: "not_pubkey",
          });
          continue;
        }
        const credit = await creditCustomer({
          accountId: dep.fromWallet,
          micros: dep.amountAtomic,
          reason: "usdc_deposit",
          depositId: `${dep.signature}:${dep.fromWallet}`,
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
          attribution: dep.attribution,
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
  minWithdrawUsd: number;
  configured: boolean;
  rpcProvider: "helius" | "custom" | "public";
  payoutsConfigured: boolean;
}> {
  const treasury = solanaTreasuryAddress();
  return {
    treasury,
    usdcMint: SOLANA_USDC_MINT,
    minTopupUsd: MIN_TOPUP_USDC_ATOMIC / 1_000_000,
    minWithdrawUsd: MIN_WITHDRAW_USDC_ATOMIC / 1_000_000,
    configured: treasury != null,
    rpcProvider: solanaRpcProvider(),
    payoutsConfigured: solanaPayoutsConfigured(),
  };
}
