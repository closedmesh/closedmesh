/**
 * Phase 5.E — customer API keys (`ck_live_…`).
 *
 * Plaintext shown once at mint; Redis (or Vitest memory) stores SHA-256 only.
 */

import { createHash, randomBytes } from "node:crypto";
import { getRedis } from "./redis";

const HASH_PREFIX = "senda:cust:apikey:hash";
const BY_ACCOUNT_PREFIX = "senda:cust:apikey:by-account";
const TTL_SEC = 365 * 24 * 3600;

export type ApiKeyRecord = {
  accountId: string;
  prefix: string;
  createdAt: string;
  revokedAt?: string;
};

type MemoryStore = {
  byHash: Map<string, ApiKeyRecord>;
  byAccount: Map<string, Set<string>>;
};

const memory: MemoryStore = {
  byHash: new Map(),
  byAccount: new Map(),
};

function useMemory(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.SENDA_CUST_LEDGER_MEMORY === "1"
  );
}

export function apiKeysStoreReady(): boolean {
  return getRedis() != null || useMemory();
}

export function resetApiKeysMemory(): void {
  memory.byHash.clear();
  memory.byAccount.clear();
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** `ck_live_<32 hex chars>` */
export function generateApiKeyPlaintext(): { plaintext: string; prefix: string } {
  const secret = randomBytes(16).toString("hex");
  const plaintext = `ck_live_${secret}`;
  const prefix = plaintext.slice(0, 12); // ck_live_xxxx
  return { plaintext, prefix };
}

function hashKey(hash: string): string {
  return `${HASH_PREFIX}:${hash}`;
}

function accountKey(accountId: string): string {
  return `${BY_ACCOUNT_PREFIX}:${accountId}`;
}

export async function mintApiKey(
  accountId: string,
): Promise<
  | { ok: true; plaintext: string; prefix: string; record: ApiKeyRecord }
  | { ok: false; error: string }
> {
  const id = accountId.trim();
  if (!id || id.length > 128) return { ok: false, error: "invalid_account" };
  if (!apiKeysStoreReady()) return { ok: false, error: "store_unavailable" };

  const { plaintext, prefix } = generateApiKeyPlaintext();
  const hash = hashApiKey(plaintext);
  const record: ApiKeyRecord = {
    accountId: id,
    prefix,
    createdAt: new Date().toISOString(),
  };

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(hashKey(hash), JSON.stringify(record), { ex: TTL_SEC });
      await redis.sadd(accountKey(id), hash);
      await redis.expire(accountKey(id), TTL_SEC);
      return { ok: true, plaintext, prefix, record };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  memory.byHash.set(hash, record);
  const set = memory.byAccount.get(id) ?? new Set();
  set.add(hash);
  memory.byAccount.set(id, set);
  return { ok: true, plaintext, prefix, record };
}

export async function resolveApiKey(
  bearer: string,
): Promise<ApiKeyRecord | null> {
  const plaintext = bearer.trim();
  if (!plaintext.startsWith("ck_")) return null;
  const hash = hashApiKey(plaintext);
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get<string | null>(hashKey(hash));
      if (!raw) return null;
      const record = (
        typeof raw === "string" ? JSON.parse(raw) : raw
      ) as ApiKeyRecord;
      if (record.revokedAt) return null;
      return record;
    } catch {
      return null;
    }
  }
  if (!useMemory()) return null;
  const record = memory.byHash.get(hash);
  if (!record || record.revokedAt) return null;
  return record;
}

export async function revokeApiKey(input: {
  accountId: string;
  prefix: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = input.accountId.trim();
  const prefix = input.prefix.trim();
  if (!id || !prefix) return { ok: false, error: "invalid_input" };
  if (!apiKeysStoreReady()) return { ok: false, error: "store_unavailable" };

  const redis = getRedis();
  if (redis) {
    try {
      const hashes = await redis.smembers(accountKey(id));
      for (const hash of hashes) {
        const raw = await redis.get<string | null>(hashKey(hash));
        if (!raw) continue;
        const record = (
          typeof raw === "string" ? JSON.parse(raw) : raw
        ) as ApiKeyRecord;
        if (record.prefix !== prefix) continue;
        record.revokedAt = new Date().toISOString();
        await redis.set(hashKey(hash), JSON.stringify(record), { ex: TTL_SEC });
        return { ok: true };
      }
      return { ok: false, error: "not_found" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "redis_error",
      };
    }
  }

  const hashes = memory.byAccount.get(id);
  if (!hashes) return { ok: false, error: "not_found" };
  for (const hash of hashes) {
    const record = memory.byHash.get(hash);
    if (!record || record.prefix !== prefix) continue;
    record.revokedAt = new Date().toISOString();
    memory.byHash.set(hash, record);
    return { ok: true };
  }
  return { ok: false, error: "not_found" };
}

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization")?.trim() ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1]?.trim() || null;
}
