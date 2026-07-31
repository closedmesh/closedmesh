"use client";

import { useCallback, useState } from "react";
import Link from "next/link";

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string };
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signMessage(
    message: Uint8Array,
    display?: string,
  ): Promise<{ signature: Uint8Array }>;
};

type PendingPayout = {
  id: string;
  status: string;
  usd: number;
  createdAt: string;
  txSignature: string | null;
};

type EarnerPayload = {
  ok?: boolean;
  wallet?: string;
  peerId?: string;
  credits?: {
    storeReady: boolean;
    credits: number;
    tokensByModel: Record<string, number>;
    totalTokens: number;
  };
  peerUsd?: {
    storeReady: boolean;
    balance_usd: number | null;
    min_withdraw_usd: number;
    self_serve: boolean;
  };
  pendingPayouts?: PendingPayout[];
  error?: string;
  hint?: string;
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

function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Public earner dashboard: Phantom proves wallet ownership → load bound peer
 * credits + Peer USD. No long-lived session cookie — each load is signed.
 */
export function EarnPanel() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [data, setData] = useState<EarnerPayload | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const load = useCallback(async (w: string) => {
    const phantom = getPhantom();
    if (!phantom) {
      setStatus("Install Phantom (or another Solana wallet) to continue.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const timestampMs = Date.now();
      const message = `Senda earner dashboard\nWallet: ${w}\nTs: ${timestampMs}`;
      const signed = await phantom.signMessage(
        new TextEncoder().encode(message),
        "utf8",
      );
      const signatureBase58 = encodeBs58(signed.signature);
      const res = await fetch(
        `/api/account/earner?wallet=${encodeURIComponent(w)}&timestampMs=${timestampMs}&signatureBase58=${encodeURIComponent(signatureBase58)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as EarnerPayload;
      if (!res.ok) {
        setData(null);
        setStatus(json.hint || json.error || "Could not load earner data");
        return;
      }
      setData(json);
      setLoadedAt(new Date().toLocaleTimeString());
      setStatus(null);
    } catch (err) {
      setData(null);
      setStatus(err instanceof Error ? err.message : "Load failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = async () => {
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
      await load(w);
    } catch {
      setStatus("Wallet connect cancelled.");
    }
  };

  const models = data?.credits?.tokensByModel
    ? Object.entries(data.credits.tokensByModel).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Sign in with Phantom
        </h2>
        <p className="text-[14px] leading-relaxed text-[var(--fg-muted)]">
          Use the same wallet you bound as the peer payout address. We never
          store a session — each refresh asks for a short signature.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void (wallet ? load(wallet) : connect())}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-[13px] font-semibold text-black disabled:opacity-50"
          >
            {busy
              ? "Signing…"
              : wallet
                ? "Refresh"
                : "Connect Phantom"}
          </button>
          {wallet ? (
            <span className="font-mono text-[12px] text-[var(--fg-muted)]">
              {wallet.slice(0, 4)}…{wallet.slice(-4)}
            </span>
          ) : null}
          {loadedAt ? (
            <span className="text-[12px] text-[var(--fg-muted)]">
              Updated {loadedAt}
            </span>
          ) : null}
        </div>
      </section>

      {data?.peerId ? (
        <>
          <section className="space-y-1">
            <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
              Bound peer
            </div>
            <div className="font-mono text-[15px] text-[var(--fg)]">
              {data.peerId}
            </div>
            <p className="text-[12px] text-[var(--fg-muted)]">
              Live mesh presence:{" "}
              <Link
                href="/status"
                className="text-[var(--accent)] underline"
              >
                /status
              </Link>
            </p>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
                Contributor credits
              </div>
              <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
                {data.credits?.storeReady
                  ? (data.credits.credits ?? 0).toLocaleString()
                  : "—"}
              </div>
              <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
                Tier-weighted tokens from mesh serves (not cash).
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
                Peer USD
              </div>
              <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
                {data.peerUsd?.balance_usd == null
                  ? "—"
                  : `$${data.peerUsd.balance_usd.toFixed(4)}`}
              </div>
              <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
                From paid /v1 mesh serves · min withdraw $
                {data.peerUsd?.min_withdraw_usd ?? 10}
                {data.peerUsd?.self_serve
                  ? " · request payout in desktop"
                  : " · ops-gated payouts"}
              </p>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">
              Tokens served
            </h2>
            <p className="text-[13px] text-[var(--fg-muted)]">
              Completion tokens attributed to this peer on the mesh ledger
              {data.credits?.totalTokens
                ? ` · ${formatTokenCount(data.credits.totalTokens)} total`
                : ""}
              .
            </p>
            {models.length === 0 ? (
              <p className="text-[13px] text-[var(--fg-muted)]">
                No attributed serves yet. Chat or /v1 traffic that lands on your
                node will show up here after sync.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {models.map(([model, tokens]) => (
                  <li
                    key={model}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2"
                  >
                    <span className="font-mono text-[12px] text-[var(--accent)]">
                      {model}
                    </span>
                    <span className="font-mono text-[12px] tabular-nums text-[var(--fg)]">
                      {formatTokenCount(tokens)} tok
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(data.pendingPayouts?.length ?? 0) > 0 ? (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold tracking-tight">
                Pending payouts
              </h2>
              <ul className="space-y-1 text-[12px] text-[var(--fg-muted)]">
                {data.pendingPayouts!.map((p) => (
                  <li key={p.id} className="font-mono">
                    {p.id.slice(0, 12)}… ${p.usd.toFixed(2)} — {p.status}
                    {p.txSignature
                      ? ` · ${p.txSignature.slice(0, 8)}…`
                      : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      {status ? (
        <p className="text-[13px] text-[var(--accent)]" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
