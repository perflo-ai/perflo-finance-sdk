import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
      },
    }),
  ],
  test: {
    include: ["tests/workerd-runtime.workerd.ts"],
  },
});
