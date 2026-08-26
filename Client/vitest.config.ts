import { configDefaults, defineConfig } from "vitest/config";
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
    environment: "jsdom",
    // Restores `localStorage`, which Node 26 shadows out of the jsdom global.
    setupFiles: ["./tests/setup.ts"],
    // Both the `tests/**/*.test.ts` suite and component-local
    // `src/**/*.test.ts` files are picked up.
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // tests/browser/ runs real browser APIs (AudioContext, WASM) under
    // vitest.config.browser.ts (`npm run test:browser`); it cannot pass in
    // jsdom and is not part of this suite.
    exclude: [...configDefaults.exclude, "tests/browser/**"],
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
