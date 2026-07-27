"use client";

import { useCallback, useEffect, useState } from "react";

type TreasuryInfo = {
  chain: string;
  treasury: string | null;
  usdcMint: string;
  minTopupUsd: number;
  minWithdrawUsd?: number;
  configured: boolean;
  apiBase: string;
  rateCard: {
    daily_driver: {
      prompt_usd_per_mtok: number;
      completion_usd_per_mtok: number;
    };
  };
};

type RefundRow = {
  id: string;
  status: string;
  usd: number;
  destination: string;
  createdAt: string;
};

type KeyRow = {
  prefix: string;
  createdAt: string;
  revoked: boolean;
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
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/account/treasury")
      .then((r) => r.json())
      .then((d: TreasuryInfo) => setInfo(d))
      .catch(() => setStatus("Failed to load treasury info"));
  }, []);

  const refreshBalance = useCallback(async (w: string) => {
    const timestampMs = Date.now();
    const msg = `Senda balance read\nWallet: ${w}\nTs: ${timestampMs}`;
    const phantom = getPhantom();
    if (!phantom) {
      setStatus("Wallet not available for signed balance read");
      return;
    }
    const signed = await phantom.signMessage(
      new TextEncoder().encode(msg),
      "utf8",
    );
    const signatureBase58 = encodeBs58(signed.signature);
    const res = await fetch(
      `/api/account/balance?wallet=${encodeURIComponent(w)}&timestampMs=${timestampMs}&signatureBase58=${encodeURIComponent(signatureBase58)}`,
    );
    const data = (await res.json()) as {
      balance_usd?: number;
      storeReady?: boolean;
      error?: string;
    };
    if (!res.ok) {
      setStatus(data.error || "Balance read failed");
      return;
    }
    if (data.storeReady === false) {
      setBalanceUsd(null);
      setStatus("Billing store not ready (Redis)");
      return;
    }
    setBalanceUsd(typeof data.balance_usd === "number" ? data.balance_usd : 0);
  }, []);

  const refreshRefunds = useCallback(async (w: string) => {
    const timestampMs = Date.now();
    const msg = `Senda refund list\nWallet: ${w}\nTs: ${timestampMs}`;
    const phantom = getPhantom();
    if (!phantom) return;
    const signed = await phantom.signMessage(
      new TextEncoder().encode(msg),
      "utf8",
    );
    const signatureBase58 = encodeBs58(signed.signature);
    const res = await fetch(
      `/api/account/refund?wallet=${encodeURIComponent(w)}&timestampMs=${timestampMs}&signatureBase58=${encodeURIComponent(signatureBase58)}`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as { refunds?: RefundRow[] };
    setRefunds(Array.isArray(data.refunds) ? data.refunds : []);
  }, []);

  const refreshKeys = useCallback(async (w: string) => {
    const timestampMs = Date.now();
    const msg = `Senda API key list\nWallet: ${w}\nTs: ${timestampMs}`;
    const phantom = getPhantom();
    if (!phantom) return;
    const signed = await phantom.signMessage(
      new TextEncoder().encode(msg),
      "utf8",
    );
    const signatureBase58 = encodeBs58(signed.signature);
    const res = await fetch(
      `/api/account/keys?wallet=${encodeURIComponent(w)}&timestampMs=${timestampMs}&signatureBase58=${encodeURIComponent(signatureBase58)}`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as { keys?: KeyRow[] };
    setKeys(Array.isArray(data.keys) ? data.keys : []);
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
      await refreshRefunds(w);
      await refreshKeys(w);
    } catch {
      setStatus("Wallet connect cancelled.");
    }
  }

  async function syncDeposits() {
    if (!wallet) return;
    setBusy(true);
    setStatus(null);
    try {
      const timestampMs = Date.now();
      const msg = `Senda deposit sync\nWallet: ${wallet}\nTs: ${timestampMs}`;
      const phantom = getPhantom();
      if (!phantom) {
        setStatus("Wallet not available");
        return;
      }
      const signed = await phantom.signMessage(
        new TextEncoder().encode(msg),
        "utf8",
      );
      const signatureBase58 = encodeBs58(signed.signature);
      const res = await fetch(
        `/api/account/deposit-sync?wallet=${encodeURIComponent(wallet)}&timestampMs=${timestampMs}&signatureBase58=${encodeURIComponent(signatureBase58)}`,
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
      await refreshKeys(wallet);
    } catch {
      setStatus("Signature rejected or mint failed.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(prefix: string) {
    if (!wallet) return;
    const phantom = getPhantom();
    if (!phantom) return;
    setBusy(true);
    setStatus(null);
    try {
      const timestampMs = Date.now();
      const message = `Senda API key revoke\nWallet: ${wallet}\nPrefix: ${prefix}\nTs: ${timestampMs}`;
      const signed = await phantom.signMessage(
        new TextEncoder().encode(message),
        "utf8",
      );
      const signatureBase58 = encodeBs58(signed.signature);
      const res = await fetch("/api/account/keys", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, prefix, timestampMs, signatureBase58 }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setStatus(data.error || "Revoke failed");
        return;
      }
      setStatus(`Revoked ${prefix}`);
      await refreshKeys(wallet);
    } finally {
      setBusy(false);
    }
  }

  async function requestRefund() {
    if (!wallet) return;
    const phantom = getPhantom();
    if (!phantom) {
      setStatus("Wallet not available");
      return;
    }
    const min = info?.minWithdrawUsd ?? 10;
    if (balanceUsd != null && balanceUsd < min) {
      setStatus(`Refunds need at least $${min.toFixed(0)} available.`);
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const timestampMs = Date.now();
      const destination = wallet;
      const message = `Senda API balance refund\nWallet: ${wallet}\nDestination: ${destination}\nTs: ${timestampMs}`;
      const signed = await phantom.signMessage(
        new TextEncoder().encode(message),
        "utf8",
      );
      const signatureBase58 = encodeBs58(signed.signature);
      const res = await fetch("/api/account/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wallet,
          destination,
          timestampMs,
          signatureBase58,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        hint?: string;
        request?: { usd?: number };
      };
      if (!res.ok) {
        setStatus(data.error || "Refund request failed");
        return;
      }
      setStatus(
        data.request?.usd != null
          ? `Refund queued for $${data.request.usd.toFixed(2)} USDC (ops settles).`
          : data.hint || "Refund queued.",
      );
      await refreshBalance(wallet);
      await refreshRefunds(wallet);
    } catch {
      setStatus("Signature rejected or refund failed.");
    } finally {
      setBusy(false);
    }
  }

  const dd = info?.rateCard.daily_driver;
  const minWithdraw = info?.minWithdrawUsd ?? 10;

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">1. Connect wallet</h2>
        <p className="text-[14px] leading-relaxed text-[var(--fg-muted)]">
          Your Solana address is your account for this preview. Top up an API
          balance, then mint a key for{" "}
          <code className="text-[var(--fg)]">{info?.apiBase ?? "/v1"}</code>.
          Balance reads and syncs require a short wallet signature.
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
        {keys.length > 0 ? (
          <ul className="space-y-2 text-[12px] text-[var(--fg-muted)]">
            {keys.map((k) => (
              <li key={k.prefix} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[var(--fg)]">{k.prefix}…</span>
                {k.revoked ? (
                  <span>revoked</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revokeKey(k.prefix)}
                    className="underline disabled:opacity-40"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="space-y-3 border-t border-[var(--border)] pt-8">
        <h2 className="text-lg font-semibold tracking-tight">4. Request refund</h2>
        <p className="text-[14px] leading-relaxed text-[var(--fg-muted)]">
          Unused prepaid API balance can be returned as USDC to this wallet.
          Minimum ${minWithdraw.toFixed(0)}. Preview settlements are ops-assisted
          — see the{" "}
          <a href="/terms" className="text-[var(--accent)] hover:underline">
            terms
          </a>
          .
        </p>
        <button
          type="button"
          disabled={!wallet || busy}
          onClick={() => void requestRefund()}
          className="rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-2 text-[13px] font-medium disabled:opacity-40"
        >
          Request refund
        </button>
        {refunds.length > 0 ? (
          <ul className="space-y-1 text-[12px] text-[var(--fg-muted)]">
            {refunds.slice(0, 5).map((r) => (
              <li key={r.id} className="font-mono">
                {r.id.slice(0, 10)}… ${r.usd.toFixed(2)} — {r.status}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {dd ? (
        <section className="space-y-2 border-t border-[var(--border)] pt-8">
          <h2 className="text-lg font-semibold tracking-tight">Preview rate card</h2>
          <p className="text-[14px] text-[var(--fg-muted)]">
            Daily-driver models: ${dd.prompt_usd_per_mtok.toFixed(2)} / $
            {dd.completion_usd_per_mtok.toFixed(2)} per MTok (prompt /
            completion). Capacity-tier models use a separate (currently lower)
            rate card. Rates may change while this is in preview.
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
