/**
 * Solana USDC rail config (Phase 5.C Decision 1 — Solana-first).
 */

/** Mainnet USDC mint (Circle). */
export const SOLANA_USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** USDC and our ledger both use 6 fractional digits → 1 atomic USDC = 1 micro-USD. */
export const USDC_DECIMALS = 6;

/** Minimum top-up: $5 USDC. */
export const MIN_TOPUP_USDC_ATOMIC = 5 * 10 ** USDC_DECIMALS;

export function solanaRpcUrl(): string {
  return (
    process.env.SENDA_SOLANA_RPC_URL?.trim() ||
    process.env.SOLANA_RPC_URL?.trim() ||
    "https://api.mainnet-beta.solana.com"
  );
}

export function solanaTreasuryAddress(): string | null {
  const raw = process.env.SENDA_SOLANA_TREASURY?.trim();
  return raw || null;
}

export function solanaDepositsConfigured(): boolean {
  return solanaTreasuryAddress() != null;
}
