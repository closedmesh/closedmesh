/**
 * First-model recommendation for a contributor's machine.
 *
 * Extracted from the control dashboard because this is the single most
 * consequential decision in the whole join path: whatever it returns is what
 * the auto-quick-start downloads, and `autoStartFired` is a one-way latch, so a
 * wrong answer is permanent for that install. It decides what the mesh actually
 * serves, and it needs to be under test.
 *
 * Bias toward something that will genuinely run on the hardware (never point a
 * CPU-only laptop at a 70B) while still being useful enough that chat feels
 * real:
 *
 *   - ≥8 GB VRAM/UMA + a real GPU backend → Qwen 3 8B (the daily driver)
 *   - 4–8 GB, or CPU-only on a fast machine → Phi-3 mini (cpuOk, 2.5 GB)
 *   - tiny → Qwen 3 0.6B smoke test (cpuOk, 0.4 GB)
 *   - **unknown → nothing.** See below.
 *
 * The unknown case is the bug this module exists to prevent. Capability is only
 * known once the runtime joins the mesh and gossips it; before that the
 * dashboard defaulted the backend to `"cpu"` and VRAM to `0`, which is
 * indistinguishable from a real GPU-less machine. Since the daily-driver branch
 * gates on `backend !== "cpu"`, every fresh install fell through to the
 * smoke-test model — and the auto-download raced ahead of mesh join and latched
 * it. That is how the mesh's only peer on 2026-08-11 was a 12.9 GB M1 Pro
 * serving Qwen3-0.6B while the advertised daily driver was unroutable.
 */

import type { CatalogModel } from "./model-catalog";

export const DAILY_DRIVER_ID = "Qwen3-8B-Q4_K_M";
export const MID_TIER_ID = "Phi-3-mini-4k-Q4_K_M";
export const SMOKE_TEST_ID = "Qwen3-0.6B-Q4_K_M";

/** Backends that mean "no usable GPU" or "we don't know yet". */
function hasRealGpu(backend: string): boolean {
  return backend !== "cpu" && backend !== "" && backend !== "unknown";
}

/**
 * @param vramGb usable VRAM/UMA in GB, or `null` when not yet reported.
 * @param backend runtime backend id, or `null` when not yet reported.
 * @returns the recommended model, or `null` when hardware is unknown (callers
 *   must not fall back to a default — wait, or ask).
 */
export function pickRecommendedModel(
  catalog: CatalogModel[],
  vramGb: number | null,
  backend: string | null,
): CatalogModel | null {
  // Unknown hardware yields no recommendation. Deliberately not a "safe
  // default": a safe-looking default is exactly what caused the incident.
  if (vramGb === null || backend === null) return null;

  const hasGpu = hasRealGpu(backend);
  const candidates = catalog.filter((m) => {
    if (vramGb >= m.minVramGb) return true;
    return m.cpuOk === true && vramGb === 0;
  });
  if (candidates.length === 0) return catalog[0] ?? null;

  const dailyDriver = candidates.find((m) => m.id === DAILY_DRIVER_ID);
  if (dailyDriver && vramGb >= dailyDriver.minVramGb && hasGpu) {
    return dailyDriver;
  }

  const midTier = candidates.find((m) => m.id === MID_TIER_ID);
  if (midTier && vramGb >= midTier.minVramGb) return midTier;

  const smokeTest = catalog.find((m) => m.id === SMOKE_TEST_ID);
  return smokeTest ?? candidates[0] ?? null;
}
