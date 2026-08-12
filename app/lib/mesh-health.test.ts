import { describe, expect, test } from "vitest";
import {
  describeMeshHealth,
  evaluateMeshHealth,
  type MeshHealth,
} from "./mesh-health";
import type { KpiSnapshot } from "./kpi-snapshot";

function snap(over: Partial<KpiSnapshot> = {}): KpiSnapshot {
  return {
    captured_at: "2026-08-11T15:00:00.000Z",
    status_url: "https://entry.senda.network/api/status",
    flagship_model: "Qwen3-8B-Q4_K_M",
    online: true,
    node_count: 4,
    backends: ["cuda", "metal"],
    pooled_vram_gb: 53.1,
    models_available: 2,
    routable_models: ["Qwen3-0.6B-Q4_K_M", "Qwen3-8B-Q4_K_M"],
    flagship: {
      contributors: 2,
      tps_p50_median: 21.875,
      ttft_ms_best: 1163,
      tps_sample_count: 1,
      ttft_sample_count: 1,
    },
    ...over,
  };
}

const AT = new Date("2026-08-11T15:00:00.000Z");

describe("evaluateMeshHealth", () => {
  test("healthy mesh serving the flagship is ok", () => {
    const h = evaluateMeshHealth(snap(), null, AT);
    expect(h.level).toBe("ok");
    expect(h.reasons).toEqual([]);
    expect(h.degraded_since).toBeNull();
    expect(h.degraded_hours).toBe(0);
  });

  test("flags the real W33 condition: flagship gone, only the smoke test left", () => {
    const h = evaluateMeshHealth(
      snap({
        node_count: 2,
        models_available: 1,
        routable_models: ["Qwen3-0.6B-Q4_K_M"],
        flagship: {
          contributors: 0,
          tps_p50_median: null,
          ttft_ms_best: null,
          tps_sample_count: 0,
          ttft_sample_count: 0,
        },
      }),
      null,
      AT,
    );
    expect(h.level).toBe("degraded");
    expect(h.reasons).toEqual([
      "flagship_not_routable",
      "flagship_no_contributors",
    ]);
    expect(h.flagship_routable).toBe(false);
  });

  test("an empty mesh is down, not merely degraded", () => {
    const h = evaluateMeshHealth(
      snap({ node_count: 0, routable_models: [], models_available: 0 }),
      null,
      AT,
    );
    expect(h.level).toBe("down");
    expect(h.reasons).toEqual(["mesh_empty"]);
  });

  test("peers present but nothing routable is down", () => {
    const h = evaluateMeshHealth(
      snap({ routable_models: [], models_available: 0 }),
      null,
      AT,
    );
    expect(h.level).toBe("down");
    expect(h.reasons).toEqual(["nothing_routable"]);
  });

  test("flagship routable but unserved still degrades", () => {
    const h = evaluateMeshHealth(
      snap({
        flagship: {
          contributors: 0,
          tps_p50_median: null,
          ttft_ms_best: null,
          tps_sample_count: 0,
          ttft_sample_count: 0,
        },
      }),
      null,
      AT,
    );
    expect(h.level).toBe("degraded");
    expect(h.reasons).toEqual(["flagship_no_contributors"]);
    expect(h.flagship_routable).toBe(true);
  });
});

describe("availability is judged on ready peers, not advertised ones", () => {
  test("contributors present but none ready is degraded", () => {
    const h = evaluateMeshHealth(
      snap({
        flagship: {
          contributors: 2,
          ready_contributors: 0, // both still pulling weights
          tps_p50_median: null,
          ttft_ms_best: null,
          tps_sample_count: 0,
          ttft_sample_count: 0,
        },
      }),
      null,
      AT,
    );
    expect(h.level).toBe("degraded");
    expect(h.reasons).toContain("flagship_no_contributors");
    expect(h.flagship_contributors).toBe(2);
    expect(h.flagship_ready_contributors).toBe(0);
  });

  test("one ready peer is healthy even while others load", () => {
    const h = evaluateMeshHealth(
      snap({ flagship: { ...snap().flagship, contributors: 2, ready_contributors: 1 } }),
      null,
      AT,
    );
    expect(h.level).toBe("ok");
    expect(describeMeshHealth(h)).toContain("1 peer(s) serving");
    expect(describeMeshHealth(h)).toContain("1 more loading");
  });

  test("falls back to contributors when ready is absent (legacy snapshot)", () => {
    const s = snap();
    delete (s.flagship as { ready_contributors?: number }).ready_contributors;
    const h = evaluateMeshHealth(s, null, AT);
    expect(h.level).toBe("ok");
    expect(h.flagship_ready_contributors).toBe(s.flagship.contributors);
  });

  test("no warming note when every contributor is ready", () => {
    const h = evaluateMeshHealth(
      snap({ flagship: { ...snap().flagship, contributors: 3, ready_contributors: 3 } }),
      null,
      AT,
    );
    expect(describeMeshHealth(h)).toContain("3 peer(s) serving");
    expect(describeMeshHealth(h)).not.toContain("loading");
  });
});

describe("degraded run tracking", () => {
  const degraded = (at: Date, prior: MeshHealth | null) =>
    evaluateMeshHealth(
      snap({
        routable_models: ["Qwen3-0.6B-Q4_K_M"],
        flagship: {
          contributors: 0,
          tps_p50_median: null,
          ttft_ms_best: null,
          tps_sample_count: 0,
          ttft_sample_count: 0,
        },
      }),
      prior,
      at,
    );

  test("opens a run on the first not-ok check", () => {
    const h = degraded(AT, null);
    expect(h.degraded_since).toBe(AT.toISOString());
    expect(h.degraded_hours).toBe(0);
  });

  test("extends an existing run and counts elapsed hours", () => {
    const first = degraded(new Date("2026-08-04T15:00:00.000Z"), null);
    const later = degraded(new Date("2026-08-11T15:00:00.000Z"), first);
    expect(later.degraded_since).toBe("2026-08-04T15:00:00.000Z");
    expect(later.degraded_hours).toBe(168);
  });

  test("a degraded check after a down check extends the same run", () => {
    const down = evaluateMeshHealth(
      snap({ node_count: 0, routable_models: [] }),
      null,
      new Date("2026-08-10T15:00:00.000Z"),
    );
    expect(down.level).toBe("down");
    const next = degraded(new Date("2026-08-11T15:00:00.000Z"), down);
    expect(next.level).toBe("degraded");
    expect(next.degraded_since).toBe("2026-08-10T15:00:00.000Z");
    expect(next.degraded_hours).toBe(24);
  });

  test("recovery clears the run", () => {
    const prior = degraded(new Date("2026-08-04T15:00:00.000Z"), null);
    const recovered = evaluateMeshHealth(snap(), prior, AT);
    expect(recovered.level).toBe("ok");
    expect(recovered.degraded_since).toBeNull();
    expect(recovered.degraded_hours).toBe(0);
  });

  test("a fresh run starts after recovery rather than resuming the old one", () => {
    const old = degraded(new Date("2026-08-01T15:00:00.000Z"), null);
    const recovered = evaluateMeshHealth(
      snap(),
      old,
      new Date("2026-08-10T15:00:00.000Z"),
    );
    const again = degraded(AT, recovered);
    expect(again.degraded_since).toBe(AT.toISOString());
    expect(again.degraded_hours).toBe(0);
  });
});

describe("describeMeshHealth", () => {
  test("names the model when healthy", () => {
    expect(describeMeshHealth(evaluateMeshHealth(snap(), null, AT))).toContain(
      "2 peer(s) serving Qwen3-8B-Q4_K_M",
    );
  });

  test("reports multi-day outages in days", () => {
    const first = evaluateMeshHealth(
      snap({ node_count: 0, routable_models: [] }),
      null,
      new Date("2026-08-04T15:00:00.000Z"),
    );
    const later = evaluateMeshHealth(
      snap({ node_count: 0, routable_models: [] }),
      first,
      AT,
    );
    const text = describeMeshHealth(later);
    expect(text).toContain("Mesh down");
    expect(text).toContain("Ongoing for 7 day(s).");
  });
});
