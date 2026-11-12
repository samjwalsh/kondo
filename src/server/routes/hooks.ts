import type { FastifyInstance } from "fastify";
import type { ArrClient } from "../integrations/arr.js";
import { errorMessage } from "../integrations/http.js";

export interface DownloadFinishedResponse {
  /** Which app was told to check its downloads, if any. */
  told: string | null;
  /** Why nothing was told, or what went wrong. */
  note?: string;
}

/**
 * Hooks other apps call. `download-finished` is for qBittorrent's "Run external program on
 * torrent finished" (`curl -s -X POST "http://kondo/api/hooks/download-finished?category=%L"`):
 * it tells Sonarr or Radarr, by the torrent's category, to check their downloads now rather
 * than at their next one-minute poll. Kondo holds the API keys, so qBittorrent doesn't need them.
 */
export function registerHookRoutes(
  app: FastifyInstance,
  arrs: { sonarr: ArrClient; radarr: ArrClient },
): void {
  app.post<{ Querystring: { category?: string } }>(
    "/api/hooks/download-finished",
    async (request, reply): Promise<DownloadFinishedResponse> => {
      const category = (request.query.category ?? "").trim().toLowerCase();
      const arr = category === "sonarr" ? arrs.sonarr : category === "radarr" ? arrs.radarr : null;
      if (!arr) return { told: null, note: `Category "${category}" isn't Sonarr's or Radarr's` };
      if (!arr.configured()) return { told: null, note: `${arr.name} isn't set up in Kondo` };
      try {
        await arr.refreshDownloads();
        request.log.info({ category }, `Download finished: told ${arr.name} to check downloads`);
        return { told: arr.name };
      } catch (error) {
        request.log.warn({ category, error }, `Couldn't tell ${arr.name} a download finished`);
        return reply.code(502).send({ told: null, note: errorMessage(error) });
      }
    },
  );
}
