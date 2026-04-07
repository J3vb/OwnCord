import { defineConfig } from "vitest/config";
import { resolve } from "path";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  // The Solid plugin must be applied here in addition to vite.config.ts so
  // Vitest can transform `.tsx` test files under src/components/solid/.
  // Without it, JSX in component tests is parsed as TypeScript and fails on
  // the angle brackets.
  plugins: [
    solidPlugin({
      // Phase B Step 6: cover both the component directory and test files
      // under tests/ that use JSX (e.g. setup-solid.test.tsx, T-500).
      include: ["src/components/solid/**/*.{ts,tsx,js,jsx}", "tests/**/*.tsx"],
    }),
  ],
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
    // Both the legacy `tests/**/*.test.ts` suite and component-local
    // `src/**/*.test.{ts,tsx}` files are picked up. The latter is required
    // for Phase B Step 6 Solid components, whose tests live alongside the
    // component file (see src/components/solid/README.md).
    // T-500: also pick up .tsx test files under tests/ (e.g. setup-solid.test.tsx).
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
    // T-500: global Solid.js test setup — registers afterEach(cleanup) so
    // individual *.test.tsx files do not need to call cleanup() manually.
    setupFiles: ["./tests/setup-solid.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/main.ts",
        "src/**/*.d.ts",
        "src/lib/window-state.ts",
        "src/lib/credentials.ts",
        "src/lib/noise-suppression.ts",
        "src/lib/updater.ts",
        "src/pages/MainPage.ts",
        "src/components/UpdateNotifier.ts",
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
