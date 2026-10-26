// Tool pages for the web UI. Adding a tool = a folder under src/tools/ plus one
// line here and one in ./server.ts.
import type { ComponentType } from "react";
import { DiagnosticsPage } from "./diagnostics/web.js";
import { TranscodePage } from "./transcode/web.js";

export const toolPages: Record<string, ComponentType> = {
  transcode: TranscodePage,
  diagnostics: DiagnosticsPage,
};
