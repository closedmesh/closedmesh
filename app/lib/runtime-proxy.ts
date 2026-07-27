/**
 * Shared runtime URL / bearer for site → entry proxy paths.
 */

function trimmedEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value) return value;
  }
  return undefined;
}

export function runtimeBaseUrl(): string {
  return (
    trimmedEnv("SENDA_RUNTIME_URL", "MESH_LLM_URL") ??
    "http://127.0.0.1:9337/v1"
  );
}

export function runtimeAuthHeaders(): Record<string, string> {
  const token = trimmedEnv("SENDA_RUNTIME_TOKEN") ?? "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}
