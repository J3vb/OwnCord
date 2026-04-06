import { defineConfig } from "vitest/config";
import { resolve } from "path";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    // Transform Solid JSX/TSX for component tests under src/components/solid/.
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
    include: [
      "tests/**/*.test.ts",
      // Solid component tests live next to the source they test.
      "src/components/solid/**/*.test.tsx",
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
