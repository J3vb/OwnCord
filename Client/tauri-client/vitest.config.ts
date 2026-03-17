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
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/main.ts",
        "src/**/*.d.ts",
        "src/lib/window-state.ts",
        "src/lib/credentials.ts",
        "src/lib/audio.ts",
        "src/lib/vad.ts",
        "src/lib/webrtc.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
