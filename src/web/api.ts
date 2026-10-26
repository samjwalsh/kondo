import type { HealthResponse } from "../shared/api.js";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

export const api = {
  health: () => getJson<HealthResponse>("/api/health"),
};
