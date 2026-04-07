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
      include: ["src/components/solid/**/*.{ts,tsx,js,jsx}"],
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
    include: [
      "tests/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
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
