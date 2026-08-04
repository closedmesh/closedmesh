"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";

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

export function BuyPanel() {
  const [info, setInfo] = useState<TreasuryInfo | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [balanceUsd, setBalanceUsd] = useState<number | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const signedIn = Boolean(wallet);

  useEffect(() => {
    void fetch("/api/account/treasury")
      .then((r) => r.json())
      .then((d: TreasuryInfo) => setInfo(d))
      .catch(() => setStatus("Failed to load treasury info"));
  }, []);

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
    setBusy(true);
    const phantom = getPhantom();
    if (!phantom) {
      setStatus("Install Phantom (or another Solana wallet) to continue.");
      setBusy(false);
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
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  }

  async function refreshAll() {
    if (!wallet) return;
    setBusy(true);
    setStatus(null);
    try {
      await refreshBalance(wallet);
      await refreshRefunds(wallet);
      await refreshKeys(wallet);
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  }

  function signOut() {
    setWallet(null);
    setBalanceUsd(null);
    setApiKey(null);
    setKeys([]);
    setRefunds([]);
    setStatus(null);
    setMenuOpen(false);
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
          ? `Refund queued for $${data.request.usd.toFixed(2)} USDC (auto under caps when enabled).`
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
  const activeKeys = keys.filter((k) => !k.revoked).length;
  const apiBase = info?.apiBase ?? "https://senda.network/v1";
  const apiBaseDisplay = apiBase.replace(/^https?:\/\//, "");
  const rateLabel = dd
    ? `$${dd.prompt_usd_per_mtok.toFixed(2)} / $${dd.completion_usd_per_mtok.toFixed(2)}`
    : "—";

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
            API account
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            Balance &amp; keys
          </h1>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-[var(--fg-muted)]">
            Prepaid USDC balance for{" "}
            <code className="text-[var(--fg)]">{apiBaseDisplay}</code>.
            Homepage chat stays free.{" "}
            <Link href="/docs" className="text-[var(--accent)] hover:underline">
              Docs
            </Link>
            {" · "}
            <Link href="/terms" className="text-[var(--accent)] hover:underline">
              Terms
            </Link>
            {" · "}
            <Link href="/earn" className="text-[var(--accent)] hover:underline">
              Earner panel
            </Link>
          </p>
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
                  onClick={() => void refreshAll()}
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
                  Connect a Solana wallet. Your address is the account for this
                  preview — deposits, keys, and refunds are signed, not
                  session-stored.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void connect()}
                className="shrink-0 rounded-md bg-[var(--accent)] px-4 py-2 text-[13px] font-semibold text-black disabled:opacity-50"
              >
                {busy ? "Connecting…" : "Connect wallet"}
              </button>
            </div>
          </section>

          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label="API balance"
              value="—"
              hint="After connect"
            />
            <StatCard
              label="Active keys"
              value="—"
              hint="ck_live_…"
            />
            <StatCard
              label="Rate (daily-driver)"
              value={rateLabel}
              hint="USD per MTok · prompt / completion"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Deposit" meta="USDC · Solana">
              {!info ? (
                <p className="text-[13px] text-[var(--fg-muted)]">Loading…</p>
              ) : !info.configured || !info.treasury ? (
                <p className="text-[13px] text-[var(--fg-muted)]">
                  Deposit address isn&apos;t live on this deployment yet.
                </p>
              ) : (
                <>
                  <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
                    Min top-up ${info.minTopupUsd} USDC mainnet. Connect to sync
                    credits after sending.
                  </p>
                  <code className="mt-3 block break-all rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-[11px] text-[var(--fg)]">
                    {info.treasury}
                  </code>
                </>
              )}
            </Panel>
            <Panel title="Endpoint" meta="OpenAI-compatible">
              <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
                Base URL <code className="text-[var(--fg)]">{apiBase}</code>.
                Auth header:{" "}
                <code className="text-[var(--fg)]">Bearer ck_…</code>
              </p>
              <p className="mt-3 text-[12px] text-[var(--fg-muted)]">
                Running a node? Peer USD withdraws on{" "}
                <Link href="/earn" className="text-[var(--accent)] hover:underline">
                  /earn
                </Link>
                . Public books:{" "}
                <Link
                  href="/metrics"
                  className="text-[var(--accent)] hover:underline"
                >
                  /metrics
                </Link>
                .
              </p>
            </Panel>
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label="API balance"
              value={
                balanceUsd == null ? "—" : `$${balanceUsd.toFixed(4)}`
              }
              hint={`Refund min $${minWithdraw.toFixed(0)}`}
            />
            <StatCard
              label="Active keys"
              value={String(activeKeys)}
              hint={
                keys.length > 0
                  ? `${keys.length} total · revoke anytime`
                  : "Mint a ck_ key below"
              }
            />
            <StatCard
              label="Rate (daily-driver)"
              value={rateLabel}
              hint="USD per MTok · may change in preview"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Deposit" meta="USDC · Solana">
              {!info ? (
                <p className="text-[13px] text-[var(--fg-muted)]">Loading…</p>
              ) : !info.configured || !info.treasury ? (
                <p className="text-[13px] text-[var(--fg-muted)]">
                  Deposit address isn&apos;t live on this deployment yet.
                </p>
              ) : (
                <>
                  <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
                    Send ≥ ${info.minTopupUsd} USDC on Solana mainnet, then
                    sync.
                  </p>
                  <code className="mt-3 block break-all rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-[11px]">
                    {info.treasury}
                  </code>
                  <p className="mt-2 font-mono text-[11px] text-[var(--fg-muted)]">
                    mint {info.usdcMint.slice(0, 4)}…{info.usdcMint.slice(-4)}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void syncDeposits()}
                    className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium transition hover:bg-[var(--bg-elev-2)] disabled:opacity-40"
                  >
                    Sync deposit
                  </button>
                </>
              )}
            </Panel>

            <Panel title="API keys" meta="ck_live_…">
              <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
                Sign to mint. Shown once — we store a hash only.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void mintKey()}
                className="mt-3 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] font-semibold text-black disabled:opacity-40"
              >
                Create key
              </button>
              {apiKey ? (
                <code className="mt-3 block break-all rounded-md border border-[var(--accent)]/35 bg-[var(--bg)] px-3 py-2 font-mono text-[11px]">
                  {apiKey}
                </code>
              ) : null}
              {keys.length > 0 ? (
                <ul className="mt-3 divide-y divide-[var(--border)] border-t border-[var(--border)]">
                  {keys.map((k) => (
                    <li
                      key={k.prefix}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12px]"
                    >
                      <span className="font-mono text-[var(--fg)]">
                        {k.prefix}…
                      </span>
                      {k.revoked ? (
                        <span className="text-[var(--fg-muted)]">revoked</span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void revokeKey(k.prefix)}
                          className="text-[var(--fg-muted)] underline-offset-2 hover:text-[var(--fg)] hover:underline disabled:opacity-40"
                        >
                          Revoke
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-[12px] text-[var(--fg-muted)]">
                  No keys yet.
                </p>
              )}
            </Panel>

            <Panel title="Refund" meta={`min $${minWithdraw.toFixed(0)}`}>
              <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
                Unused prepaid balance returns as USDC to this wallet. Spent
                balance is not refundable. Preview: may auto-settle under caps.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void requestRefund()}
                className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium transition hover:bg-[var(--bg-elev-2)] disabled:opacity-40"
              >
                Request refund
              </button>
              {refunds.length > 0 ? (
                <ul className="mt-3 divide-y divide-[var(--border)] border-t border-[var(--border)]">
                  {refunds.slice(0, 5).map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 font-mono text-[12px] text-[var(--fg-muted)]"
                    >
                      <span>
                        ${r.usd.toFixed(2)} · {r.status}
                      </span>
                      <span>{r.id.slice(0, 10)}…</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>

            <Panel title="Usage" meta="OpenAI-compatible">
              <p className="text-[13px] leading-relaxed text-[var(--fg-muted)]">
                <code className="text-[var(--fg)]">
                  {`POST ${apiBase.replace(/\/$/, "")}/chat/completions`}
                </code>
              </p>
              <pre className="mt-3 overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--fg-muted)]">{`Authorization: Bearer ck_…
Content-Type: application/json`}</pre>
              <p className="mt-3 text-[12px] text-[var(--fg-muted)]">
                <Link href="/docs" className="text-[var(--accent)] hover:underline">
                  Developer docs →
                </Link>
              </p>
            </Panel>
          </div>
        </>
      )}

      {status ? (
        <p
          className="rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 text-[13px] text-[var(--fg)]"
          role="status"
        >
          {status}
        </p>
      ) : null}

      <p className="text-[11px] leading-relaxed text-[var(--fg-muted)]">
        Preview account — rates and settlement can change. Not an SLA.{" "}
        <Link href="/metrics" className="text-[var(--accent)] hover:underline">
          Settlement books
        </Link>
        .
      </p>
    </div>
  );
}
