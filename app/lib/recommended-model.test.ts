import { describe, expect, test } from "vitest";
import {
  DAILY_DRIVER_ID,
  MID_TIER_ID,
  SMOKE_TEST_ID,
  pickRecommendedModel,
} from "./recommended-model";
import { MODEL_CATALOG } from "./model-catalog";

const CATALOG = MODEL_CATALOG;

describe("unknown hardware", () => {
  // The regression that put a 12.9 GB M1 Pro on the smoke-test model.
  test("returns null when neither VRAM nor backend is known", () => {
    expect(pickRecommendedModel(CATALOG, null, null)).toBeNull();
  });

  test("returns null when only the backend is unknown", () => {
    expect(pickRecommendedModel(CATALOG, 12.9, null)).toBeNull();
  });

  test("returns null when only VRAM is unknown", () => {
    expect(pickRecommendedModel(CATALOG, null, "metal")).toBeNull();
  });

  test("never silently degrades to the smoke test on unknown hardware", () => {
    const picked = pickRecommendedModel(CATALOG, null, null);
    expect(picked?.id).not.toBe(SMOKE_TEST_ID);
    expect(picked).toBeNull();
  });
});

describe("real hardware picks the daily driver", () => {
  // The live peer from 2026-08-11: Apple M1 Pro, 12.9 GB usable, metal.
  // It was serving Qwen3-0.6B. It should have been on the daily driver.
  test("M1 Pro / 12.9 GB / metal → daily driver", () => {
    const picked = pickRecommendedModel(CATALOG, 12.9, "metal");
    expect(picked?.id).toBe(DAILY_DRIVER_ID);
  });

  test("workstation / 80 GB / cuda → daily driver", () => {
    expect(pickRecommendedModel(CATALOG, 80, "cuda")?.id).toBe(DAILY_DRIVER_ID);
  });

  test("exactly at the daily driver's VRAM floor still qualifies", () => {
    const daily = CATALOG.find((m) => m.id === DAILY_DRIVER_ID)!;
    expect(pickRecommendedModel(CATALOG, daily.minVramGb, "metal")?.id).toBe(
      DAILY_DRIVER_ID,
    );
  });

  test("vulkan and rocm count as real GPUs", () => {
    for (const backend of ["vulkan", "rocm"]) {
      expect(pickRecommendedModel(CATALOG, 24, backend)?.id).toBe(
        DAILY_DRIVER_ID,
      );
    }
  });
});

describe("machines that genuinely cannot run the daily driver", () => {
  test("plenty of RAM but no GPU does not get the daily driver", () => {
    const picked = pickRecommendedModel(CATALOG, 64, "cpu");
    expect(picked?.id).not.toBe(DAILY_DRIVER_ID);
  });

  test("CPU-only with no VRAM gets a cpuOk model", () => {
    const picked = pickRecommendedModel(CATALOG, 0, "cpu");
    expect(picked).not.toBeNull();
    expect(picked!.cpuOk).toBe(true);
  });

  test("a GPU too small for the daily driver falls back below it", () => {
    const daily = CATALOG.find((m) => m.id === DAILY_DRIVER_ID)!;
    const picked = pickRecommendedModel(CATALOG, daily.minVramGb - 1, "metal");
    expect(picked?.id).not.toBe(DAILY_DRIVER_ID);
  });

  test("mid-tier is preferred over the smoke test when it fits", () => {
    const mid = CATALOG.find((m) => m.id === MID_TIER_ID);
    if (!mid) return; // catalog may drop it; the daily-driver path is the contract
    const picked = pickRecommendedModel(CATALOG, mid.minVramGb, "cpu");
    expect(picked?.id).toBe(MID_TIER_ID);
  });
});

describe("never recommends something that cannot run", () => {
  test("picked model's VRAM floor is satisfied, or it is cpuOk", () => {
    for (const vram of [0, 2, 4, 6, 8, 12, 16, 24, 48, 96, 240]) {
      for (const backend of ["cpu", "metal", "cuda", "vulkan", "rocm"]) {
        const picked = pickRecommendedModel(CATALOG, vram, backend);
        expect(picked, `vram=${vram} backend=${backend}`).not.toBeNull();
        const fits = vram >= picked!.minVramGb || picked!.cpuOk === true;
        expect(fits, `${picked!.id} @ ${vram}GB/${backend}`).toBe(true);
      }
    }
  });

  test("never recommends a capacity-class model to a small machine", () => {
    const picked = pickRecommendedModel(CATALOG, 8, "metal")!;
    expect(picked.minVramGb).toBeLessThanOrEqual(8);
  });

  test("empty catalog yields null rather than throwing", () => {
    expect(pickRecommendedModel([], 16, "metal")).toBeNull();
  });
});
