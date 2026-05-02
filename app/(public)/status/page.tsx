"use client";

import { useEffect, useRef, useState } from "react";
import { PublicHeader } from "../../components/PublicHeader";
import { MeshLiveStatus } from "../../components/MeshLiveStatus";
import { nodeDisplayState } from "../../lib/node-display-state";
import type { NodeSummary } from "../../lib/use-mesh-status";

type MeshNode = NodeSummary;

type MeshStatus = {
  online: boolean;
  nodeCount: number;
  models: string[];
  nodes: MeshNode[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prettyHostname(raw: string | null): string {
  if (!raw) return "Unknown node";
  // Strip common suffixes like .local, .internal, ip-xxx-xxx-xxx-xxx
  if (raw.startsWith("ip-")) return "Entry node";
  return raw.replace(/\.local$/, "").replace(/\.internal$/, "");
}

function prettyModelName(id: string): string {
  return id
    .replace(/\.gguf$/i, "")
    .replace(/-Q\d+(_K(_[SM])?|_0|_1)?$/i, "")
    .replace(/-UD-Q\d+(_K(_[SM]|_XL))?$/i, "");
}

function backendLabel(backend: string, _vendor: string): string {
  const map: Record<string, string> = {
    metal: "Apple Metal",
    cuda: "NVIDIA CUDA",
    rocm: "AMD ROCm",
    vulkan: "Vulkan",
    cpu: "CPU",
  };
  return map[backend] ?? backend;
}

function backendColor(backend: string): string {
  const map: Record<string, string> = {
    metal: "text-blue-400 bg-blue-400/10 border-blue-400/20",
    cuda: "text-green-400 bg-green-400/10 border-green-400/20",
    rocm: "text-orange-400 bg-orange-400/10 border-orange-400/20",
    vulkan: "text-purple-400 bg-purple-400/10 border-purple-400/20",
    cpu: "text-[var(--fg-muted)] bg-[var(--bg-elev)] border-[var(--border)]",
  };
  return map[backend] ?? "text-[var(--fg-muted)] bg-[var(--bg-elev)] border-[var(--border)]";
}

// Color/label derivation lives in app/lib/node-display-state.ts so this
// page, the dashboard, and the local /nodes mesh table can never disagree
// about what the same node looks like at the same moment.

// ---------------------------------------------------------------------------
// Node card
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function NodeCard({
  node,
  history,
}: {
  node: MeshNode;
  history?: NodeHistory;
}) {
  const hostname = prettyHostname(node.hostname);
  const isEntryNode = node.hostname?.startsWith("ip-");
  const cap = node.capability;
  const isServing = node.state === "serving";

  // Honest display: show what the node is actually doing right now. We
  // used to "smooth" loading→standby→Ready when the node had been good
  // recently, on the theory that re-elections briefly blip nodes through
  // these states. That assumption was wrong — a node can also get *stuck*
  // in "loading" for minutes (model failing to fit in VRAM, runtime bug,
  // etc.), and the smoothing made the page lie about it ("Ready · serving
  // Qwen3" while inference 503'd because the host never finished loading).
  // Show the real state; if the user sees "Loading 30s" that's the actual
  // information they need.
  const { dot, label: stateLabel } = nodeDisplayState(node);

  // How long has this node been stuck in `loading`? `loadingSince` is
  // tracked in history and reset whenever state moves to anything other
  // than `loading`. Past ~20s it's almost certainly stuck rather than
  // genuinely re-loading.
  const loadingFor =
    node.state === "loading" && history?.loadingSince
      ? Date.now() - history.loadingSince
      : 0;
  const stuckLoading = loadingFor > 20_000;

  // "Online for Xm" when we have history. Tells the user this isn't a
  // flapping node — it's been in the mesh consistently for a while.
  const onlineFor =
    history && !isEntryNode
      ? formatDuration(Date.now() - history.firstSeen)
      : null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-5 flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* State indicator */}
          <span className="relative mt-0.5 inline-flex h-2.5 w-2.5 flex-shrink-0">
            {isServing && (
              <span
                aria-hidden
                className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60"
              />
            )}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dot}`} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--fg)] truncate">
              {isEntryNode ? "Entry node" : hostname}
            </div>
            <div className="text-[11px] text-[var(--fg-muted)] truncate">
              {isEntryNode ? (
                "mesh.closedmesh.com · always-on gateway"
              ) : (
                <>
                  {/* If the node is stuck loading we make it visually
                      distinct so the user immediately sees that this peer
                      is NOT actually serving — even though the green dot
                      means it's connected to the mesh. */}
                  {stuckLoading ? (
                    <span className="text-amber-400">
                      Stuck loading {formatDuration(loadingFor)}
                    </span>
                  ) : node.state === "loading" && loadingFor > 0 ? (
                    <span className="text-amber-300">
                      {stateLabel} {formatDuration(loadingFor)}
                    </span>
                  ) : (
                    stateLabel
                  )}
                  {onlineFor ? ` · online ${onlineFor}` : null}
                  {` · ${node.id.slice(0, 10)}`}
                </>
              )}
            </div>
          </div>
        </div>
        {/* Backend chip */}
        {!isEntryNode && (
          <span
            className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${backendColor(cap.backend)}`}
          >
            {backendLabel(cap.backend, cap.vendor)}
          </span>
        )}
      </div>

      {/* Hardware row */}
      {!isEntryNode && (
        <div className="flex items-center gap-4 text-[12px] text-[var(--fg-muted)]">
          {cap.vramGb > 0 && (
            <span>
              <span className="font-medium text-[var(--fg)]">{cap.vramGb} GB</span> VRAM
            </span>
          )}
          {cap.vramGb === 0 && cap.backend === "cpu" && (
            <span>CPU inference</span>
          )}
        </div>
      )}

      {/* Models. While a node is in `loading`, its `servingModels` lists
          what it's *trying* to load, not what's actually loaded — so we
          render those as muted "loading: X" rather than as ready model
          badges. Without this distinction the card would say "Qwen3-0.6B"
          in the same green pill as a fully serving node, which was the
          original "the page is lying" complaint. */}
      {node.servingModels.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {node.servingModels.map((m) => (
            <span
              key={m}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                node.state === "loading"
                  ? "border-amber-400/30 bg-amber-400/5 text-amber-300"
                  : "border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
              }`}
              title={
                node.state === "loading"
                  ? "Model is being loaded into VRAM, not serveable yet"
                  : undefined
              }
            >
              {node.state === "loading" ? "loading: " : ""}
              {prettyModelName(m)}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-[var(--fg-muted)]">
          {isEntryNode ? "Routes inference to worker nodes" : "No models loaded"}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

/**
 * Compact, intentionally un-celebratory row for peers that are connected
 * but have never actually served anything in this session. We render
 * these in a separate "Peers having issues" section instead of giving
 * them a full participating-peer card — a stuck-loading peer is not a
 * "Connected node" in any user-meaningful sense, and showing it with the
 * same hardware-row + model-pill layout as a healthy serving peer reads
 * as misleading bragging.
 */
function IssueNodeRow({
  node,
  history,
}: {
  node: MeshNode & { _vanished?: boolean };
  history?: NodeHistory;
}) {
  const hostname = prettyHostname(node.hostname);
  const loadingFor =
    node.state === "loading" && history?.loadingSince
      ? Date.now() - history.loadingSince
      : 0;
  // We deliberately do NOT show "joined Xs ago" here. Our `firstSeen`
  // is when this *page session* first learned about the peer, not when
  // the peer actually joined the mesh — we'd be implying a fresh arrival
  // every time the user opened a new tab against a long-stuck peer.
  const reason = (() => {
    if (node._vanished) return "no longer responding";
    if (node.state === "loading") {
      if (loadingFor > 60_000) return `stuck loading for ${formatDuration(loadingFor)}+`;
      if (loadingFor > 20_000) return `stuck loading ${formatDuration(loadingFor)}`;
      if (loadingFor > 0) return `loading ${formatDuration(loadingFor)}`;
      return "loading";
    }
    if (node.state === "unreachable") return "unreachable from entry node";
    if (node.state === "offline") return "offline";
    return node.state;
  })();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg)]/40 px-3 py-2 text-[12px]">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--fg-muted)]/60" />
        <span className="truncate font-medium text-[var(--fg)]/85">{hostname}</span>
        <span className="truncate text-[var(--fg-muted)]">· {reason}</span>
      </div>
    </div>
  );
}

function SummaryBar({
  status,
  workingPeerCount,
}: {
  status: MeshStatus;
  /**
   * Non-entry peers that are either currently useful or have been at some
   * point this session — i.e. NOT counted as "having issues". Used as
   * the "machines" headline number so the summary matches the cards
   * shown below: machines == cards in the "Connected nodes" section.
   */
  workingPeerCount: number;
}) {
  // "Sharing" = a non-entry node genuinely contributing capacity *right
  // now*. Excludes nodes stuck in `loading` (they self-report a model in
  // `serving_models` while still bringing it up — that's how the page
  // used to claim "1 node sharing GPU" while inference 503'd) and excludes
  // pure clients that aren't serving anything.
  const totalNodes = workingPeerCount;
  const sharingNodes = status.nodes.filter(
    (n) =>
      !n.hostname?.startsWith("ip-") &&
      n.state !== "loading" &&
      n.state !== "unreachable" &&
      n.state !== "offline" &&
      ((n.capability?.loadedModels?.length ?? 0) > 0 ||
        n.servingModels.length > 0 ||
        n.state === "serving" ||
        n.state === "standby"),
  ).length;
  const models = status.models;

  return (
    <div className="grid grid-cols-3 divide-x divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--bg-elev)]">
      <div className="flex flex-col items-center gap-0.5 px-4 py-4">
        <div className="text-2xl font-semibold tabular-nums text-[var(--fg)]">
          {totalNodes}
        </div>
        <div className="text-[11px] text-[var(--fg-muted)]">
          {totalNodes === 1 ? "machine" : "machines"}
        </div>
      </div>
      <div className="flex flex-col items-center gap-0.5 px-4 py-4">
        <div className="text-2xl font-semibold tabular-nums text-[var(--fg)]">
          {models.length}
        </div>
        <div className="text-[11px] text-[var(--fg-muted)]">
          {models.length === 1 ? "model available" : "models available"}
        </div>
      </div>
      <div className="flex flex-col items-center gap-0.5 px-4 py-4">
        <div className="text-2xl font-semibold tabular-nums text-emerald-400">
          {sharingNodes}
        </div>
        <div className="text-[11px] text-[var(--fg-muted)]">
          {sharingNodes === 1 ? "node sharing GPU" : "nodes sharing GPU"}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Track per-node history across polls. Used for honest UX signals only —
 * we explicitly do NOT smooth `state` (we used to, and it caused the page
 * to display "Ready · serving Qwen3" for nodes that had been stuck
 * `state="loading"` for minutes, while every chat request 503'd).
 *
 * Fields:
 *   - `firstSeen`: when this node id first appeared in our polls; used to
 *     render the "online for Xm" badge.
 *   - `lastSeen`: most recent poll the node id appeared in; used (in
 *     future) to grey out cards for nodes that have just dropped off.
 *   - `loadingSince`: when state first transitioned to "loading" without
 *     subsequently leaving it. Surfaced as "Loading 30s" on the card so
 *     the user can see whether a node is genuinely loading or stuck.
 *   - `everUseful`: true once we've observed this node in a state that
 *     could actually serve a request (state=serving, OR has loaded models
 *     and isn't loading). Used to demote peers that have *never* served
 *     anything in this session into a separate "having issues" section,
 *     instead of giving them a full participating-peer card. A node that
 *     joined 90 seconds ago and has been stuck loading the entire time
 *     is functionally broken; treating it the same as a healthy serving
 *     peer in the UI was the user-visible lie.
 */
type NodeHistory = {
  firstSeen: number;
  lastSeen: number;
  loadingSince: number | null;
  everUseful: boolean;
};

export default function StatusPage() {
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState(false);
  const historyRef = useRef<Map<string, NodeHistory>>(new Map());
  // Most recent snapshot we saw for each node id. Lets us keep rendering
  // a node for ~30s after it vanishes from the entry node's view, so a
  // flapping peer doesn't cause cards/counts to flicker in and out.
  const lastSnapshotByIdRef = useRef<Map<string, MeshNode>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as MeshStatus;
        if (cancelled) return;

        // Record per-node history for honest UX badges (online-for, stuck
        // loading detection, "have we ever seen this node actually work?")
        // and snapshot the current state so we can keep rendering
        // briefly-vanished peers across polling gaps.
        const now = Date.now();
        const history = historyRef.current;
        const lastSnapshot = lastSnapshotByIdRef.current;
        for (const node of data.nodes) {
          const prior = history.get(node.id) ?? {
            firstSeen: now,
            lastSeen: now,
            loadingSince: null,
            everUseful: false,
          };
          const loadingSince =
            node.state === "loading"
              ? (prior.loadingSince ?? now)
              : null;
          // "Useful" = could actually serve a request right now. Loading
          // peers don't qualify even if they advertise serving_models —
          // that field lists what they're trying to load, not what's
          // actually loaded.
          const isUsefulNow =
            node.state === "serving" ||
            (node.state !== "loading" &&
              ((node.capability?.loadedModels?.length ?? 0) > 0 ||
                node.servingModels.length > 0));
          history.set(node.id, {
            firstSeen: prior.firstSeen,
            lastSeen: now,
            loadingSince,
            everUseful: prior.everUseful || isUsefulNow,
          });
          lastSnapshot.set(node.id, node);
        }

        // Drop snapshots for peers we haven't seen in over 60s. The
        // render-time grace window is 30s but we keep the snapshot
        // around a bit longer so a peer that briefly comes back inside
        // the window doesn't get a fresh history. After this we treat
        // them as truly gone.
        for (const [id, h] of history.entries()) {
          if (now - h.lastSeen > 60_000) {
            history.delete(id);
            lastSnapshot.delete(id);
          }
        }

        setStatus(data);
        setLastUpdated(new Date());
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) {
          // Poll faster (5s) so we catch the steady-state more often than
          // we catch transient "Loading" states during host re-elections.
          timer = window.setTimeout(tick, 5_000);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Categorize nodes for rendering. Two design goals:
  //
  //   1. The main "Connected nodes" list should only show machines that are
  //      actually useful — nothing that's just sitting in `loading`. Showing
  //      a never-served peer alongside a healthy one was the original lie.
  //
  //   2. Disappearance/reappearance of unstable peers must NOT cause
  //      visible flicker. We keep nodes in the "render set" for ~30s after
  //      we last saw them in a poll, so a peer that flaps in and out of
  //      the entry node's view every few seconds doesn't yank cards around.
  //
  // Categories:
  //   - "working": peer is currently useful, OR has been useful at some
  //     point in this session, OR is the entry node. Rendered as a card.
  //   - "unavailable": peer we know about but isn't currently useful and
  //     never has been (stuck loading, unreachable, offline, or recently
  //     vanished entirely). Rendered in a collapsed <details> at the
  //     bottom — present in the DOM for transparency, not in the user's
  //     face. Count is debounced via lastSeen so it doesn't flap.
  const now = Date.now();
  const VANISH_GRACE_MS = 30_000;
  const sortNodes = (a: MeshNode, b: MeshNode) => {
    const aEntry = a.hostname?.startsWith("ip-") ? 1 : 0;
    const bEntry = b.hostname?.startsWith("ip-") ? 1 : 0;
    if (aEntry !== bEntry) return aEntry - bEntry;
    const aServing = a.state === "serving" ? 0 : 1;
    const bServing = b.state === "serving" ? 0 : 1;
    return aServing - bServing;
  };

  // Build a render set that includes (a) every node in the current
  // snapshot, plus (b) any node we saw recently but is missing from THIS
  // snapshot. The (b) part is what makes flapping peers stop flickering:
  // if a peer disappears for one poll, we still render its last-known
  // state for up to 30s before actually dropping it. (Mutation of the
  // ref happens in the polling callback, not during render.)
  type RenderNode = MeshNode & { _vanished: boolean };
  const currentNodes = status?.nodes ?? [];
  const currentIds = new Set(currentNodes.map((n) => n.id));
  const lastSnapshotRef = lastSnapshotByIdRef.current;

  const renderNodes: RenderNode[] = [];
  for (const n of currentNodes) {
    renderNodes.push({ ...n, _vanished: false });
  }
  for (const [id, snap] of lastSnapshotRef.entries()) {
    if (currentIds.has(id)) continue;
    const h = historyRef.current.get(id);
    if (!h) continue;
    const goneFor = now - h.lastSeen;
    if (goneFor < VANISH_GRACE_MS) {
      renderNodes.push({ ...snap, _vanished: true });
    }
    // Past the grace window: ignore here. Cleanup of the ref happens
    // inside the poll callback when we re-process the next snapshot.
  }

  const isUnavailable = (n: RenderNode): boolean => {
    if (n.hostname?.startsWith("ip-")) return false;
    const h = historyRef.current.get(n.id);
    // A peer that has actually served in this session stays in the
    // "Available machines" list even during a transient vanish — the
    // 30s render grace handles that without yanking the card. We only
    // demote it once the grace expires and we drop it from renderNodes
    // entirely.
    if (h?.everUseful) return false;
    return (
      n._vanished ||
      n.state === "loading" ||
      n.state === "unreachable" ||
      n.state === "offline"
    );
  };
  const unavailableNodes = renderNodes.filter(isUnavailable).sort(sortNodes);
  const workingNodes = renderNodes
    .filter((n) => !isUnavailable(n))
    .sort(sortNodes);

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader status={<MeshLiveStatus variant="header" />} />

      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        {/* Page heading */}
        <div className="mb-8">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)] mb-2">
            Live mesh status
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            What&apos;s running right now
          </h1>
          <p className="mt-2 text-[14px] text-[var(--fg-muted)]">
            Machines connected to the ClosedMesh network and the models they&apos;re currently serving.
            {lastUpdated && (
              <span className="ml-1">
                Updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.
              </span>
            )}
          </p>
        </div>

        {/* Loading state */}
        {!status && !error && (
          <div className="space-y-4">
            <div className="h-24 animate-pulse rounded-xl bg-[var(--bg-elev)]" />
            <div className="h-28 animate-pulse rounded-xl bg-[var(--bg-elev)]" />
            <div className="h-28 animate-pulse rounded-xl bg-[var(--bg-elev)]" />
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
            <div className="text-sm font-medium text-red-400">Mesh unreachable</div>
            <div className="mt-1 text-[12px] text-[var(--fg-muted)]">
              Could not reach the entry node. Retrying automatically.
            </div>
          </div>
        )}

        {/* Content */}
        {status && (
          <div className="space-y-6">
            <SummaryBar
              status={status}
              workingPeerCount={
                workingNodes.filter(
                  (n) => !n.hostname?.startsWith("ip-"),
                ).length
              }
            />

            {/* Models list */}
            {status.models.length > 0 && (
              <div>
                <div className="mb-3 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
                  Available models
                </div>
                <div className="flex flex-wrap gap-2">
                  {status.models.map((m) => (
                    <span
                      key={m}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1 text-[12px] font-medium text-[var(--fg)]"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      {prettyModelName(m)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Working nodes — peers that are currently useful or have
                been useful at some point in this session, plus the entry
                node. The empty state is deliberately positive ("be the
                first to share") rather than alarmed; users on the public
                page don't need a technical explanation of which peer is
                stuck where. */}
            <div>
              <div className="mb-3 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
                Available machines
              </div>
              {workingNodes.some((n) => !n.hostname?.startsWith("ip-")) ? (
                <div className="space-y-3">
                  {workingNodes.map((node) => (
                    <NodeCard
                      key={node.id}
                      node={node}
                      history={historyRef.current.get(node.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-6 text-center">
                  <div className="text-sm font-medium text-[var(--fg)]">
                    No machines are sharing right now
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--fg-muted)]">
                    The mesh is up but no peer has finished loading a model.
                    {" "}
                    <a
                      href="/download"
                      className="text-[var(--accent)] hover:underline"
                    >
                      Be the first to share →
                    </a>
                  </div>
                </div>
              )}
            </div>

            {/* Unavailable machines — peers that the entry node knows
                about but that aren't currently serving (stuck loading,
                unreachable, recently vanished). Tucked into a collapsed
                <details> so the public page isn't dominated by broken
                peers, but still discoverable for users who want to know
                why their machine isn't appearing. The count is debounced
                via VANISH_GRACE_MS so a flapping peer doesn't make the
                disclosure label flicker. */}
            {unavailableNodes.length > 0 && (
              <details className="group rounded-xl border border-[var(--border)] bg-[var(--bg-elev)]/40 px-4 py-3 text-[12px]">
                <summary className="flex cursor-pointer items-center justify-between gap-2 text-[var(--fg-muted)] [&::-webkit-details-marker]:hidden">
                  <span>
                    {unavailableNodes.length} machine
                    {unavailableNodes.length === 1 ? "" : "s"} connected but
                    not currently serving
                  </span>
                  <span className="text-[var(--fg-muted)] transition-transform group-open:rotate-90">
                    ›
                  </span>
                </summary>
                <div className="mt-3 space-y-2">
                  {unavailableNodes.map((node) => (
                    <IssueNodeRow
                      key={node.id}
                      node={node}
                      history={historyRef.current.get(node.id)}
                    />
                  ))}
                </div>
              </details>
            )}

            {/* Footer note */}
            <p className="text-center text-[11px] text-[var(--fg-muted)]">
              Refreshes every 5 seconds &middot;{" "}
              <a href="/download" className="text-[var(--accent)] hover:underline">
                Add your machine to the mesh
              </a>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
