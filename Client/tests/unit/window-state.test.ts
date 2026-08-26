import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Tauri window API unavailable (non-Tauri context, e.g. dev browser).
vi.mock("@tauri-apps/api/window", () => {
  throw new Error("Not in Tauri");
});

describe("window-state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("initWindowState resolves without throwing when Tauri is unavailable", async () => {
    const { initWindowState } = await import("@lib/window-state");
    await expect(initWindowState()).resolves.toBeUndefined();
  });
});
