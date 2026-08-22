import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@lib": resolve(import.meta.dirname, "src/lib"),
      "@stores": resolve(import.meta.dirname, "src/stores"),
      "@components": resolve(import.meta.dirname, "src/components"),
      "@pages": resolve(import.meta.dirname, "src/pages"),
      "@styles": resolve(import.meta.dirname, "src/styles"),
    },
  },
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
    include: ["tests/browser/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
