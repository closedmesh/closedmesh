import { NextResponse } from "next/server";
import { applyCors, preflightResponse } from "../_cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// See the matching helper in app/api/chat/route.ts for the rationale —
// Vercel has shipped trailing-newline env values to us before, and a raw
// `${RUNTIME_URL}/models` then carries a literal newline mid-URL. Trim
// defensively at the read site.
function trimmedEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value) return value;
  }
  return undefined;
}

const RUNTIME_URL =
  trimmedEnv("CLOSEDMESH_RUNTIME_URL", "MESH_LLM_URL") ??
  "http://127.0.0.1:9337/v1";

const ADMIN_URL =
  trimmedEnv("CLOSEDMESH_ADMIN_URL", "MESH_CONSOLE_URL") ??
  "http://127.0.0.1:3131";

const RUNTIME_TOKEN = trimmedEnv("CLOSEDMESH_RUNTIME_TOKEN") ?? "";

const runtimeHeaders: Record<string, string> = RUNTIME_TOKEN
  ? { Authorization: `Bearer ${RUNTIME_TOKEN}` }
  : {};

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

type RuntimeGpu = {
  name?: string;
  vram_bytes?: number;
};

type RuntimeStatus = {
  node_id?: string;
  is_host?: boolean;
  is_client?: boolean;
  node_state?: string;
  my_hostname?: string | null;
  my_vram_gb?: number;
  my_is_soc?: boolean;
  serving_models?: string[];
  hosted_models?: string[];
  capability?: RuntimeCapability;
  /** rc2 and earlier emit GPU info here rather than inside `capability`. */
  gpus?: RuntimeGpu[];
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

/**
 * rc2 and earlier don't emit a top-level `capability` object for the local
 * node — that field is only populated on peer entries. Instead the runtime
 * exposes `gpus[]`, `my_vram_gb`, and `my_is_soc`. Synthesize a
 * RuntimeCapability from those fields so the rest of the pipeline sees
 * consistent data regardless of which runtime version is running locally.
 */
function inferLocalCapability(rt: RuntimeStatus): RuntimeCapability {
  if (rt.capability) return rt.capability;

  const gpuName = (rt.gpus?.[0]?.name ?? "").toLowerCase();
  const isSoc = rt.my_is_soc ?? false;

  let backend = "cpu";
  let vendor = "none";
  let computeClass = "lo";

  if (isSoc || gpuName.includes("apple") || gpuName.includes("m1") || gpuName.includes("m2") || gpuName.includes("m3") || gpuName.includes("m4")) {
    backend = "metal";
    vendor = "apple";
    computeClass = "hi";
  } else if (gpuName.includes("nvidia") || gpuName.includes("geforce") || gpuName.includes("rtx") || gpuName.includes("gtx") || gpuName.includes("tesla") || gpuName.includes("a100") || gpuName.includes("h100")) {
    backend = "cuda";
    vendor = "nvidia";
    computeClass = "hi";
  } else if (gpuName.includes("amd") || gpuName.includes("radeon") || gpuName.includes("rx ")) {
    backend = "rocm";
    vendor = "amd";
    computeClass = "mid";
  } else if (gpuName.includes("intel") || gpuName.includes("arc")) {
    backend = "vulkan";
    vendor = "intel";
    computeClass = "mid";
  }

  // my_vram_gb is already in GB — convert to MB for summarizeCapability.
  const vram_total_mb = Math.round((rt.my_vram_gb ?? 0) * 1024);

  // Treat serving + hosted models as "loaded" for the local node.
  const loaded_models = [
    ...(rt.serving_models ?? []),
    ...(rt.hosted_models ?? []),
  ].filter((m, i, a) => a.indexOf(m) === i);

  return { backend, vendor, compute_class: computeClass, vram_total_mb, loaded_models };
}

async function fetchModels(): Promise<string[]> {
  const res = await fetch(`${RUNTIME_URL}/models`, {
    cache: "no-store",
    headers: runtimeHeaders,
  });
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
    const res = await fetch(`${ADMIN_URL}/api/status`, {
      cache: "no-store",
      headers: runtimeHeaders,
    });
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
    capability: summarizeCapability(inferLocalCapability(rt)),
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
