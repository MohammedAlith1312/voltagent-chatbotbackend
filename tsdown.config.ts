import { defineConfig } from "tsdown";

export default defineConfig({
 entry: [
    "src/index.ts",          // your existing main backend entry
    "src/mcpserver/index.ts" // NEW: MCP server entry
  ],
  sourcemap: true,
  outDir: "dist",
});
