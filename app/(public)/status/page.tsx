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
  node: MeshNode;
  history?: NodeHistory;
}) {
  const hostname = prettyHostname(node.hostname);
  const loadingFor =
    node.state === "loading" && history?.loadingSince
      ? Date.now() - history.loadingSince
      : 0;
  const onlineFor = history
    ? formatDuration(Date.now() - history.firstSeen)
    : null;
  const reason = (() => {
    if (node.state === "loading") {
      return loadingFor > 0
        ? `stuck loading ${formatDuration(loadingFor)}`
        : "loading";
    }
    if (node.state === "unreachable") return "unreachable from entry node";
    if (node.state === "offline") return "offline";
    return node.state;
  })();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-400/15 bg-amber-400/[0.03] px-4 py-2.5 text-[12px]">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-400/70" />
        <span className="truncate font-medium text-[var(--fg)]">{hostname}</span>
        <span className="truncate text-amber-400/90">· {reason}</span>
        {onlineFor && (
          <span className="truncate text-[var(--fg-muted)]">
            · joined {onlineFor} ago
          </span>
        )}
      </div>
      <span className="flex-shrink-0 text-[var(--fg-muted)]">
        hasn&apos;t served any requests
      </span>
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
        // loading detection, "have we ever seen this node actually work?").
        // We deliberately do NOT smooth state — see NodeHistory comment.
        const now = Date.now();
        const history = historyRef.current;
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

  // Categorize nodes:
  //   - "issues": peers (not the entry node) that have NEVER been observed
  //     in a useful state since this page opened, AND are currently in a
  //     non-useful state for long enough that it can't just be "we caught
  //     them mid-startup". A 90s-old peer that has been `state="loading"`
  //     the entire time is functionally broken and shouldn't get a full
  //     participating-peer card alongside actually-serving nodes.
  //   - "working": everything else. Includes peers that are currently in
  //     a transient bad state but have been useful before in this session
  //     (so we don't yank them around as they re-elect).
  //
  // Both lists are then sorted with entry-node last, serving first.
  const now = Date.now();
  const sortNodes = (a: MeshNode, b: MeshNode) => {
    const aEntry = a.hostname?.startsWith("ip-") ? 1 : 0;
    const bEntry = b.hostname?.startsWith("ip-") ? 1 : 0;
    if (aEntry !== bEntry) return aEntry - bEntry;
    const aServing = a.state === "serving" ? 0 : 1;
    const bServing = b.state === "serving" ? 0 : 1;
    return aServing - bServing;
  };
  const isIssueNode = (n: MeshNode): boolean => {
    if (n.hostname?.startsWith("ip-")) return false;
    const h = historyRef.current.get(n.id);
    if (!h) return false;
    if (h.everUseful) return false;
    const observedFor = now - h.firstSeen;
    const isBadState =
      n.state === "loading" ||
      n.state === "unreachable" ||
      n.state === "offline";
    // Give brand-new peers 15s before classifying as an issue — joining
    // the mesh involves a real loading step and we don't want every fresh
    // peer to flash through the issues list on its way to ready.
    return isBadState && observedFor > 15_000;
  };
  const allNodes = status?.nodes ?? [];
  const issueNodes = allNodes.filter(isIssueNode).sort(sortNodes);
  const workingNodes = allNodes
    .filter((n) => !isIssueNode(n))
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

            {/* Degraded banner: peers exist but nothing is actually
                serveable. The wording deliberately uses "have not served
                any requests" rather than "still loading" — the status
                page used to imply that loading peers were progressing
                toward serving when in fact some were stuck indefinitely. */}
            {(() => {
              const peerNodes = status.nodes.filter(
                (n) => !n.hostname?.startsWith("ip-"),
              );
              const noServeable =
                peerNodes.length > 0 && status.models.length === 0;
              if (!noServeable) return null;
              const issuesCount = issueNodes.length;
              return (
                <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-[13px] text-amber-200">
                  <div className="font-medium text-amber-300">
                    No model is serveable right now
                  </div>
                  <div className="mt-1 text-amber-200/80">
                    {issuesCount > 0
                      ? `${issuesCount} peer${issuesCount === 1 ? " is" : "s are"} connected but ${issuesCount === 1 ? "has" : "have"} never finished loading a model. Chat requests will fail until a peer joins with a loaded model and is elected as Host.`
                      : "No peer is currently elected as Host for any model. Chat requests will fail until a peer joins with a loaded model."}
                  </div>
                </div>
              );
            })()}

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

            {/* Working nodes — entry node + peers that are useful or
                have at least been useful at some point in this session. */}
            <div>
              <div className="mb-3 text-[11px] uppercase tracking-widest text-[var(--fg-muted)]">
                Connected nodes
              </div>
              {workingNodes.length > 0 ? (
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
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-5 text-center text-[12px] text-[var(--fg-muted)]">
                  No working peers right now.
                </div>
              )}
            </div>

            {/* Peers having issues — connected but have never actually
                served anything in this session. Rendered as a separate,
                deliberately un-celebratory section so the user can see
                them without the page pretending they're contributing. */}
            {issueNodes.length > 0 && (
              <div>
                <div className="mb-3 text-[11px] uppercase tracking-widest text-amber-400/80">
                  Peers having issues ({issueNodes.length})
                </div>
                <div className="space-y-2">
                  {issueNodes.map((node) => (
                    <IssueNodeRow
                      key={node.id}
                      node={node}
                      history={historyRef.current.get(node.id)}
                    />
                  ))}
                </div>
              </div>
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
