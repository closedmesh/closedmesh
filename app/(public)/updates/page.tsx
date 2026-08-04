import type { Metadata } from "next";
import Link from "next/link";
import { PublicHeader } from "../../components/PublicHeader";
import { PublicFooter } from "../../components/PublicFooter";

export const metadata: Metadata = {
  title: "Senda updates",
  description:
    "What we shipped, when, and what the live mesh measured after. A development log for Senda — phases only, past tense only, real numbers from real peers.",
};

/**
 * Public development log at /updates.
 *
 * Hand-written, append-only. Phase-level entries only — never a per-release
 * changelog, never a roadmap. Anything not shipped doesn't appear here. The
 * private `internal/STRATEGY.md` and `internal/RESILIENCE.md` carry the
 * roadmap and the candid post-mortems; this page is the public re-narration
 * of the same material.
 *
 * Intentionally unlinked from `PublicHeader`. Shareable URL only — promote
 * to nav/footer once the entry count and refresh cadence justify it.
 *
 * Editing rules live in `.cursor/skills/dev-log/SKILL.md`. Read that before
 * adding, removing, or editing entries.
 */

type LogEntry = {
  /** URL-safe id; stable for anchor links once we link to specific entries. */
  id: string;
  /** ISO date the entry covers (ship date, not author date). */
  date: string;
  /** "Phase N" label used as the eyebrow above the title. */
  phase: string;
  /** Optional version arc this entry corresponds to ("v0.66.48", "v0.66.41 → v0.66.47"). */
  version?: string;
  /** Headline. Past-tense, factual. No "we're delighted to announce". */
  title: string;
  /** Single-paragraph summary lead, ≤2 sentences. */
  lede: string;
  /** Body paragraphs, in order. Plain prose; no marketing softening. */
  body: string[];
  /** Optional measurements rendered as a stat strip. Real numbers only. */
  metrics?: Array<{ label: string; value: string }>;
};

const ENTRIES: LogEntry[] = [
  {
    id: "phase-5-prepaid-api-peer-settlement",
    date: "2026-08-04",
    phase: "Phase 5",
    title:
      "Prepaid USDC API balance shipped, with Peer USD settlement on a custodial rail.",
    lede:
      "Customers can top up USDC, mint a ck_ key, and call senda.network/v1. Peers who serve those paid requests accrue Peer USD and can withdraw USDC once they clear the minimum. Free chat stays free; contributor credits stay non-cash.",
    body: [
      "The paid API preview is live on senda.network/buy: a Solana wallet tops up a prepaid API balance in USDC, mints a ck_ key, and spends it on the OpenAI-compatible /v1 endpoint. Homepage chat does not require a wallet. Deposits are attributed from mainnet USDC transfers into the published treasury; unused balance can be refunded subject to a minimum. During this preview, queued refunds and peer payouts may settle automatically under shared daily spend caps and kill switches — not as an SLA, and not as a promise that automation stays on.",
      "Contributor credits (tier-weighted tokens on /contribute) remain a measure of contribution, not cash. Separately, when a peer serves a paid /v1 request with served_by=mesh, a Peer USD liability accrues. Peers bind a Solana payout wallet in the desktop app, request withdraw at or above the published minimum on /earn, and can see payout history with Solscan links. Public aggregates — customer and peer liabilities, paid-out totals, recent peer payout txs — landed on /metrics. The end-to-end money loop (deposit → paid /v1 → Peer USD accrual → USDC withdraw) was proven on mainnet during early-access ops.",
      "Honest scope: settlement today is a custodial USDC rail (hot float + Redis balances), not a customer-facing on-chain escrow vault. Program work for a vault exists as localnet-only scaffolding and is not the path customers use. There is no crypto token, no guaranteed payout schedule, and early access still means rates, caps, and availability can change — see /terms.",
    ],
    metrics: [
      {
        label: "Customer path",
        value: "/buy → ck_ → senda.network/v1",
      },
      {
        label: "Peer withdraw minimum",
        value: "$10 USDC",
      },
      {
        label: "Public books",
        value: "/metrics settlement · /earn history",
      },
    ],
  },
  {
    id: "phase-3-peer-verification",
    date: "2026-05-30",
    phase: "Phase 3",
    version: "v0.66.57",
    title:
      "The mesh started verifying that peers serve the model they claim.",
    lede:
      "Each peer now publishes a deterministic model-identity fingerprint, and entry nodes re-run an unpredictable synthetic probe to check a peer is actually running the model it advertises — not a smaller one, and not canned text. It shipped in observe mode: verdicts are logged, routing is untouched for now.",
    body: [
      "The native-baseline column shipped in Phase 3.0 keeps peers honest about speed — it measures what each peer's own hardware can do, with no mesh layers in the path. It does not catch a peer that serves at the claimed speed while quietly running a smaller, cheaper model than it advertises, or returning pre-written text. On an open network where anyone can join, that gap matters: the runtime now captures a model-identity fingerprint from the same deterministic temperature=0 probe that produces the timing baseline — a hash of the greedy-decoded output plus a prefix of the decoded tokens. A different or smaller model produces a different greedy decode for the same fixed prompt and diverges within the first few tokens. The fingerprint is gossiped alongside the timing baseline.",
      "An entry node samples peer-model pairs and re-checks them. When the entry also serves the model itself, it generates a fresh, randomised probe on the fly, runs it against its own server for ground truth, and sends the identical probe to the peer under test — because the probe is unpredictable, a peer can't recognise \"the test\" and serve the real model only for it. The comparison is tolerant by design: it checks agreement on a bounded prefix of the output rather than demanding an exact byte-for-byte match, because even greedy decoding legitimately diverges in the tail across Metal, CUDA and Vulkan backends from floating-point differences. The prefix is the stable, model-identifying part.",
      "Two deliberate constraints. First, privacy: verification only ever replays synthetic probes the verifier generates — it never samples, replays, or duplicates a real user's prompt. Re-running a real request on a second machine would be a stronger check, but it would expose that prompt to a node that played no part in serving it, and that trade isn't worth making. Second, caution: the layer shipped in observe mode. The audit loop logs its verdicts and does not change routing. The one consequential action — temporarily removing a peer from rotation for a model after repeated, consecutive mismatches — exists as a reversible, time-boxed demotion that stays off until the verdict logs from real peers are clean. A false accusation against an honest contributor is the failure mode we most want to avoid, so the consequence ships last.",
    ],
  },
  {
    id: "phase-4-qwen3-8b-daily-driver",
    date: "2026-05-25",
    phase: "Phase 4",
    version: "v0.66.56",
    title:
      "Qwen3-8B-Q4_K_M cleared the daily-driver SLA on a single contributor; the status classifier stopped advertising phantom splits.",
    lede:
      "A single CUDA peer (RTX 4080 SUPER, 17.2 GB) serving Qwen3-8B-Q4_K_M as the daily-driver-tier default produced 45.26 tok/s decode and 82 ms TTFT_p50 — about 37× under the tier's TTFT ceiling and 5.7× over its tok/s floor. Same release closed a status-classifier defect that had been advertising N-peer split groups for models the elected host was serving solo.",
    body: [
      "Phase 4 set the daily-driver tier's SLA at ≤ 3 s TTFT and ≥ 8 tok/s. Today's measurement on a single peer hosting Qwen3-8B-Q4_K_M came in at 82 ms TTFT_p50 and 45.26 tok/s decode through the mesh, with the peer's own native baseline (a synthetic chat against its own llama-server on 127.0.0.1, bypassing every tunnel) at 49 ms TTFT and 77.80 tok/s. The mesh path costs about 33 ms of TTFT and roughly 42% of the decode throughput against that native baseline — overhead that's well inside the SLA on this model class. The peer was elected via the existing solo-bias election (Qwen3-8B's ~5 GB Q4 weights fit on any peer with ≥ 5.5 GB fast memory after the 1.1× headroom), and a first-serve milestone for the model is now visible on /metrics.",
      "Separately, the status classifier had been overstating the mesh's serving topology. When multiple peers all opted to share the same model and the elected host fit the model solo, the election left the other peers in NodeRole::Worker as warm standby — they were not actually running rpc-server for the host. The /api/status classifier still saw them in the cohort and rendered the host as serving_mode: split_host with an N-peer split_group covering the pooled VRAM of every standby peer, while tagging the standby peers themselves as pipeline_worker. The runtime had elected solo correctly; only the wire-level peer payload was lying about it.",
      "v0.66.56 added a model-size-aware honesty gate to both classifiers (classify_peer_split_role for remote peers, classify_local_split_role for self): if the elected host's fast memory is ≥ 1.1× the model's GGUF size — the same threshold the election uses for min_vram_for_solo — the classifier returns no split_role and no split_group for everyone in the cohort, same shape as a true solo serve. The host's NodeRole::Host and the model's catalog row keep advertising the model normally; only the phantom split-group payload goes away. When the gate has no evidence the host can solo (no peer has scanned the model on disk and the GGUF size is unknown in the mesh), the classifier falls through to its previous behaviour, so genuine pipeline splits like the 2026-05-25 DeepSeek-R1-Distill-70B-Q4_K_M cohort continue to render correctly. Two regression tests pin both branches.",
    ],
    metrics: [
      {
        label: "Qwen3-8B-Q4_K_M (single CUDA contributor, mesh path)",
        value: "82 ms TTFT · 45.26 tok/s",
      },
      {
        label: "Qwen3-8B-Q4_K_M (same peer, native baseline)",
        value: "49 ms TTFT · 77.80 tok/s",
      },
      {
        label: "Daily-driver SLA headroom (TTFT / tok/s)",
        value: "37× · 5.7×",
      },
      {
        label: "Status classifier honesty gate",
        value: "host-can-solo ⇒ no phantom split_group",
      },
    ],
  },
  {
    id: "phase-4-pipeline-coverage",
    date: "2026-05-25",
    phase: "Phase 4",
    version: "v0.66.55",
    title:
      "Pipeline-served models started contributing to the SLA gate that decides routing.",
    lede:
      "The routing primitive shipped on 2026-05-24 read per-model TTFT and tok/s samples on every chat request, but those samples were silently missing for any model the runtime served through a planner + strong-model pipeline. v0.66.55 closed the gap; the SLA gate now sees real measurements regardless of which serving mode produced them.",
    body: [
      "Phase 1 instrumented the runtime's backend proxy to record a per-model TTFT and tok/s sample on every successful local chat completion, and Phase 4 built the SLA gate that reads those samples to decide whether to route a request to the mesh. Between the two, a code path went unmeasured: when a host runs a model as a planner + strong-model pipeline (the path that splits a 32B–70B model's layers across a beefy host and one or more remote layer-workers), the response flowed through a separate proxy that streamed the strong-model's reply straight to the client without ever calling the sample-recording hook. Every pipeline-served chat looked fine to the user, then left the rolling-1h marketplace metric empty for that model — the same model that needed the metric most because the pipeline path is the only way some catalog rows ever get served.",
      "v0.66.55 (cut 2026-05-25) closed the gap. The pipeline proxy now measures the same TTFT and decode-duration instants the direct proxy uses, parses the OpenAI usage chunk out of the SSE tail (streaming) or the JSON body (non-streaming) to get the completion-token count, and calls the same sample-recording hook on 2xx responses with non-zero token counts. The recording site emits a single info-level log line per request that names whether the sample was recorded and, when it wasn't, the precise reason (non_2xx_status, usage_chunk_missing, zero_completion_tokens, client_disconnected) — so the default ~/.senda/logs/stderr.log is self-diagnostic for the same defect class the next time it appears, without needing an environment variable to surface anything.",
      "The fix was proved end-to-end against a 3-peer pipeline of personal desktops serving DeepSeek-R1-Distill-70B-Q4_K_M. One chat through senda.network/chat produced a 24925 ms TTFT and 1.09 tok/s decode sample, the SLA gate read it on the next request (x-senda-sla-best-ttft-ms: 24925, x-senda-sla-best-tps: 1.09, x-senda-sla-status: ttft-too-high), and the hourly snapshot job wrote it to the same Redis bucket Phase 4 reads on /metrics. Before v0.66.55 those headers had stayed at no-measurements for every pipeline-served model regardless of how many chats hit it; the value transition from null to a real number is the entire verifiable surface of the fix.",
      "A separate event the same day: Qwen3-32B-Q4_K_M was elected onto a 3-peer cohort of one Mac Mini-class Metal device (14.5 GB) and two CUDA peers (17.2 GB, 8.6 GB), pooled 40.3 GB. The largest single peer in the cohort happened to fit the model's weights with mmap-spill (the runtime lets the OS page non-resident weights from disk-resident RAM) and elected to serve it solo while the other two finished loading. Single-peer mmap-spill on the 17.2 GB CUDA device produced a 1047 ms TTFT_best and 3.981 tok/s p50 — the best capacity-tier figures the mesh has measured on personal hardware (the 2026-05-23 DeepSeek-70B reading on rented GPUs was ~10 s and ~1 tok/s). The first-serve milestone for that model is now visible on /metrics.",
    ],
    metrics: [
      {
        label: "DeepSeek-R1-Distill-70B-Q4_K_M (3-peer pipeline)",
        value: "24925 ms TTFT · 1.09 tok/s",
      },
      {
        label: "Qwen3-32B-Q4_K_M (single CUDA peer, mmap spill)",
        value: "1047 ms TTFT · 3.98 tok/s",
      },
      {
        label: "Pooled VRAM (3 contributors)",
        value: "40.3 GB",
      },
      {
        label: "Catalog rows with a measurement (pipeline path)",
        value: "0 → 1 with v0.66.55",
      },
    ],
  },
  {
    id: "phase-4-routable-network",
    date: "2026-05-24",
    phase: "Phase 4",
    title:
      "Routable network with model tiers, an SLA gate, and an external-provider supply path.",
    lede:
      "Senda is now a network that routes to the mesh when a per-model latency SLA can be met, and falls through transparently to a configured external provider when it can't. mesh_share_pct — the fraction of chat traffic served by community hardware — became the headline KPI on /metrics.",
    body: [
      "The catalog on senda.network/status now sorts every model into one of three tiers. Daily-driver covers models a single contributor can serve at chat-viable latency (8B–14B class: Qwen3-8B, Llama-3.1-8B-Instruct, Qwen2.5-Coder-7B, DeepSeek-R1-Distill-Qwen-14B, Llama-3.2-3B). Capacity covers the 27B–70B-class models that only fit on beefy single peers or pooled splits — they remain routable on /v1/models, but render collapsed behind a \"show capacity tier\" toggle with explicit \"expected 10–15 s to first token, 1–2 tok/s decode through the mesh today\" copy on the card. Experimental is the safe default for unmapped or newly-added entries. The chat default on senda.network is now always a daily-driver-tier model when one is being served; the mesh hosting both Qwen3-8B and DeepSeek-70B no longer defaults a first-time visitor to a 70B chat. Both the website's model picker and the /api/chat server-side default resolve through the same tier-aware function so the two surfaces agree.",
      "Every /api/chat request now passes through an SLA gate before routing. The gate reads the per-model TTFT_p50 and tok/s_p50 figures the mesh already gossips (from Phase 1) against per-tier targets: daily-driver passes at ≤ 3 s TTFT and ≥ 8 tok/s; capacity passes at ≤ 15 s TTFT and ≥ 0.8 tok/s. The evaluation is emitted on every response as x-senda-sla-status (one of meets-sla, no-peer-with-model, no-measurements, ttft-too-high, tps-too-low, both-too-low), with x-senda-sla-tier, x-senda-sla-candidates, and the best measured TTFT/tok-s when available. The headers are stable across both mesh-served and fallback-served responses, so an SDK caller can reason about routing without server logs.",
      "When the gate misses on a daily-driver-tier model, /api/chat routes the request to a configured external provider (today: OpenRouter, OpenAI-compatible). The stream protocol is identical to the mesh path so the chat UI doesn't branch. Three policy knobs scope external-supply use on this free testbed: it is enabled for daily-driver-tier models only (capacity-tier requests stay on the mesh — the network is the demo for those models), only for models with an explicit mapping (today: Qwen3-8B, Llama-3.1-8B-Instruct, Qwen2.5-Coder-7B-Instruct, DeepSeek-R1-Distill-Qwen-14B, Llama-3.2-3B), and behind a per-IP per-hour budget (default 20/hour) so external-provider cost is bounded while we're not yet billing. Over-budget IPs route to the mesh path. The route activates only when the external provider's API key is set in the environment — without one, the gate still evaluates and emits its decision header (x-senda-fallback-status: fallback-disabled), and the request stays on the mesh path.",
      "mesh_share_pct landed as the new headline metric on /metrics. Every chat request fires a fire-and-forget counter in Redis bucketed by hour and served-by value (mesh or fallback); the dashboard reads rolling-24h and rolling-7d windows and renders two cards above the weekly KPI panel. Each card shows the percentage prominently and the raw mesh / fallback / total counts beneath. The first data point recorded on prod read 100% mesh (1 request, 0 fallback, 1 total) — fallback hadn't fired because the external provider key wasn't yet configured. The metric is the right shape: it starts wherever it is, it moves with what the network actually does, and it gives a single number to drive week-over-week. The capacity-tier 70B serves from the 2026-05-23 milestone capture sit in the milestones section above the metric, where they belong as proof-of-capacity rather than as a claim about chat speed.",
      "Update later the same day (2026-05-24): the entry above describes the routing primitive correctly, but earlier paragraphs implied the external-provider path is the product. It isn't — the product is a paid inference API with two supply sources. What shipped on 2026-05-24 is the routing primitive on the free /chat testbed: the SLA gate decides whether a request can be served by a mesh peer at chat-viable latency; the response carries served_by accounting; mesh_share_pct measures how often the mesh actually served. Mesh peers are the network's differentiated supply; external providers are cost-of-goods that guarantee uptime so the API is sellable. mesh_share_pct then stops being just a routing-health number and becomes the margin-mix lever: every percentage point of mesh share is a percentage point of revenue that flows to a peer instead of out to an external provider.",
      "Correction (2026-08-04): the 2026-05-24 note said the paid inference API hadn't shipped yet. A prepaid USDC API balance, Peer USD accrual, and custodial settlement preview later shipped — see the Phase 5 entry phase-5-prepaid-api-peer-settlement. The 2026-05-24 routing primitive description itself remains accurate.",
    ],
    metrics: [
      {
        label: "Catalog tiers",
        value: "daily-driver · capacity · experimental",
      },
      {
        label: "Daily-driver SLA",
        value: "TTFT ≤ 3 s · tok/s ≥ 8",
      },
      {
        label: "Capacity SLA",
        value: "TTFT ≤ 15 s · tok/s ≥ 0.8",
      },
      {
        label: "Fallback rate limit",
        value: "20 requests / IP / hour",
      },
      {
        label: "First mesh_share_pct sample",
        value: "100% (1 mesh, 0 fallback, rolling 24h)",
      },
    ],
  },
  {
    id: "phase-3-0-benchmark-honesty",
    date: "2026-05-20",
    phase: "Phase 3.0",
    version: "v0.66.49 → v0.66.52",
    title: "Native baseline alongside through-mesh, on every peer.",
    lede:
      "Every solo-serving peer now runs three synthetic chats back-to-back against its own llama-server with no mesh layers in the path, and gossips the median. The catalog shows the through-mesh number, the native number, and the ratio between them as a coloured \"mesh efficiency\" percentage — making the cost of the entry tunnel, auth gateway, and routing layer measurable on every row.",
    body: [
      "Phase 3.0 publishes a second throughput figure for every solo-serving peer: the rate that same peer's llama-server reaches when called directly, with no mesh layers between the prompt and the model. The catalog now carries both numbers for the same peer-model pair, plus the ratio between them, so the cost of routing a request through the mesh is measurable on its own terms instead of inferred from a single value.",
      "When a peer's llama-server reports Ready on the solo path, the runtime now spawns a background collector. After a 30-second settle delay it issues a single deterministic streaming completion (temperature=0, seed=42, max_tokens=128) directly to 127.0.0.1:llama_port — no entry tunnel, no auth gateway, no routing layer. The result is timed using the same TTFT and decode-rate logic that records through-mesh samples (including the same wall-clock fallback Phase 1 installed when decode windows collapse near zero), persisted at ~/.senda/native-baselines.json keyed by model file mtime, and gossiped via a new repeated field on the peer announcement. It refreshes every 12 hours or when the model file changes.",
      "On the catalog at senda.network/status, every model row now carries up to three throughput stats: the median through-mesh tok/s (from Phase 1), the median native tok/s (new), and a coloured \"mesh efficiency\" percentage — green at 80%+, amber 50–80%, red below 50%. The math is through ÷ native: 1.00 means the mesh path matches the peer's local stack, and the gap below 1.00 is the budget available for optimising the entry tunnel, auth gateway, and routing layer. Each percentage point reclaimed there will show up on the same catalog row that exposed it.",
      "Scope: the collector runs on the solo-launch path. Pipeline-host and MoE-shard peers reach their local llama-server through iroh tunnels to remote rpc-servers, so the same single-port measurement would already include network overhead and stop being a native baseline. A second collector that captures the rpc-tunnel cost separately is queued as a follow-up once the solo ratios surface a gap worth attributing in those modes. Peers running pre-v0.66.49 advertise an empty baselines field; the catalog renders those rows as \"no measurement yet,\" keeping the missing-data state visibly distinct from measured-and-slow.",
      "What the new column immediately surfaced was a runtime bug, not a routing one. v0.66.49 had been launching llama-server with a fitter argument (-fitt) set to 70% of the device's VRAM. The runtime treated that value as a ceiling on llama.cpp's GPU usage, but llama.cpp treats it as the amount of memory it must leave free on the device. On an 18 GB M3 Pro (Metal pool ~12 GiB) the runtime was therefore telling the fitter to keep ~9.7 GiB free — leaving ~2.6 GiB for the model, forcing 22 of 36 layers of an 8 B Q4_K_M model to CPU repack, and pinning native decode at 0.74 tok/s. v0.66.50 (a same-day hotfix) fixed an unrelated gossip-refresh path that was clearing the new metric on legacy peers. v0.66.51 replaced the fitter formula with a small absolute margin (1–2 GiB regardless of device size), and the same M3 Pro now reports 8.95 tok/s native and 2528 ms TTFT — a 12.1× decode and 2.9× TTFT improvement on a single config change, on hardware nothing else changed about.",
      "v0.66.52 then surfaced a second problem on top of the first: the published native number was being decided by single-shot variance. A controlled config sweep on the same M3 Pro ran the identical (model, args, prompt) three times back-to-back and returned 15.44 → 21.08 → 37.09 tok/s — a 2.4× spread on identical input, with the slowest sample tracking GPU command-queue and Metal-clock warmup rather than sustained capability. The 8.95 tok/s value the catalog had been publishing was an artefact of which 10-second window the collector happened to land in, not what the hardware could do. v0.66.52 raised the per-refresh sample count from 1 to 3, runs the samples back-to-back with a 1 s pause, and publishes the per-axis median; the on-disk cache and the gossiped `samples` field both record the actual N. The same M3 Pro now reports 21.07 tok/s native and 143 ms TTFT — a 2.4× decode and 18× TTFT correction on the published number, with no change to the underlying hardware or model.",
      "Correction (2026-06-12): the coloured \"mesh efficiency\" percentage described above was removed from the catalog, because the ratio measured the wrong thing. For a solo serve the through-mesh and native numbers come from the same llama-server on the same hardware, so the decode rate is identical by construction and the gap between them was sampling noise, not a routing cost. The network's actual cost is first-token latency — the tunnel and routing layer add to TTFT, not to the per-token decode rate — so a throughput ratio that read \"60% efficient\" implied a generation-speed penalty that does not exist. A TTFT-based overhead figure would have been just as misleading: the native baseline is a short synthetic prompt while through-mesh samples come from real, longer prompts, so most of that gap is prefill length rather than mesh overhead. The catalog now shows the raw numbers — through-mesh tok/s, native tok/s, and fastest first token — and lets them stand without a derived ratio. Pooled-split serves remain the one case where through-mesh throughput is genuinely lower, because the model is split across peers over WAN; the row's topology label says so.",
    ],
    metrics: [
      { label: "Runtime ship arc", value: "v0.66.49 → v0.66.52 (4 ships)" },
      { label: "Refresh cadence", value: "30s settle, then every 12 h or on model-file change" },
      { label: "Catalog columns added", value: "native t/s + mesh efficiency %" },
      { label: "Native decode after fitter fix (M3 Pro · Qwen3-8B-Q4_K_M)", value: "0.74 → 8.95 tok/s · TTFT 7.3 s → 2.5 s" },
      { label: "Native decode after multi-sample (same hardware)", value: "8.95 → 21.07 tok/s · TTFT 2528 ms → 143 ms" },
      { label: "Samples per refresh", value: "1 → 3 (median; partial-sample-tolerant)" },
    ],
  },
  {
    id: "phase-2-routing-defaults",
    date: "2026-05-20",
    phase: "Phase 2",
    version: "v0.66.48",
    title: "Solo replication wins by default.",
    lede:
      "When any peer can serve a model end-to-end, requests land there instead of a pipeline split. Pooled splits stay in the codebase as a power-user fallback, demoted from the headline.",
    body: [
      "Until v0.66.48, asking the mesh to host Qwen3-8B and Qwen3-32B from the same configured peer set produced a pipeline-split for both models — even on machines with enough memory to run the smaller model end-to-end. Splits add a per-token network hop on every decode step, so a model that fit on one peer was being served slower than necessary, simply because the runtime wasn't choosing.",
      "The runtime now picks per-peer. A 14.5 GB Mac requested for both models drops the 32B and serves only the 8B solo. The router prefers solo hosts over split hosts at the same priority class, and only falls through to the split path when no peer can hold the model end-to-end. An admin flag (SENDA_FORCE_SPLIT_ROUTING=1) preserves the split path for demos.",
      "On the live 4-peer cohort this means both modes run side-by-side for the first time: a single Apple Silicon laptop serves Qwen3-8B-Q4_K_M solo, while three other peers pool memory for Qwen3-32B-Q4_K_M. The catalog on senda.network/status renders the two as separate rows with a visible divider, with measured throughput on each.",
    ],
    metrics: [
      { label: "Qwen3-8B-Q4_K_M (solo)", value: "0.693 tok/s · 20.66 s TTFT" },
      { label: "Qwen3-32B-Q4_K_M (pooled split)", value: "0.131 tok/s · 91.15 s TTFT" },
      { label: "Peers measured", value: "4 (1 solo · 1 host · 2 workers)" },
    ],
  },
  {
    id: "phase-1-marketplace-metrics",
    date: "2026-05-19",
    phase: "Phase 1",
    version: "v0.66.41 → v0.66.47",
    title: "Real per-model throughput, surfaced on the catalog.",
    lede:
      "Every peer now records p50 tok/s and p50 time-to-first-token per model from real inference traffic, gossips them to the entry, and the catalog renders them next to each contributor.",
    body: [
      "Senda now answers the question \"how fast does this peer actually serve this model?\" with a number that came from real chat traffic, not a synthetic benchmark. The runtime instruments its own backend proxy on the way out, so any chat — through the website, the desktop app, or the OpenAI-compatible API — produces a sample. Samples roll up into a 1-hour p50 and gossip to the entry node within ~75 seconds.",
      "The honest part of this entry: the metric path took seven runtime releases to land. Four were follow-ups for defects only the live mesh could surface — a tunnel that bypassed the chokepoint where the metric was being collected, a log filter that swallowed the diagnostic events that would have caught it, a gossip-refresh path that didn't fire when the entry had already seen the peer, and a streaming-response code path that read tok/s from the wrong field and produced 953,000 tok/s readings until we noticed. Each of those is now a regression test.",
      "The validation that closed Phase 1 was a streaming chat through senda.network against a Qwen3-8B-Q4_K_M peer, producing a 0.482 tok/s sample that landed on the public dashboard via host → gossip → entry → frontend. The number proves the metric pipeline works end-to-end — it is not a performance claim. The same MBA running native llama-server on the same model goes substantially faster than that; the gap is mesh-overhead we haven't yet measured or attributed (entry tunnel? auth gateway? routing? metric-window edge cases?). Closing that gap is queued as the first deliverable of Phase 3 (\"benchmark honesty\"): every peer publishes its native baseline alongside its through-mesh measurement, the catalog shows the ratio, and we either tell a great story or we have a fixable problem we now know about.",
    ],
    metrics: [
      { label: "Runtime releases", value: "v0.66.41 → v0.66.47 (7 ships)" },
      { label: "Mid-flight defect classes fixed", value: "4 (all now regression-tested)" },
      { label: "First end-to-end sample", value: "Qwen3-8B-Q4_K_M @ 0.482 tok/s" },
    ],
  },
  {
    id: "phase-0-narrative",
    date: "2026-05-18",
    phase: "Phase 0",
    title: "Stopped describing Senda as VRAM pooling.",
    lede:
      "The public surface used to lead with \"pool VRAM into one virtual GPU.\" That framing is wrong on the architecture and wrong on the value — replaced this week with \"a swarm of peers, each running open-weight models on hardware they already own.\"",
    body: [
      "Pipeline-splitting two laptops to run a 70B model is something Senda can do, and for some demos still should do. But it isn't what the network is for. The network is for routing each session to whichever peer can serve the requested model end-to-end at full quality, paying a one-time cost to pick the right peer instead of a per-token network cost on every decode step. Apple Silicon's unified memory makes that achievable on hardware contributors already own — a $2.5–4.5k laptop is genuinely capable of serving 30B–70B parameter models at full quality.",
      "Phase 0 was the website, the about page, the homepage chat empty state, the README, and the architecture diagram, rewritten around that thesis. No engineering work — but the narrative had to ship before the engineering work that follows it (capability-aware routing in Phase 2, reputation in Phase 3) had a coherent story to slot into.",
      "The pipeline-split path stayed in the codebase. It now appears as a power-user fallback for models that don't fit any single peer, mentioned explicitly so existing contributors who installed for that feature don't feel rug-pulled. Same code, different hierarchy.",
    ],
  },
];

export default function LogPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />

      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <header className="mb-14 max-w-2xl">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
            Updates
          </div>
          <h1 className="mt-2 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
            What Senda shipped, and what the mesh measured after.
          </h1>
          <p className="mt-4 text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)]">
            One entry per shipped phase, in reverse chronological order. No
            roadmap, no per-release changelog. Live measurements live on{" "}
            <Link
              href="/status"
              className="text-[var(--accent)] hover:underline"
            >
              /status
            </Link>
            ; this page is the temporal complement — what the team built each
            week, with the numbers that came out the other side.
          </p>
          <p className="mt-4 text-pretty text-[14px] leading-relaxed text-[var(--fg-muted)]">
            <span className="font-medium text-[var(--fg)]">
              On the numbers below:
            </span>{" "}
            every figure comes from real chat traffic on the same data path
            users hit. As of Phase 3.0, each model row on{" "}
            <Link
              href="/status"
              className="text-[var(--accent)] hover:underline"
            >
              /status
            </Link>{" "}
            carries both a through-mesh measurement and the same peer's
            native <code>llama-server</code> baseline, with the ratio between
            them rendered as a mesh-efficiency percentage. The gap between
            those two numbers is the optimisation budget for the layers
            between the prompt and the model.
          </p>
        </header>

        <ol className="flex flex-col gap-14">
          {ENTRIES.map((entry) => (
            <li
              key={entry.id}
              id={entry.id}
              className="scroll-mt-24 border-t border-[var(--border)] pt-10 first:border-t-0 first:pt-0"
            >
              <Entry entry={entry} />
            </li>
          ))}
        </ol>
      </main>

      <PublicFooter />
    </div>
  );
}

function Entry({ entry }: { entry: LogEntry }) {
  const dateLabel = new Date(entry.date + "T00:00:00Z").toLocaleDateString(
    "en-US",
    { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" },
  );
  return (
    <article>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.16em] text-[var(--fg-muted)]">
        <span className="text-[var(--accent)]">{entry.phase}</span>
        <span aria-hidden>·</span>
        <time dateTime={entry.date}>{dateLabel}</time>
        {entry.version && (
          <>
            <span aria-hidden>·</span>
            <span className="font-mono normal-case tracking-normal">
              {entry.version}
            </span>
          </>
        )}
      </div>

      <h2 className="mt-3 text-balance text-2xl font-semibold leading-snug tracking-tight sm:text-[1.7rem]">
        {entry.title}
      </h2>

      <p className="mt-4 text-pretty text-[15px] leading-relaxed text-[var(--fg)]/90">
        {entry.lede}
      </p>

      <div className="mt-5 flex flex-col gap-4 text-[14.5px] leading-relaxed text-[var(--fg-muted)]">
        {entry.body.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      {entry.metrics && entry.metrics.length > 0 && (
        <dl className="mt-6 grid gap-px overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3">
          {entry.metrics.map((m) => (
            <div
              key={m.label}
              className="flex flex-col gap-1 bg-[var(--bg-elev)] px-4 py-3"
            >
              <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--fg-muted)]">
                {m.label}
              </dt>
              <dd className="font-mono text-[12.5px] text-[var(--fg)]">
                {m.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
