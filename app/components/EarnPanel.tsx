"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-[var(--fg)]">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-[11px] leading-relaxed text-[var(--fg-muted)]">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
          {title}
        </h2>
        {meta ? (
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
            {meta}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Public earner dashboard: Phantom proves wallet ownership → load bound peer
 * credits + Peer USD. Signed-in chrome is a compact account menu.
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

  const history =
    data?.payoutHistory?.length
      ? data.payoutHistory
      : data?.pendingPayouts ?? [];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
            Earner dashboard
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            Node earnings
          </h1>
          {signedIn ? (
            <p className="mt-2 text-[13px] text-[var(--fg-muted)]">
              Peer{" "}
              <span className="font-mono text-[var(--fg)]">{data!.peerId}</span>
              {" · "}
              <Link href="/status" className="text-[var(--accent)] hover:underline">
                /status
              </Link>
              {loadedAt ? (
                <span>
                  {" · "}Updated {loadedAt}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-[var(--fg-muted)]">
              Sign with the Solana wallet bound in Senda desktop. Credits,
              tokens served, and Peer USD for that peer.{" "}
              <Link
                href="/contribute"
                className="text-[var(--accent)] hover:underline"
              >
                Run a node
              </Link>
              {" · "}
              <Link
                href="/peer-bind"
                className="text-[var(--accent)] hover:underline"
              >
                Bind help
              </Link>
            </p>
          )}
        </div>

        {signedIn && wallet ? (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1.5 text-[12px] font-medium text-[var(--fg)] transition hover:border-[var(--border-strong)] disabled:opacity-50"
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
              />
              <span className="font-mono">{shortWallet(wallet)}</span>
              <span aria-hidden className="text-[var(--fg-muted)]">
                ▾
              </span>
            </button>
            {menuOpen ? (
              <div
                role="menu"
                className="absolute right-0 z-10 mt-2 w-44 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] py-1 shadow-[var(--shadow-md)]"
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
        <>
          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-5 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 max-w-md">
                <h2 className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
                  Sign in
                </h2>
                <p className="mt-2 text-[14px] leading-relaxed text-[var(--fg-muted)]">
                  Same wallet as Peer USD → Bind in desktop. No session cookie —
                  each refresh asks for a short signature.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void connect()}
                className="shrink-0 rounded-md bg-[var(--accent)] px-4 py-2 text-[13px] font-semibold text-black disabled:opacity-50"
              >
                {busy ? "Signing…" : "Connect wallet"}
              </button>
            </div>
          </section>

          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label="Contributor credits"
              value="—"
              hint="Tier-weighted · not cash"
            />
            <StatCard
              label="Peer USD"
              value="—"
              hint="From paid /v1 mesh serves"
            />
            <StatCard
              label="Tokens served"
              value="—"
              hint="By model after connect"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Before you connect" meta="Requirements">
              <ul className="space-y-2 text-[13px] leading-relaxed text-[var(--fg-muted)]">
                <li>
                  1.{" "}
                  <Link
                    href="/contribute"
                    className="text-[var(--accent)] hover:underline"
                  >
                    Run a node
                  </Link>{" "}
                  and serve mesh traffic.
                </li>
                <li>
                  2. Bind a Solana payout wallet in Senda desktop (Peer USD →
                  Bind).
                </li>
                <li>
                  3. Sign in here with that wallet to read credits and Peer USD.
                </li>
              </ul>
            </Panel>
            <Panel title="Settlement" meta="Public">
              <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
                Aggregate liabilities and peer payouts are on{" "}
                <Link
                  href="/metrics"
                  className="text-[var(--accent)] hover:underline"
                >
                  /metrics
                </Link>
                . Individual withdrawals link to Solscan after send.
              </p>
              <p className="mt-3 text-[12px] text-[var(--fg-muted)]">
                API customers top up on{" "}
                <Link href="/buy" className="text-[var(--accent)] hover:underline">
                  /buy
                </Link>
                .
              </p>
            </Panel>
          </div>
        </>
      ) : null}

      {signedIn && data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label="Contributor credits"
              value={
                data.credits?.storeReady
                  ? (data.credits.credits ?? 0).toLocaleString()
                  : "—"
              }
              hint="Tier-weighted tokens · not cash"
            />
            <StatCard
              label="Peer USD"
              value={
                data.peerUsd?.balance_usd == null
                  ? "—"
                  : `$${data.peerUsd.balance_usd.toFixed(4)}`
              }
              hint={
                data.peerUsd?.self_serve
                  ? `Min withdraw $${data.peerUsd.min_withdraw_usd ?? 10} · desktop`
                  : `Min $${data.peerUsd?.min_withdraw_usd ?? 10} · payouts paused / ops-gated`
              }
            />
            <StatCard
              label="Tokens served"
              value={
                data.credits?.totalTokens
                  ? formatTokenCount(data.credits.totalTokens)
                  : "0"
              }
              hint="Completion tokens attributed to this peer"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="Tokens by model"
              meta={
                data.credits?.totalTokens
                  ? formatTokenCount(data.credits.totalTokens)
                  : undefined
              }
            >
              {models.length === 0 ? (
                <p className="text-[13px] text-[var(--fg-muted)]">
                  No attributed serves yet. Mesh chat or /v1 traffic on your
                  node will appear after sync.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {models.map(([model, tokens]) => (
                    <li
                      key={model}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="font-mono text-[12px] text-[var(--fg)]">
                        {model}
                      </span>
                      <span className="font-mono text-[12px] tabular-nums text-[var(--fg-muted)]">
                        {formatTokenCount(tokens)} tok
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Payout history" meta="USDC">
              {history.length === 0 ? (
                <p className="text-[13px] text-[var(--fg-muted)]">
                  No withdrawals yet. Request payout in desktop when Peer USD
                  clears the minimum.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {history.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 font-mono text-[12px]"
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
                        <span className="text-[var(--fg-muted)]">
                          {p.id.slice(0, 10)}…
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      ) : null}

      {status ? (
        <p
          className="rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 text-[13px] text-[var(--fg)]"
          role="status"
        >
          {status}
        </p>
      ) : null}

      <p className="text-[11px] leading-relaxed text-[var(--fg-muted)]">
        Contributor credits are not cash. Peer USD is a preview liability from
        paid /v1 mesh serves — withdraw when enabled, subject to caps.{" "}
        <Link href="/terms" className="text-[var(--accent)] hover:underline">
          Terms
        </Link>
        .
      </p>
    </div>
  );
}
