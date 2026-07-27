import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { solanaRpcProvider, solanaRpcUrl } from "./solana-config";

const KEYS = [
  "SENDA_SOLANA_RPC_URL",
  "SOLANA_RPC_URL",
  "HELIUS_API_KEY",
  "SENDA_HELIUS_API_KEY",
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
