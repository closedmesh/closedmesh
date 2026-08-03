import { modelIdsMatch } from "./model-id";

/**
 * Curated catalog of models we know the Senda runtime can pull.
 *
 * Hand-maintained for now — once the runtime exposes a /v1/models/catalog
 * endpoint we can swap this out for a fetch. Keeping it client-side keeps
 * the Models page snappy even with no runtime online.
 *
 * ─── A note on memory accounting ──────────────────────────────────────
 *
 * `minVramGb` is *usable GPU-allocatable memory*, not system RAM. It's
 * compared directly against the runtime's reported `vramGb`, which the
 * controller already pre-adjusts per backend:
 *
 *   • CUDA / ROCm: `vramGb` = the card's nameplate VRAM (e.g. an RTX
 *     3090 reports ~24 GB and you really do get 24 GB).
 *   • Metal (Apple Silicon): `vramGb` = the IOGPU wired-memory budget,
 *     which macOS caps at roughly 75 % of unified memory by default
 *     (`iogpu.wired_limit_mb`). So a 32 GB Mac reports ~24 GB, a 48 GB
 *     Mac reports ~36 GB, a 64 GB Mac reports ~48 GB, etc.
 *
 * That mapping is why human-readable descriptions below distinguish
 * "24 GB GPU" (CUDA card) from a "32 GB Mac" (system spec, ~24 GB
 * usable to Metal). Conflating the two is the most common way to
 * mislead a user about whether a model will actually fit, so when in
 * doubt, quote the *system-RAM* number for Macs (it's what users see
 * in About This Mac) and the *VRAM* number for discrete GPUs.
 */

export type CatalogModel = {
  id: string;
  name: string;
  family: "qwen" | "llama" | "mistral" | "phi" | "gemma" | "deepseek" | "glm";
  sizeGb: number;
  /**
   * Usable GPU-allocatable memory the runtime needs to serve this
   * model. Compared directly against the runtime's reported `vramGb`
   * (already Metal-budget-adjusted on Apple Silicon — see file header).
   * For Mac users, multiply by ~1.33 to get the system-RAM equivalent
   * (e.g. minVramGb 24 ≈ a 32 GB+ Mac, minVramGb 48 ≈ a 64 GB+ Mac).
   */
  minVramGb: number;
  description: string;
  recommended?: boolean;
  cpuOk?: boolean;
  /**
   * Accepts image input (multimodal vision). The runtime launches these
   * with an `--mmproj` projector; the chat UI lets you attach an image
   * only when a vision model is selected.
   */
  vision?: boolean;
};

export const MODEL_CATALOG: CatalogModel[] = [
  // ── Light / daily-driver ─────────────────────────────────────────────
  // Solo-servable on a single contributor at chat-viable latency. Qwen3-8B
  // is the reference default (see DEFAULT_DAILY_DRIVER_MODEL in model-tiers).
  {
    id: "Qwen3-0.6B-Q4_K_M",
    name: "Qwen 3 · 0.6B",
    family: "qwen",
    sizeGb: 0.4,
    minVramGb: 1,
    description:
      "Tiny smoke-test model. Boots in seconds; useful for verifying the mesh end-to-end before pulling something heavier.",
    cpuOk: true,
  },
  {
    id: "Llama-3.2-3B-Instruct-Q4_K_M",
    name: "Llama 3.2 · 3B Instruct",
    family: "llama",
    sizeGb: 2,
    minVramGb: 3,
    description:
      "Meta's smallest instruct. The natural step up from the Qwen smoke test — runs on CPU-only laptops but handles real chat.",
    cpuOk: true,
  },
  {
    id: "Qwen3-8B-Q4_K_M",
    name: "Qwen 3 · 8B",
    family: "qwen",
    sizeGb: 5,
    minVramGb: 8,
    description:
      "Senda's default. Best all-round open model at this size — strong reasoning, code and multilingual, with a thinking mode. Runs comfortably on a 16 GB Mac or an 8 GB GPU. If you only pull one model, pull this.",
    recommended: true,
  },
  {
    id: "Gemma-3-12B-it-Q4_K_M",
    name: "Gemma 3 · 12B",
    family: "gemma",
    sizeGb: 7.3,
    minVramGb: 10,
    description:
      "Google Gemma 3 12B — punches above its size on reasoning and writing, with a 128K context window, and it can see images. The natural step up from the 8B when you have a 12 GB GPU or a 16 GB+ Mac to spare.",
    vision: true,
  },
  {
    id: "Qwen3.5-9B-Vision-Q4_K_M",
    name: "Qwen 3.5 · 9B Vision",
    family: "qwen",
    sizeGb: 5.8,
    minVramGb: 8,
    description:
      "Vision and text in one compact 9B model — reads screenshots, photos and documents while holding its own on everyday chat. The lightest way to get image understanding on the mesh: fits an 8 GB GPU or a 16 GB Mac, well under the Gemma vision models.",
    vision: true,
  },
  // ── Fast expert-sharded MoE ──────────────────────────────────────────
  // ~30B total but only ~3B active per token, so they decode fast (native
  // 60–200+ tok/s) and Senda splits them by expert with zero per-token
  // cross-node traffic — the sweet spot for pooling across two contributors.
  {
    id: "Qwen3-30B-A3B-Q4_K_M",
    name: "Qwen 3 · 30B A3B (MoE)",
    family: "qwen",
    sizeGb: 17.3,
    minVramGb: 20,
    description:
      "Mixture-of-experts: 30B total, only ~3B active per token, so it delivers near-30B quality at close to 8B speed. 128 experts, top-8. Senda splits by expert with zero per-token cross-node traffic — pools cleanly across two contributors (each needs the ~6 GB shared trunk + its expert shard).",
  },
  {
    id: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M",
    name: "Qwen 3 Coder · 30B A3B (MoE)",
    family: "qwen",
    sizeGb: 18.6,
    minVramGb: 22,
    description:
      "The strongest local coding model that runs at real speed today — expert-sharded MoE post-trained for agentic coding and tool use, with a 256K context window. Point an editor or agent at Senda's OpenAI-compatible endpoint and use this as the backend.",
  },
  {
    id: "GLM-4.7-Flash-Q4_K_M",
    name: "GLM 4.7 · Flash (MoE)",
    family: "glm",
    sizeGb: 18,
    minVramGb: 20,
    description:
      "Mixture-of-experts: 30B total, ~3B active per token, 64 experts top-4. The smallest min-experts-per-node of any MoE here, so it pools across asymmetric nodes — an 18 GB Mac + an 8 GB laptop GPU is enough. Fast inference, strong tool calling.",
  },
  // ── Capacity ─────────────────────────────────────────────────────────
  // Big dense models: real quality, but slow through the mesh today (a
  // proof-of-capacity demo, not the chat default). Fit a beefy single peer
  // or pool across contributors.
  {
    id: "Gemma-3-27B-it-Q4_K_M",
    name: "Gemma 3 · 27B",
    family: "gemma",
    sizeGb: 17,
    minVramGb: 20,
    description:
      "Google Gemma 3 27B — strong dense all-round reasoning, and it can see images. Fits on a 24 GB GPU or a 28 GB+ Mac, or pools across two mid-range contributors (e.g. an 18 GB Mac + an 8 GB GPU at the bare minimum).",
    vision: true,
  },
  {
    id: "Qwen3.6-27B-Q4_K_M",
    name: "Qwen 3.6 · 27B Vision",
    family: "qwen",
    sizeGb: 15.7,
    minVramGb: 20,
    description:
      "Qwen 3.6 dense 27B — vision and text, with a coding-focused upgrade over 3.5. Fits a 24 GB GPU or a 28 GB+ Mac, or pools across two mid-range contributors.",
    vision: true,
  },
  {
    id: "Qwen3-32B-Q4_K_M",
    name: "Qwen 3 · 32B",
    family: "qwen",
    sizeGb: 20,
    minVramGb: 24,
    description:
      "Largest dense Qwen 3 — the dense quality ceiling in this size class. Fits a 24 GB GPU or a 36 GB+ Mac (a 32 GB Mac is right at the Metal-budget line and may not load at long context). Also pools across two mid-range contributors.",
  },
  {
    id: "Qwen3.6-35B-A3B-Q4_K_M",
    name: "Qwen 3.6 · 35B A3B (MoE) Vision",
    family: "qwen",
    sizeGb: 20.6,
    minVramGb: 24,
    description:
      "Qwen 3.6 mixture-of-experts: 35B total, ~3B active per token, vision and text. 256 experts, top-8. Near-30B quality at MoE speed — fits a 24 GB GPU or a 36 GB+ Mac, or expert-shards across two contributors.",
    vision: true,
  },
  {
    id: "Qwen3-235B-A22B-Q4_K_M",
    name: "Qwen 3 · 235B (A22B MoE)",
    family: "qwen",
    sizeGb: 142,
    minVramGb: 144,
    description:
      "Frontier-class mixture-of-experts: 235B params, ~22B active per token. Won't fit on any single laptop — this is the model that demonstrates what the mesh is for.",
  },
  {
    id: "Qwen3.5-122B-A10B-Q4_K_M",
    name: "Qwen 3.5 · 122B A10B (MoE) Vision",
    family: "qwen",
    sizeGb: 71,
    minVramGb: 80,
    description:
      "Large Qwen 3.5 MoE: 122B total, ~10B active, vision and text. 256 experts, top-8. Needs a workstation-class peer (~80 GB usable) or a multi-node mesh pool.",
    vision: true,
  },
  {
    id: "Qwen3.5-397B-A17B-Q4_K_M",
    name: "Qwen 3.5 · 397B A17B (MoE) Vision",
    family: "qwen",
    sizeGb: 227,
    minVramGb: 240,
    description:
      "Largest open Qwen 3.5 MoE: 397B total, ~17B active, vision and text. 512 experts, top-10. Mesh-scale only — multi-node expert sharding across high-VRAM contributors.",
    vision: true,
  },
];

/**
 * Bundled fallback: catalog ids flagged `vision` in {@link MODEL_CATALOG}.
 * Prefer {@link isVisionModel} with a live catalog from `/api/catalog` /
 * `useCatalog()` so a runtime-listed vision model works without a site deploy.
 */
export const VISION_MODEL_IDS: ReadonlySet<string> = new Set(
  MODEL_CATALOG.filter((m) => m.vision).map((m) => m.id),
);

/**
 * Whether `id` accepts image input. Pass the resolved catalog (from
 * `useCatalog` or `resolveCatalog`) so runtime-listed vision models are
 * recognized; omit it only for sync fallbacks that must use the bundle.
 *
 * Matching uses {@link modelIdsMatch} so Hugging Face stems
 * (`google_gemma-3-27b-it-Q4_K_M`) still hit catalog vision rows
 * (`Gemma-3-27B-it-Q4_K_M`).
 */
export function isVisionModel(
  id: string | null | undefined,
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
): boolean {
  if (!id) return false;
  return catalog.some((m) => m.vision === true && modelIdsMatch(m.id, id));
}
