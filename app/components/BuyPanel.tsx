"use client";

import { useCallback, useEffect, useState } from "react";

type TreasuryInfo = {
  chain: string;
  treasury: string | null;
  usdcMint: string;
  minTopupUsd: number;
  configured: boolean;
  apiBase: string;
  rateCard: {
    daily_driver: {
      prompt_usd_per_mtok: number;
      completion_usd_per_mtok: number;
    };
  };
};

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string };
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signMessage(
    message: Uint8Array,
    display?: string,
  ): Promise<{ signature: Uint8Array }>;
};

function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { solana?: PhantomProvider };
  return w.solana?.isPhantom ? w.solana : w.solana ?? null;
}

function encodeBs58(bytes: Uint8Array): string {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return (
    "1".repeat(zeros) +
    digits
      .reverse()
      .map((d) => alphabet[d])
      .join("")
  );
}

export function BuyPanel() {
  const [info, setInfo] = useState<TreasuryInfo | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [balanceUsd, setBalanceUsd] = useState<number | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/account/treasury")
      .then((r) => r.json())
      .then((d: TreasuryInfo) => setInfo(d))
      .catch(() => setStatus("Failed to load treasury info"));
  }, []);

  const refreshBalance = useCallback(async (w: string) => {
    const res = await fetch(
      `/api/account/balance?wallet=${encodeURIComponent(w)}`,
    );
    const data = (await res.json()) as {
      balance_usd?: number;
      storeReady?: boolean;
    };
    if (data.storeReady === false) {
      setBalanceUsd(null);
      setStatus("Billing store not ready (Redis)");
      return;
    }
    setBalanceUsd(typeof data.balance_usd === "number" ? data.balance_usd : 0);
  }, []);

  async function connect() {
    setStatus(null);
    const phantom = getPhantom();
    if (!phantom) {
      setStatus("Install Phantom (or another Solana wallet) to continue.");
      return;
    }
    try {
      const res = await phantom.connect();
      const w = res.publicKey.toBase58();
      setWallet(w);
      await refreshBalance(w);
    } catch {
      setStatus("Wallet connect cancelled.");
    }
  }

  async function syncDeposits() {
    if (!wallet) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(
        `/api/account/deposit-sync?wallet=${encodeURIComponent(wallet)}`,
      );
      const data = (await res.json()) as {
        ok?: boolean;
        credited?: number;
        error?: string;
        hint?: string;
      };
      if (!res.ok) {
        setStatus(data.hint || data.error || "Sync failed");
      } else {
        setStatus(
          data.credited
            ? `Credited ${data.credited} deposit(s).`
            : "No new deposits found yet — wait for confirmation and retry.",
        );
      }
      await refreshBalance(wallet);
    } finally {
      setBusy(false);
    }
  }

  async function mintKey() {
    if (!wallet) return;
    const phantom = getPhantom();
    if (!phantom) {
      setStatus("Wallet not available");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const timestampMs = Date.now();
      const message = `Senda API key mint\nWallet: ${wallet}\nTs: ${timestampMs}`;
      const signed = await phantom.signMessage(
        new TextEncoder().encode(message),
        "utf8",
      );
      const signatureBase58 = encodeBs58(signed.signature);
      const res = await fetch("/api/account/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, timestampMs, signatureBase58 }),
      });
      const data = (await res.json()) as {
        apiKey?: string;
        error?: string;
      };
      if (!res.ok || !data.apiKey) {
        setStatus(data.error || "Key mint failed");
        return;
      }
      setApiKey(data.apiKey);
      setStatus("API key created — copy it now.");
    } catch {
      setStatus("Signature rejected or mint failed.");
    } finally {
      setBusy(false);
    }
  }

  const dd = info?.rateCard.daily_driver;

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">1. Connect wallet</h2>
        <p className="text-[14px] leading-relaxed text-[var(--fg-muted)]">
          Your Solana address is your account for this preview. Top up an API
          balance, then mint a key for{" "}
          <code className="text-[var(--fg)]">{info?.apiBase ?? "/v1"}</code>.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void connect()}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-[13px] font-semibold text-black"
          >
            {wallet ? "Reconnect" : "Connect Phantom"}
          </button>
          {wallet ? (
            <span className="font-mono text-[12px] text-[var(--fg-muted)]">
              {wallet.slice(0, 4)}…{wallet.slice(-4)}
            </span>
          ) : null}
          {balanceUsd != null ? (
            <span className="text-[13px] text-[var(--fg)]">
              API balance: ${balanceUsd.toFixed(4)}
            </span>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">2. Top up with USDC</h2>
        {!info ? (
          <p className="text-[14px] text-[var(--fg-muted)]">Loading…</p>
        ) : !info.configured || !info.treasury ? (
          <p className="text-[14px] text-[var(--fg-muted)]">
            Deposit address isn&apos;t live on this deployment yet. Check back
            shortly, or ask on Discord if you&apos;re testing with us.
          </p>
        ) : (
          <>
            <p className="text-[14px] leading-relaxed text-[var(--fg-muted)]">
              Send at least{" "}
              <strong className="text-[var(--fg)]">${info.minTopupUsd}</strong>{" "}
              USDC on Solana mainnet to this address, then sync:
            </p>
            <code className="block break-all rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 font-mono text-[12px]">
              {info.treasury}
            </code>
            <p className="text-[12px] text-[var(--fg-muted)]">
              USDC mint: {info.usdcMint}
            </p>
            <button
              type="button"
              disabled={!wallet || busy}
              onClick={() => void syncDeposits()}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-2 text-[13px] font-medium disabled:opacity-40"
            >
              Sync deposit
            </button>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">3. Create API key</h2>
        <p className="text-[14px] leading-relaxed text-[var(--fg-muted)]">
          Sign a short message to mint a{" "}
          <code className="text-[var(--fg)]">ck_live_…</code> key. Copy it
          once — we only store a hash.
        </p>
        <button
          type="button"
          disabled={!wallet || busy}
          onClick={() => void mintKey()}
          className="rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-2 text-[13px] font-medium disabled:opacity-40"
        >
          Create API key
        </button>
        {apiKey ? (
          <code className="block break-all rounded-md border border-[var(--accent)]/40 bg-[var(--bg-elev)] px-3 py-2 font-mono text-[12px]">
            {apiKey}
          </code>
        ) : null}
      </section>

      {dd ? (
        <section className="space-y-2 border-t border-[var(--border)] pt-8">
          <h2 className="text-lg font-semibold tracking-tight">Preview rate card</h2>
          <p className="text-[14px] text-[var(--fg-muted)]">
            Daily-driver models: ${dd.prompt_usd_per_mtok.toFixed(2)} / $
            {dd.completion_usd_per_mtok.toFixed(2)} per MTok (prompt /
            completion). Capacity-tier models cost more. Rates may change while
            this is in preview.
          </p>
        </section>
      ) : null}

      {status ? (
        <p className="text-[13px] text-[var(--accent)]" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
