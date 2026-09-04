import { configDefaults, defineConfig } from "vitest/config";
import { resolve } from "path";

// Node >= 22.4 ships its own Web Storage, and vitest's jsdom environment makes
// `window === globalThis` — so Node's `localStorage` AND its `Storage` class
// shadow jsdom's. `localStorage` then returns undefined without
// `--localstorage-file`, and `Storage` names Node's class, which silently
// defeats every `vi.spyOn(Storage.prototype, ...)` in the suite (OC-0415).
// Switching Node's implementation off leaves jsdom's as the only one, which is
// what the suite has always assumed and what CI's Node 24 happened to give.
//
// This module is evaluated in vitest's parent process, and the worker
// processes inherit its environment — `poolOptions.forks.execArgv` does NOT
// work here, vitest replaces execArgv with its own list. tests/setup.ts fails
// loudly if the flag does not arrive, so this can never degrade in silence.
const WEBSTORAGE_OFF = "--no-experimental-webstorage";
if (!(process.env.NODE_OPTIONS ?? "").includes(WEBSTORAGE_OFF)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${WEBSTORAGE_OFF}`.trim();
}

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
    // Asserts the NODE_OPTIONS flag below actually arrived; see its comment
    // and tests/setup.ts's header.
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
