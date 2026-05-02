/**
 * Single source of truth for "what color and label do we show for this node?"
 *
 * Why centralize: the runtime exposes two layers of state, and they used to
 * leak into each UI surface differently, so the dashboard pill, the local
 * mesh table, and the public status page would each show a different label
 * for the *same* node at the *same* moment:
 *
 *   - `state` is **transient**: the runtime flips it to "serving" only while
 *     it is actually executing an inference request, and back to "standby"
 *     between requests. This makes it useless as a green/yellow signal —
 *     a node that's been ready and idle all day looks identical to one that
 *     hasn't loaded a model yet, except for sub-second flashes during
 *     requests that almost no observer ever catches.
 *   - `loadedModels` / `servingModels` are **stable**: they only change when
 *     a model is actually loaded or unloaded, which is the question users
 *     actually want answered ("is this node useful right now?").
 *
 * This helper picks color and label from the stable signals, not the
 * transient state. Every UI surface should call this so they can't drift
 * from each other again.
 */

import type { NodeSummary } from "./use-mesh-status";

export type NodeDisplayState = {
  /** Tailwind background class for the status dot. */
  dot: string;
  /** Tailwind border + bg + text triple for pill-style badges. */
  badge: string;
  /** Short label: "Serving" / "Ready" / "Loading" / "Idle" / "Offline". */
  label: string;
  /** Longer description for status text and tooltips. */
  description: string;
};

/**
 * Returns the display state for a node.
 *
 * Color rule: **if a node is reachable in the mesh, it is GREEN.** Period.
 * Running ClosedMesh = sharing GPU capacity = green. The runtime's
 * transient `state` ("serving" / "standby" / "loading") describes what
 * the node is doing at this exact millisecond, which is essentially never
 * a useful color signal — a working node spends 99%+ of its time in
 * "standby" between requests, not because anything is wrong but because
 * inference requests are rare and brief.
 *
 * The **label** distinguishes activity:
 *   - "Serving"  — actively processing an inference request now
 *   - "Ready"    — model loaded, waiting for requests
 *   - "Loading"  — model being loaded into VRAM (NOT serveable yet — amber)
 *   - "Sharing"  — connected and contributing capacity (no model loaded
 *                  locally yet, but the GPU is available to the mesh)
 *   - "Offline"  — not reachable
 *
 * Color rules:
 *   - "Loading" is **amber**, not green — a loading node cannot serve
 *     requests, and we used to render it the same as "Ready", which made
 *     stuck-loading nodes (model failing to fit, runtime bug) look healthy
 *     while every chat request 503'd.
 *   - "Offline" is grey.
 *   - Everything else is green.
 */
export function nodeDisplayState(
  node: NodeSummary | null,
  alive: boolean = true,
): NodeDisplayState {
  if (!node || !alive) {
    return {
      dot: "bg-zinc-500",
      badge: "border-zinc-400/40 bg-zinc-400/10 text-zinc-300",
      label: "Offline",
      description: "Not reachable in the mesh.",
    };
  }

  const greenBadge =
    "border-emerald-400/40 bg-emerald-400/10 text-emerald-300";
  const hasModel =
    (node.capability?.loadedModels?.length ?? 0) > 0 ||
    node.servingModels.length > 0;

  if (node.state === "loading") {
    return {
      dot: "bg-amber-400",
      badge: "border-amber-400/40 bg-amber-400/10 text-amber-300",
      label: "Loading",
      description:
        "Loading model into memory — not serving requests yet. If this persists more than a minute the model is probably failing to fit; check the runtime logs.",
    };
  }

  if (node.state === "serving") {
    return {
      dot: "bg-emerald-400",
      badge: greenBadge,
      label: "Serving",
      description: hasModel
        ? `Processing a request now — ${primaryModel(node)} loaded.`
        : "Processing a request now.",
    };
  }

  if (hasModel) {
    return {
      dot: "bg-emerald-400",
      badge: greenBadge,
      label: "Ready",
      description: `${primaryModel(node)} loaded and waiting for requests.`,
    };
  }

  // Connected to the mesh, no model loaded locally — but the GPU is still
  // contributing capacity. Green, with a label that nudges toward loading
  // a model so the node can host one too.
  return {
    dot: "bg-emerald-400",
    badge: greenBadge,
    label: "Sharing",
    description:
      "Connected and contributing GPU capacity. Load a model to host one locally.",
  };
}

function primaryModel(node: NodeSummary): string {
  return (
    node.servingModels[0] ||
    node.capability?.loadedModels?.[0] ||
    "model"
  );
}
