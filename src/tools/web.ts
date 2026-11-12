// Tool pages for the web UI. Adding a tool = a folder under src/tools/ plus one
// line here and one in ./server.ts.
import type { ComponentType } from "react";
import { AttentionPage } from "./attention/web.js";
import { DiagnosticsPage } from "./diagnostics/web.js";
import { DownloadsPage } from "./downloads/web.js";
import { MissingPage } from "./missing/web.js";
import { RequestsPage } from "./requests/web.js";
import { TranscodePage } from "./transcode/web.js";

export const toolPages: Record<string, ComponentType> = {
  attention: AttentionPage,
  transcode: TranscodePage,
  downloads: DownloadsPage,
  missing: MissingPage,
  requests: RequestsPage,
  diagnostics: DiagnosticsPage,
};
