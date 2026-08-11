import { describe, expect, test } from "vitest";
import {
  buildKpiSnapshot,
  mergeWeekSnapshots,
  meshRuntimeToKpiInput,
  pickFlagshipModel,
  snapshotFromMilestone,
  snapshotQuality,
  KNOWN_MILESTONES,
} from "./kpi-snapshot";

describe("buildKpiSnapshot", () => {
  test("aggregates flagship metrics across nodes", () => {
    const snap = buildKpiSnapshot(
      {
        online: true,
        nodeCount: 2,
        models: ["Qwen3-32B-Q4_K_M"],
        nodes: [
          {
            hostname: "mac-a",
            servingModels: ["Qwen3-32B-Q4_K_M"],
            vramGb: 36,
            capability: { backend: "metal", vramGb: 36, loadedModels: [] },
            measuredTpsP50ByModel: { "Qwen3-32B-Q4_K_M": 20 },
            measuredTtftMsP50ByModel: { "Qwen3-32B-Q4_K_M": 900 },
          },
          {
            hostname: "cuda-b",
            servingModels: ["Qwen3-32B-Q4_K_M"],
            vramGb: 24,
            capability: { backend: "cuda", vramGb: 24 },
            measuredTpsP50ByModel: { "Qwen3-32B-Q4_K_M": 16 },
            measuredTtftMsP50ByModel: { "Qwen3-32B-Q4_K_M": 1200 },
          },
        ],
      },
      "Qwen3-32B-Q4_K_M",
      "https://entry.senda.network/api/status",
      new Date("2026-05-19T12:00:00Z"),
      ["Qwen3-32B-Q4_K_M"],
    );

    expect(snap.flagship.contributors).toBe(2);
    expect(snap.flagship.tps_p50_median).toBe(18);
    expect(snap.flagship.ttft_ms_best).toBe(900);
    expect(snap.backends).toEqual(["cuda", "metal"]);
    expect(snap.pooled_vram_gb).toBe(60);
    expect(snap.routable_models).toEqual(["Qwen3-32B-Q4_K_M"]);
  });

  test("excludes entry nodes from contributor count", () => {
    const snap = buildKpiSnapshot(
      {
        online: true,
        nodeCount: 1,
        models: [],
        nodes: [
          {
            hostname: "ip-10-0-0-1",
            servingModels: ["Qwen3-32B-Q4_K_M"],
            capability: { backend: "cpu" },
          },
        ],
      },
      "Qwen3-32B-Q4_K_M",
      "https://entry.senda.network/api/status",
    );
    expect(snap.flagship.contributors).toBe(0);
  });
});

describe("meshRuntimeToKpiInput", () => {
  test("maps mesh peers including requested models for split workers", () => {
    const input = meshRuntimeToKpiInput({
      peers: [
        {
          hostname: "LYU",
          role: "Host",
          state: "serving",
          vram_gb: 17.2,
          hosted_models: ["DeepSeek-R1-Distill-70B-Q4_K_M"],
          serving_models: ["DeepSeek-R1-Distill-70B-Q4_K_M"],
          capability: { backend: "cuda", loaded_models: ["DeepSeek-R1-Distill-70B-Q4_K_M"] },
        },
        {
          hostname: "f5aa2ca5aad2",
          role: "Worker",
          state: "loading",
          vram_gb: 12,
          requested_models: ["DeepSeek-R1-Distill-70B-Q4_K_M"],
          capability: { backend: "cuda" },
        },
      ],
    });
    expect(input.nodeCount).toBe(2);
    const snap = buildKpiSnapshot(
      input,
      "DeepSeek-R1-Distill-70B-Q4_K_M",
      "https://entry.senda.network/api/status",
      new Date(),
      ["DeepSeek-R1-Distill-70B-Q4_K_M"],
    );
    expect(snap.flagship.contributors).toBe(2);
    expect(snap.pooled_vram_gb).toBeCloseTo(29.2, 1);
  });
});

describe("mergeWeekSnapshots", () => {
  test("empty offline capture does not erase a peak week", () => {
    const peak = buildKpiSnapshot(
      {
        online: true,
        nodeCount: 5,
        models: ["DeepSeek-R1-Distill-70B-Q4_K_M"],
        nodes: [
          {
            hostname: "LYU",
            servingModels: ["DeepSeek-R1-Distill-70B-Q4_K_M"],
            vramGb: 66,
            capability: { backend: "cuda", vramGb: 66 },
          },
        ],
      },
      "DeepSeek-R1-Distill-70B-Q4_K_M",
      "https://entry.senda.network/api/status",
      new Date("2026-05-23T23:49:00Z"),
      ["DeepSeek-R1-Distill-70B-Q4_K_M"],
    );
    const empty = buildKpiSnapshot(
      { online: false, nodeCount: 0, models: [], nodes: [] },
      "DeepSeek-R1-Distill-70B-Q4_K_M",
      "https://entry.senda.network/api/status",
      new Date("2026-05-24T06:00:00Z"),
    );
    const merged = mergeWeekSnapshots(peak, empty);
    expect(merged.node_count).toBe(5);
    expect(merged.models_available).toBe(1);
  });

  test("keeps online true when the retained peak had peers", () => {
    const peak = buildKpiSnapshot(
      {
        online: true,
        nodeCount: 4,
        models: ["Qwen3-8B-Q4_K_M"],
        nodes: [
          {
            hostname: "LYU",
            servingModels: ["Qwen3-8B-Q4_K_M"],
            vramGb: 70.3,
            capability: { backend: "cuda", vramGb: 70.3 },
          },
        ],
      },
      "Qwen3-8B-Q4_K_M",
      "https://entry.senda.network/api/status",
      new Date("2026-08-02T12:00:00Z"),
      ["Qwen3-8B-Q4_K_M"],
    );
    const empty = buildKpiSnapshot(
      { online: false, nodeCount: 0, models: [], nodes: [] },
      "Qwen3-8B-Q4_K_M",
      "https://entry.senda.network/api/status",
      new Date("2026-08-02T23:00:00Z"),
    );
    const merged = mergeWeekSnapshots(peak, empty);
    expect(merged.node_count).toBe(4);
    expect(merged.online).toBe(true);
  });
});

describe("through-mesh plausibility bound", () => {
  const nodeWith = (
    measuredTps: number,
    nativeTps?: number,
    measuredTtft = 1200,
    nativeTtft?: number,
  ) =>
    buildKpiSnapshot(
      {
        online: true,
        nodeCount: 1,
        models: ["Qwen3-8B-Q4_K_M"],
        nodes: [
          {
            hostname: "peer-a",
            servingModels: ["Qwen3-8B-Q4_K_M"],
            vramGb: 12.9,
            capability: { backend: "metal", vramGb: 12.9 },
            measuredTpsP50ByModel: { "Qwen3-8B-Q4_K_M": measuredTps },
            measuredTtftMsP50ByModel: { "Qwen3-8B-Q4_K_M": measuredTtft },
            ...(nativeTps !== undefined
              ? { nativeTpsP50ByModel: { "Qwen3-8B-Q4_K_M": nativeTps } }
              : {}),
            ...(nativeTtft !== undefined
              ? { nativeTtftMsP50ByModel: { "Qwen3-8B-Q4_K_M": nativeTtft } }
              : {}),
          },
        ],
      },
      "Qwen3-8B-Q4_K_M",
      "https://entry.senda.network/api/status",
      new Date("2026-08-11T15:00:00Z"),
      ["Qwen3-8B-Q4_K_M"],
    );

  test("drops through-mesh tps that beats the peer's native baseline", () => {
    // The W31 shape: 487 tok/s recorded through the mesh on a peer whose own
    // native baseline is 20 tok/s.
    const snap = nodeWith(487.534, 20.196);
    expect(snap.flagship.tps_p50_median).toBeNull();
    expect(snap.flagship.tps_sample_count).toBe(0);
  });

  test("keeps through-mesh tps at or below the native baseline", () => {
    const snap = nodeWith(11.888, 20.196);
    expect(snap.flagship.tps_p50_median).toBeCloseTo(11.888, 3);
    expect(snap.flagship.tps_sample_count).toBe(1);
  });

  test("passes values through when the peer gossips no native baseline", () => {
    const snap = nodeWith(21.875);
    expect(snap.flagship.tps_p50_median).toBeCloseTo(21.875, 3);
    expect(snap.flagship.tps_sample_count).toBe(1);
  });

  test("drops through-mesh ttft faster than the native baseline", () => {
    const snap = nodeWith(11.888, 20.196, 400, 2043);
    expect(snap.flagship.ttft_ms_best).toBeNull();
    expect(snap.flagship.ttft_sample_count).toBe(0);
  });

  test("keeps through-mesh ttft at or above the native baseline", () => {
    const snap = nodeWith(11.888, 20.196, 20959, 2043);
    expect(snap.flagship.ttft_ms_best).toBe(20959);
    expect(snap.flagship.ttft_sample_count).toBe(1);
  });
});

describe("pickFlagshipModel", () => {
  test("prefers routable models over default", () => {
    expect(
      pickFlagshipModel([], ["DeepSeek-R1-Distill-70B-Q4_K_M"], null, null),
    ).toBe("DeepSeek-R1-Distill-70B-Q4_K_M");
  });
});

describe("snapshotFromMilestone", () => {
  test("backfills DeepSeek serve peak from known milestone", () => {
    const snap = snapshotFromMilestone(KNOWN_MILESTONES[0]!);
    expect(snap.node_count).toBe(5);
    expect(snap.pooled_vram_gb).toBe(66);
    expect(snap.routable_models).toContain("DeepSeek-R1-Distill-70B-Q4_K_M");
    expect(snapshotQuality(snap)).toBeGreaterThan(5_000);
  });
});
