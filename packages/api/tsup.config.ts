import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "events-handler": "src/events-handler.ts",
    "aggregation-worker": "src/aggregation-worker.ts"
  },
  format: ["cjs"],
  bundle: true,
  target: "node20",
  sourcemap: true,
  clean: true,
  dts: true,
  external: ["@prisma/client"],
  noExternal: ["@slack/web-api", "@aws-sdk/*"]
});
