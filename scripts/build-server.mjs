// Bundles the server into a single file, so the VM only needs Node itself:
// no node_modules, nothing to compile there.
import { execSync } from "node:child_process";
import { build } from "esbuild";

function gitVersion() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

await build({
  entryPoints: ["src/server/main.ts"],
  outfile: "dist/server/main.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  define: {
    "process.env.KONDO_VERSION": JSON.stringify(gitVersion()),
  },
  // Some bundled dependencies are CommonJS and call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
