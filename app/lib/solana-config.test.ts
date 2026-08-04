import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  peerPayoutDryRun,
  peerPayoutMaxGlobalDailyMicros,
  peerPayoutMaxPeerDailyMicros,
  peerPayoutMaxTicketMicros,
  peerPayoutsAutoEnabled,
  refundsAutoEnabled,
  solanaRpcProvider,
  solanaRpcUrl,
  USDC_DECIMALS,
} from "./solana-config";

const KEYS = [
  "SENDA_SOLANA_RPC_URL",
  "SOLANA_RPC_URL",
  "HELIUS_API_KEY",
  "SENDA_HELIUS_API_KEY",
  "SENDA_PEER_PAYOUTS_AUTO",
  "SENDA_REFUNDS_AUTO",
  "SENDA_PAYOUT_DRY_RUN",
  "SENDA_PAYOUT_MAX_TICKET_USD",
  "SENDA_PAYOUT_MAX_PEER_DAILY_USD",
  "SENDA_PAYOUT_MAX_GLOBAL_DAILY_USD",
] as const;

let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("solanaRpcUrl", () => {
  it("prefers explicit RPC URL", () => {
    process.env.SENDA_SOLANA_RPC_URL = "https://example.rpc/custom";
    delete process.env.HELIUS_API_KEY;
    delete process.env.SENDA_HELIUS_API_KEY;
    expect(solanaRpcUrl()).toBe("https://example.rpc/custom");
    expect(solanaRpcProvider()).toBe("custom");
  });

  it("uses Helius when API key is set", () => {
    delete process.env.SENDA_SOLANA_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
    process.env.HELIUS_API_KEY = "test-key";
    expect(solanaRpcUrl()).toBe(
      "https://mainnet.helius-rpc.com/?api-key=test-key",
    );
    expect(solanaRpcProvider()).toBe("helius");
  });

  it("falls back to public RPC", () => {
    delete process.env.SENDA_SOLANA_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
    delete process.env.HELIUS_API_KEY;
    delete process.env.SENDA_HELIUS_API_KEY;
    expect(solanaRpcUrl()).toBe("https://api.mainnet-beta.solana.com");
    expect(solanaRpcProvider()).toBe("public");
  });
});

describe("5.D-auto payout controls", () => {
  it("defaults AUTO and dry-run off", () => {
    delete process.env.SENDA_PEER_PAYOUTS_AUTO;
    delete process.env.SENDA_REFUNDS_AUTO;
    delete process.env.SENDA_PAYOUT_DRY_RUN;
    expect(peerPayoutsAutoEnabled()).toBe(false);
    expect(refundsAutoEnabled()).toBe(false);
    expect(peerPayoutDryRun()).toBe(false);
  });

  it("enables AUTO and dry-run from env", () => {
    process.env.SENDA_PEER_PAYOUTS_AUTO = "1";
    process.env.SENDA_PAYOUT_DRY_RUN = "true";
    expect(peerPayoutsAutoEnabled()).toBe(true);
    expect(peerPayoutDryRun()).toBe(true);
  });

  it("parses spend caps with conservative defaults", () => {
    delete process.env.SENDA_PAYOUT_MAX_TICKET_USD;
    delete process.env.SENDA_PAYOUT_MAX_PEER_DAILY_USD;
    delete process.env.SENDA_PAYOUT_MAX_GLOBAL_DAILY_USD;
    const unit = 10 ** USDC_DECIMALS;
    expect(peerPayoutMaxTicketMicros()).toBe(50 * unit);
    expect(peerPayoutMaxPeerDailyMicros()).toBe(50 * unit);
    expect(peerPayoutMaxGlobalDailyMicros()).toBe(100 * unit);

    process.env.SENDA_PAYOUT_MAX_TICKET_USD = "25";
    expect(peerPayoutMaxTicketMicros()).toBe(25 * unit);
  });
});
