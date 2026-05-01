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
 * Returns the display state for a node based on stable signals.
 *
 * - **Green "Serving"**: node currently has an in-flight request (rare, the
 *   `state="serving"` flag is the only way to surface this).
 * - **Green "Ready"**: node is alive, in the mesh, and has at least one
 *   model loaded or assigned. This is what most "working" nodes look like.
 * - **Amber "Loading"**: model is being loaded into memory.
 * - **Yellow "Idle"**: node is alive but has no model loaded.
 * - **Grey "Offline"**: node not in the mesh / not reachable.
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

  const hasModel =
    (node.capability?.loadedModels?.length ?? 0) > 0 ||
    node.servingModels.length > 0;

  if (node.state === "loading") {
    return {
      dot: "bg-amber-400",
      badge: "border-amber-400/40 bg-amber-400/10 text-amber-300",
      label: "Loading",
      description: "Loading model into memory…",
    };
  }

  if (node.state === "serving") {
    return {
      dot: "bg-emerald-400",
      badge: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
      label: "Serving",
      description: hasModel
        ? `Processing a request now — ${primaryModel(node)} loaded.`
        : "Processing a request now.",
    };
  }

  if (hasModel) {
    return {
      dot: "bg-emerald-400",
      badge: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
      label: "Ready",
      description: `${primaryModel(node)} loaded and waiting for requests.`,
    };
  }

  return {
    dot: "bg-yellow-400",
    badge: "border-yellow-400/40 bg-yellow-400/10 text-yellow-300",
    label: "Idle",
    description:
      "Connected to the mesh but no model is loaded. " +
      "Load a model to start contributing inference capacity.",
  };
}

function primaryModel(node: NodeSummary): string {
  return (
    node.servingModels[0] ||
    node.capability?.loadedModels?.[0] ||
    "model"
  );
}
