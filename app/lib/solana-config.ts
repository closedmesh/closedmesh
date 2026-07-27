/**
 * Solana USDC rail config (Phase 5.C Decision 1 — Solana-first).
 *
 * RPC resolution order:
 *   1. SENDA_SOLANA_RPC_URL / SOLANA_RPC_URL (full URL, may already include key)
 *   2. HELIUS_API_KEY / SENDA_HELIUS_API_KEY → Helius mainnet HTTPS
 *   3. Public Solana RPC (rate-limited — fine for local only)
 */

/** Mainnet USDC mint (Circle). */
export const SOLANA_USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** USDC and our ledger both use 6 fractional digits → 1 atomic USDC = 1 micro-USD. */
export const USDC_DECIMALS = 6;

/** Minimum top-up: $5 USDC. */
export const MIN_TOPUP_USDC_ATOMIC = 5 * 10 ** USDC_DECIMALS;

/** Minimum peer / customer USDC withdrawal: $10. */
export const MIN_WITHDRAW_USDC_ATOMIC = 10 * 10 ** USDC_DECIMALS;

function heliusApiKey(): string | undefined {
  return (
    process.env.HELIUS_API_KEY?.trim() ||
    process.env.SENDA_HELIUS_API_KEY?.trim() ||
    undefined
  );
}

export function solanaRpcUrl(): string {
  const explicit =
    process.env.SENDA_SOLANA_RPC_URL?.trim() ||
    process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;

  const helius = heliusApiKey();
  if (helius) {
    return `https://mainnet.helius-rpc.com/?api-key=${helius}`;
  }

  return "https://api.mainnet-beta.solana.com";
}

export function solanaRpcProvider(): "helius" | "custom" | "public" {
  if (
    process.env.SENDA_SOLANA_RPC_URL?.trim() ||
    process.env.SOLANA_RPC_URL?.trim()
  ) {
    const u =
      process.env.SENDA_SOLANA_RPC_URL?.trim() ||
      process.env.SOLANA_RPC_URL?.trim() ||
      "";
    return u.includes("helius") ? "helius" : "custom";
  }
  if (heliusApiKey()) return "helius";
  return "public";
}

export function solanaTreasuryAddress(): string | null {
  const raw = process.env.SENDA_SOLANA_TREASURY?.trim();
  return raw || null;
}

/**
 * Base58 secret key (64-byte keypair) for sending USDC payouts/refunds.
 * Optional — when unset, withdrawals queue as `pending_ops` for local script.
 * Prefer a dedicated payer; never commit this value.
 */
export function solanaPayerSecretBase58(): string | null {
  const raw =
    process.env.SENDA_SOLANA_PAYER_SECRET?.trim() ||
    process.env.SENDA_SOLANA_TREASURY_SECRET?.trim();
  return raw || null;
}

export function solanaDepositsConfigured(): boolean {
  return solanaTreasuryAddress() != null;
}

export function solanaPayoutsConfigured(): boolean {
  return solanaTreasuryAddress() != null && solanaPayerSecretBase58() != null;
}
