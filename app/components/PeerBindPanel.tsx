"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

/** Opens the installed Senda desktop app (macOS / Windows / Linux). */
const SENDA_APP_DEEPLINK = "senda://dashboard";

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

/**
 * Public step-2 UI: attach Phantom wallet to a node-proven bind challenge.
 */
export function PeerBindPanel() {
  const params = useSearchParams();
  const challengeId = useMemo(
    () => params.get("c")?.trim() || params.get("challengeId")?.trim() || "",
    [params],
  );

  const [status, setStatus] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [phase, setPhase] = useState<
    "loading" | "ready" | "done" | "error" | "missing"
  >("loading");
  const [wallet, setWallet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!challengeId) {
      setPhase("missing");
      return;
    }
    setPhase("loading");
    try {
      const res = await fetch(
        `/api/account/peer-bind/verify?challengeId=${encodeURIComponent(challengeId)}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as {
        status?: string;
        peerId?: string;
        error?: string;
      };
      if (!res.ok) {
        setPhase("error");
        setStatus(data.error || "Challenge not found");
        return;
      }
      if (data.status === "pending_wallet" && data.peerId) {
        setPeerId(data.peerId);
        setPhase("ready");
        setStatus(null);
        return;
      }
      if (data.status === "pending_node") {
        setPhase("error");
        setStatus(
          "This link isn’t ready yet — finish “Bind wallet” in the Senda desktop app first.",
        );
        return;
      }
      setPhase("error");
      setStatus(data.status === "expired" ? "This link expired." : "Unavailable");
    } catch {
      setPhase("error");
      setStatus("Could not reach bind API");
    }
  }, [challengeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const attach = async () => {
    if (!challengeId || !peerId) return;
    const phantom = getPhantom();
    if (!phantom) {
      setStatus("Install Phantom (or another Solana wallet) to continue.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const connected = await phantom.connect();
      const w = connected.publicKey.toBase58();
      setWallet(w);
      const timestampMs = Date.now();
      const message = `Senda peer payout wallet\nPeer: ${peerId}\nWallet: ${w}\nTs: ${timestampMs}`;
      const signed = await phantom.signMessage(
        new TextEncoder().encode(message),
        "utf8",
      );
      const res = await fetch("/api/account/peer-bind/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId,
          wallet: w,
          walletSignatureBase58: encodeBs58(signed.signature),
          timestampMs,
        }),
      });
      const data = (await res.json()) as { error?: string; payout_wallet?: string };
      if (!res.ok) {
        setStatus(data.error || "Bind failed");
        return;
      }
      setPhase("done");
      setStatus(`Bound ${data.payout_wallet} to peer ${peerId}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Bind failed");
    } finally {
      setBusy(false);
    }
  };

  if (phase === "missing") {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6 text-[14px] text-[var(--fg-muted)]">
        Open this page from the Senda desktop app after you start a wallet bind.
        The link includes a one-time challenge.
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6">
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
          Peer payout wallet
        </div>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg)]">
          {phase === "done" ? "Wallet bound" : "Confirm with Phantom"}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--fg-muted)]">
          Your desktop node already proved it controls this peer. Sign once with
          Phantom to set the USDC payout address.
        </p>
      </div>

      {peerId && (
        <div className="font-mono text-[12px] text-[var(--fg-muted)]">
          Peer <span className="text-[var(--fg)]">{peerId}</span>
        </div>
      )}

      {phase === "ready" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void attach()}
          className="rounded-lg bg-[var(--accent)] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {busy ? "Signing…" : "Bind with Phantom"}
        </button>
      )}

      {wallet && phase !== "done" && (
        <div className="break-all font-mono text-[11px] text-[var(--fg-muted)]">
          {wallet}
        </div>
      )}

      {phase === "done" && (
        <div className="space-y-2">
          <a
            href={SENDA_APP_DEEPLINK}
            className="inline-flex rounded-lg bg-[var(--accent)] px-3 py-2 text-[13px] font-medium text-white"
          >
            Open Senda app
          </a>
          <p className="text-[12px] text-[var(--fg-muted)]">
            Requires Senda desktop 0.1.127+. If nothing opens, switch back to the
            app — Peer USD refreshes on its own.
          </p>
        </div>
      )}

      {status && (
        <p className="text-[13px] text-[var(--fg-muted)]" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
