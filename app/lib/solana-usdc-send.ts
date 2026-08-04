/**
 * Send USDC from the configured payer keypair (treasury or dedicated).
 * Used for peer payouts and customer refunds when SENDA_SOLANA_PAYER_SECRET
 * (or SENDA_SOLANA_TREASURY_SECRET) is set.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  SOLANA_USDC_MINT,
  USDC_DECIMALS,
  solanaPayerSecretBase58,
  solanaRpcUrl,
  solanaTreasuryAddress,
} from "./solana-config";

function loadPayer(): Keypair | null {
  const secret = solanaPayerSecretBase58();
  if (!secret) return null;
  try {
    const bytes = bs58.decode(secret);
    return Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
}

/** Public key of the configured payer (null if unset / invalid). */
export function solanaPayerPublicKey(): string | null {
  const payer = loadPayer();
  return payer ? payer.publicKey.toBase58() : null;
}

export async function sendUsdc(input: {
  destinationWallet: string;
  amountAtomic: number;
}): Promise<
  | { ok: true; signature: string }
  | { ok: false; error: string }
> {
  const amount = Math.floor(input.amountAtomic);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "invalid_amount" };
  }

  const payer = loadPayer();
  if (!payer) return { ok: false, error: "payer_not_configured" };

  let dest: PublicKey;
  let mint: PublicKey;
  try {
    dest = new PublicKey(input.destinationWallet.trim());
    mint = new PublicKey(SOLANA_USDC_MINT);
  } catch {
    return { ok: false, error: "invalid_destination" };
  }

  // Prefer treasury ATA as source when treasury pubkey matches payer.
  const treasury = solanaTreasuryAddress();
  const sourceOwner =
    treasury && treasury === payer.publicKey.toBase58()
      ? payer.publicKey
      : payer.publicKey;

  try {
    const connection = new Connection(solanaRpcUrl(), "confirmed");
    const sourceAta = getAssociatedTokenAddressSync(mint, sourceOwner);
    const destAta = getAssociatedTokenAddressSync(mint, dest);

    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        destAta,
        dest,
        mint,
      ),
      createTransferCheckedInstruction(
        sourceAta,
        mint,
        destAta,
        sourceOwner,
        amount,
        USDC_DECIMALS,
      ),
    );

    const signature = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
    });
    return { ok: true, signature };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "send_failed",
    };
  }
}
