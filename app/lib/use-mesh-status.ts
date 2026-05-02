"use client";

import { useEffect, useState } from "react";
import { apiUrl, isPublicDeployment } from "./runtime-target";

export type NodeCapabilitySummary = {
  backend: string;
  vendor: string;
  computeClass: string;
  vramGb: number;
  loadedModels: string[];
};

export type NodeSummary = {
  id: string;
  hostname: string | null;
  isSelf: boolean;
  role: string;
  state: string;
  vramGb: number;
  servingModels: string[];
  capability: NodeCapabilitySummary;
  /**
   * Runtime version this peer is reporting (e.g. "0.65.7"). Surfaced on
   * status surfaces so we can immediately tell whether a misbehaving
   * peer just needs to update vs is hitting an actual runtime bug. Null
   * if the peer hasn't reported one (older runtimes, or local-node synth
   * paths without the field).
   */
  version: string | null;
};

export type MeshStatus = {
  online: boolean;
  nodeCount: number;
  models: string[];
  /** Per-node capability surface. Empty when admin port is unreachable. */
  nodes: NodeSummary[];
  // True before the first probe completes — lets the UI avoid flashing the
  // "no local mesh" state on initial render of the public site.
  loading: boolean;
};

const POLL_MS = 8000;

export function useMeshStatus(): MeshStatus {
  const [status, setStatus] = useState<MeshStatus>({
    online: false,
    nodeCount: 0,
    models: [],
    nodes: [],
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    const url = apiUrl("/api/status");
    const tick = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as Omit<MeshStatus, "loading">;
        if (!cancelled)
          setStatus({
            online: data.online,
            nodeCount: data.nodeCount,
            models: data.models,
            nodes: data.nodes ?? [],
            loading: false,
          });
      } catch {
        if (!cancelled)
          setStatus({
            online: false,
            nodeCount: 0,
            models: [],
            nodes: [],
            loading: false,
          });
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return status;
}

export { isPublicDeployment };
