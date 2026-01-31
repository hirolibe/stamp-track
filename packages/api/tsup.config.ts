import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "events-handler": "src/events-handler.ts",
    "events-worker": "src/events-worker.ts",
    "aggregation-worker": "src/aggregation-worker.ts",
    "slack-notifier": "src/slack-notifier.ts"
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
