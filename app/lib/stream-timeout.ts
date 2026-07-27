/**
 * Race a promise against an idle/stall timeout.
 * Used for mid-stream body reads so a hung peer can't hold a reserve forever
 * waiting on platform maxDuration alone.
 */

export class StreamIdleTimeoutError extends Error {
  constructor(message = "Stream idle timeout") {
    super(message);
    this.name = "StreamIdleTimeoutError";
  }
}

export async function withIdleTimeout<T>(
  promise: Promise<T>,
  idleMs: number,
  label = "idle",
): Promise<T> {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new StreamIdleTimeoutError(`Stream ${label} timeout after ${idleMs}ms`));
        }, idleMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
