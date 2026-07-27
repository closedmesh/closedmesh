import { afterEach, describe, expect, it } from "vitest";
import {
  generateApiKeyPlaintext,
  hashApiKey,
  mintApiKey,
  resetApiKeysMemory,
  resolveApiKey,
  revokeApiKey,
} from "./api-keys";

afterEach(() => {
  resetApiKeysMemory();
});

describe("api keys", () => {
  it("generates ck_live_ plaintext with stable prefix shape", () => {
    const { plaintext, prefix } = generateApiKeyPlaintext();
    expect(plaintext.startsWith("ck_live_")).toBe(true);
    expect(prefix.startsWith("ck_live_")).toBe(true);
    expect(hashApiKey(plaintext)).toHaveLength(64);
  });

  it("mints and resolves a key", async () => {
    const minted = await mintApiKey("acct-1");
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const resolved = await resolveApiKey(minted.plaintext);
    expect(resolved?.accountId).toBe("acct-1");
    expect(resolved?.prefix).toBe(minted.prefix);
  });

  it("does not resolve a revoked key", async () => {
    const minted = await mintApiKey("acct-2");
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    await revokeApiKey({ accountId: "acct-2", prefix: minted.prefix });
    await expect(resolveApiKey(minted.plaintext)).resolves.toBeNull();
  });

  it("rejects non-ck bearers", async () => {
    await expect(resolveApiKey("sk-not-ours")).resolves.toBeNull();
  });
});
