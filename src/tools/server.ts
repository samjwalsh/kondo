// The tools Kondo runs. Adding a tool = a folder under src/tools/ plus one line
// here and one in ./web.ts.
import type { ToolDefinition } from "../server/core/tools.js";
import attention from "./attention/server.js";
import diagnostics from "./diagnostics/server.js";
import downloads from "./downloads/server.js";
import missing from "./missing/server.js";
import transcode from "./transcode/server.js";

// "Needs a look" comes first, so its lines lead the morning summary.
export const tools: ToolDefinition[] = [attention, transcode, downloads, missing, diagnostics];
