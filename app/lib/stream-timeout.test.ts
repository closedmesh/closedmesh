import { describe, expect, it } from "vitest";
import { StreamIdleTimeoutError, withIdleTimeout } from "./stream-timeout";

describe("withIdleTimeout", () => {
  it("resolves when the promise wins", async () => {
    await expect(withIdleTimeout(Promise.resolve(42), 50)).resolves.toBe(42);
  });

  it("rejects with StreamIdleTimeoutError on stall", async () => {
    await expect(
      withIdleTimeout(new Promise(() => {}), 20),
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
  });
});
