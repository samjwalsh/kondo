// The tools Kondo runs. Adding a tool = a folder under src/tools/ plus one line
// here and one in ./web.ts.
import type { ToolDefinition } from "../server/core/tools.js";
import diagnostics from "./diagnostics/server.js";

export const tools: ToolDefinition[] = [diagnostics];
