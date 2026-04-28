import { NextResponse } from "next/server";
import { applyCors, preflightResponse } from "../_cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUNTIME_URL =
  process.env.CLOSEDMESH_RUNTIME_URL ??
  process.env.MESH_LLM_URL ??
  "http://127.0.0.1:9337/v1";

const ADMIN_URL =
  process.env.CLOSEDMESH_ADMIN_URL ??
  process.env.MESH_CONSOLE_URL ??
  "http://127.0.0.1:3131";

/** Per-node capability summary surfaced in the chat UI. */
export type NodeCapabilitySummary = {
  /** "metal" | "cuda" | "rocm" | "vulkan" | "cpu" */
  backend: string;
  /** "apple" | "nvidia" | "amd" | "intel" | "none" */
  vendor: string;
  /** "lo" | "mid" | "hi" | "pro" */
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
};

type Status = {
  online: boolean;
  nodeCount: number;
  models: string[];
  /** Per-node capability surface — empty when the admin port is unreachable. */
  nodes: NodeSummary[];
};

type RuntimeCapability = {
  backend?: string;
  vendor?: string;
  compute_class?: string;
  vram_total_mb?: number;
  loaded_models?: string[];
};

type RuntimePeer = {
  id?: string;
  role?: string;
  state?: string;
  hostname?: string | null;
  vram_gb?: number;
  serving_models?: string[];
  hosted_models?: string[];
  capability?: RuntimeCapability;
};

type RuntimeStatus = {
  node_id?: string;
  is_host?: boolean;
  is_client?: boolean;
  node_state?: string;
  my_hostname?: string | null;
  my_vram_gb?: number;
  serving_models?: string[];
  hosted_models?: string[];
  capability?: RuntimeCapability;
  peers?: RuntimePeer[];
};

function summarizeCapability(cap: RuntimeCapability | undefined): NodeCapabilitySummary {
  return {
    backend: cap?.backend ?? "unknown",
    vendor: cap?.vendor ?? "none",
    computeClass: cap?.compute_class ?? "lo",
    vramGb: Math.round(((cap?.vram_total_mb ?? 0) / 1024) * 10) / 10,
    loadedModels: cap?.loaded_models ?? [],
  };
}

async function fetchModels(): Promise<string[]> {
  const res = await fetch(`${RUNTIME_URL}/models`, { cache: "no-store" });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map((m) => m.id);
}

/**
 * Pull the runtime's `/api/status` payload. Returns null when the admin port
 * is unreachable (e.g. headless installs that only expose :9337). The chat UI
 * gracefully degrades to a count-only status pill in that case.
 */
async function fetchRuntimeStatus(): Promise<RuntimeStatus | null> {
  try {
    const res = await fetch(`${ADMIN_URL}/api/status`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as RuntimeStatus;
  } catch {
    return null;
  }
}

function buildNodes(rt: RuntimeStatus): NodeSummary[] {
  const nodes: NodeSummary[] = [];
  // Local node first — it's always present even on a one-node mesh.
  nodes.push({
    id: rt.node_id ?? "local",
    hostname: rt.my_hostname ?? null,
    isSelf: true,
    role: rt.is_host ? "Host" : rt.is_client ? "Client" : "Standby",
    state: rt.node_state ?? "standby",
    vramGb: rt.my_vram_gb ?? 0,
    servingModels: [
      ...(rt.serving_models ?? []),
      ...(rt.hosted_models ?? []),
    ].filter((m, i, arr) => arr.indexOf(m) === i),
    capability: summarizeCapability(rt.capability),
  });
  for (const peer of rt.peers ?? []) {
    nodes.push({
      id: peer.id ?? "",
      hostname: peer.hostname ?? null,
      isSelf: false,
      role: peer.role ?? "Worker",
      state: peer.state ?? "standby",
      vramGb: peer.vram_gb ?? 0,
      servingModels: [
        ...(peer.serving_models ?? []),
        ...(peer.hosted_models ?? []),
      ].filter((m, i, arr) => arr.indexOf(m) === i),
      capability: summarizeCapability(peer.capability),
    });
  }
  return nodes;
}

export async function OPTIONS(req: Request) {
  return preflightResponse(req);
}

export async function GET(req: Request) {
  try {
    const [models, runtime] = await Promise.all([
      fetchModels(),
      fetchRuntimeStatus(),
    ]);
    const nodes = runtime ? buildNodes(runtime) : [];
    const nodeCount = nodes.length || 1;
    const status: Status = { online: true, nodeCount, models, nodes };
    return applyCors(req, NextResponse.json(status));
  } catch {
    const status: Status = {
      online: false,
      nodeCount: 0,
      models: [],
      nodes: [],
    };
    return applyCors(req, NextResponse.json(status, { status: 200 }));
  }
}
