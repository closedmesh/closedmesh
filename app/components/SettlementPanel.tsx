"use client";

import { useEffect, useState } from "react";

type SettlementSnapshot = {
  ok: true;
  asOf: string;
  liabilities: {
    customer_usd: number;
    peer_usd: number;
    pending_refunds_usd: number;
    pending_peer_payouts_usd: number;
    total_usd: number;
  };
  paid_out: {
    peer_usd: number;
    pending_payout_tickets: number;
  };
  treasury: { address: string | null; usdc: number | null; error?: string };
  payer: { address: string | null; usdc: number | null; error?: string };
  recent_payouts: Array<{
    id: string;
    usd: number;
    status: string;
    createdAt: string;
    txSignature: string | null;
    solscanUrl: string | null;
  }>;
  note: string;
};

function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(n >= 10 ? 2 : 4)}`;
}

function shortAddr(a: string | null): string {
  if (!a) return "—";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/**
 * Public 5.D-audit strip: liabilities, paid-out, treasury/payer floats, recent txs.
 */
export function SettlementPanel() {
  const [data, setData] = useState<SettlementSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/account/settlement-snapshot");
        const json = (await res.json()) as SettlementSnapshot & {
          error?: string;
        };
        if (!res.ok || !json.ok) {
          if (!cancelled) setError(json.error ?? "unavailable");
          return;
        }
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
          Settlement
        </h2>
        <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
          USDC · public books
        </span>
      </div>

      {error ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4 text-[12px] text-[var(--fg-muted)]">
          Settlement snapshot unavailable ({error}).
        </div>
      ) : !data ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4 text-[12px] text-[var(--fg-muted)]">
          Loading settlement…
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
                Paid to peers
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {usd(data.paid_out.peer_usd)}
              </div>
              <div className="mt-1 text-[11px] text-[var(--fg-muted)]">
                Lifetime USDC sent
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
                Outstanding liability
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {usd(data.liabilities.total_usd)}
              </div>
              <div className="mt-1 text-[11px] text-[var(--fg-muted)]">
                Customer {usd(data.liabilities.customer_usd)} · peer{" "}
                {usd(data.liabilities.peer_usd)}
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
                Deposit treasury
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {usd(data.treasury.usdc)}
              </div>
              <div className="mt-1 font-mono text-[11px] text-[var(--fg-muted)]">
                {shortAddr(data.treasury.address)}
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
                Payout float
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {usd(data.payer.usdc)}
              </div>
              <div className="mt-1 font-mono text-[11px] text-[var(--fg-muted)]">
                {shortAddr(data.payer.address)}
                {data.paid_out.pending_payout_tickets > 0
                  ? ` · ${data.paid_out.pending_payout_tickets} pending`
                  : ""}
              </div>
            </div>
          </div>

          {data.recent_payouts.length > 0 ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] px-4 py-4">
              <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
                Recent peer payouts
              </div>
              <ul className="space-y-1.5 text-[12px]">
                {data.recent_payouts.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-2 font-mono text-[var(--fg-muted)]"
                  >
                    <span>
                      {usd(p.usd)} ·{" "}
                      {new Date(p.createdAt).toLocaleDateString()}
                    </span>
                    {p.solscanUrl ? (
                      <a
                        href={p.solscanUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        {p.txSignature?.slice(0, 8)}…↗
                      </a>
                    ) : (
                      <span>{p.status}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="text-[11px] leading-relaxed text-[var(--fg-muted)]">
            {data.note} Updated {new Date(data.asOf).toLocaleString()}.
          </p>
        </div>
      )}
    </section>
  );
}
