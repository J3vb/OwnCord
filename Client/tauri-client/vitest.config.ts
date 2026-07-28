import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@lib": resolve(__dirname, "src/lib"),
      "@stores": resolve(__dirname, "src/stores"),
      "@components": resolve(__dirname, "src/components"),
      "@pages": resolve(__dirname, "src/pages"),
      "@styles": resolve(__dirname, "src/styles"),
    },
  },
  test: {
    environment: "jsdom",
    // Both the `tests/**/*.test.ts` suite and component-local
    // `src/**/*.test.ts` files are picked up.
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Keep this list minimal and justified. An unexplained entry hides a
      // real gap: window-state.ts, credentials.ts, updater.ts and
      // UpdateNotifier.ts each sat here while having (or gaining) tests, so
      // their coverage never showed up in any report.
      exclude: [
        "src/**/*.d.ts",
        // App bootstrap: wires the DOM, router and stores together at startup.
        // Has no seam to test below the e2e level; covered by tests/e2e.
        "src/main.ts",
        // Top-level page orchestrator, likewise covered at the e2e level.
        // Tracked for unit coverage — remove this entry once it has tests.
        "src/pages/MainPage.ts",
        // RNNoise AudioWorklet host: needs a real AudioContext/WASM runtime
        // that jsdom cannot provide. Exercised by tests/browser and e2e.
        "src/lib/noise-suppression.ts",
      ],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});
