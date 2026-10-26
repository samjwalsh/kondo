// Types shared by the server and the web UI.

export interface HealthResponse {
  status: "ok";
  version: string;
  node: string;
  startedAt: string;
  uptimeSeconds: number;
}
