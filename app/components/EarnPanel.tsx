"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  solscanUrl?: string | null;
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
  payoutHistory?: PendingPayout[];
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

function shortWallet(w: string): string {
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

/**
 * Public earner dashboard: Phantom proves wallet ownership → load bound peer
 * credits + Peer USD. Signed-in chrome is a compact top-right user toggle;
 * the educational sign-in block only shows when logged out.
 */
export function EarnPanel() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [data, setData] = useState<EarnerPayload | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const signedIn = Boolean(wallet && data?.peerId);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
      setMenuOpen(false);
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

  const signOut = () => {
    setWallet(null);
    setData(null);
    setLoadedAt(null);
    setStatus(null);
    setMenuOpen(false);
  };

  const models = data?.credits?.tokensByModel
    ? Object.entries(data.credits.tokensByModel).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="space-y-10">
      {/* Page chrome: title left, user control right — same max-width as content */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
            Earners
          </div>
          <h1 className="mt-3 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
            Your node earnings
          </h1>
          {signedIn ? (
            <p className="mt-3 text-[13px] text-[var(--fg-muted)]">
              Peer{" "}
              <span className="font-mono text-[var(--fg)]">{data!.peerId}</span>
              {" · "}
              <Link href="/status" className="text-[var(--accent)] underline">
                /status
              </Link>
              {loadedAt ? (
                <span className="text-[var(--fg-muted)]">
                  {" · "}Updated {loadedAt}
                </span>
              ) : null}
            </p>
          ) : (
            <>
              <p className="mt-4 text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)]">
                Sign with the Phantom wallet you bound in the desktop app. We
                show contributor credits, tokens served by model, and Peer USD
                from paid{" "}
                <code className="text-[var(--fg)]">/v1</code> mesh serves.
              </p>
              <p className="mt-3 text-[13px] text-[var(--fg-muted)]">
                No bind yet?{" "}
                <Link
                  href="/contribute"
                  className="text-[var(--accent)] underline"
                >
                  Run a node
                </Link>
                , then Peer USD → Bind wallet in Senda desktop.{" "}
                <Link
                  href="/peer-bind"
                  className="text-[var(--accent)] underline"
                >
                  Bind help →
                </Link>
              </p>
            </>
          )}
        </div>

        {/* Signed-in only: compact account menu. Connect lives in the card below. */}
        {signedIn && wallet ? (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1.5 text-[12px] font-medium text-[var(--fg)] transition hover:border-[var(--accent)]/40 disabled:opacity-50"
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full bg-[var(--accent)]"
              />
              <span className="font-mono">{shortWallet(wallet)}</span>
              <span aria-hidden className="text-[var(--fg-muted)]">
                ▾
              </span>
            </button>
            {menuOpen ? (
              <div
                role="menu"
                className="absolute right-0 z-10 mt-2 w-44 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] py-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void load(wallet)}
                  className="block w-full px-3 py-2 text-left text-[13px] text-[var(--fg)] hover:bg-[var(--bg-elev-2)] disabled:opacity-50"
                >
                  {busy ? "Signing…" : "Refresh"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={signOut}
                  className="block w-full px-3 py-2 text-left text-[13px] text-[var(--fg-muted)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--fg)]"
                >
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      {!signedIn ? (
        <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-5 py-5">
          <h2 className="text-lg font-semibold tracking-tight">
            Connect wallet
          </h2>
          <p className="text-[14px] leading-relaxed text-[var(--fg-muted)]">
            Use the same Solana wallet you bound as the peer payout address
            (Phantom or another wallet). We never store a session — each refresh
            asks for a short signature.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void connect()}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-[13px] font-semibold text-black disabled:opacity-50"
          >
            {busy ? "Signing…" : "Connect wallet"}
          </button>
        </section>
      ) : null}

      {signedIn && data ? (
        <>
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

          {(data.pendingPayouts?.length ?? 0) > 0 ||
          (data.payoutHistory?.length ?? 0) > 0 ? (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold tracking-tight">
                Payout history
              </h2>
              <p className="text-[13px] text-[var(--fg-muted)]">
                USDC withdrawals for this peer. Sent rows link to Solscan.
              </p>
              <ul className="space-y-1.5">
                {(data.payoutHistory?.length
                  ? data.payoutHistory
                  : data.pendingPayouts!
                ).map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 font-mono text-[12px]"
                  >
                    <span className="text-[var(--fg-muted)]">
                      ${p.usd.toFixed(2)} · {p.status}
                      {" · "}
                      {new Date(p.createdAt).toLocaleDateString()}
                    </span>
                    {p.solscanUrl || p.txSignature ? (
                      <a
                        href={
                          p.solscanUrl ??
                          `https://solscan.io/tx/${p.txSignature}`
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        {(p.txSignature ?? "tx").slice(0, 8)}…↗
                      </a>
                    ) : (
                      <span className="text-[var(--fg-muted)]">{p.id.slice(0, 10)}…</span>
                    )}
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
