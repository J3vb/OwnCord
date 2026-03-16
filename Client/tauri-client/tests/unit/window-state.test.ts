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

// Mock Tauri APIs as unavailable by default
vi.mock("@tauri-apps/api/core", () => {
  throw new Error("Not in Tauri");
});

vi.mock("@tauri-apps/api/window", () => {
  throw new Error("Not in Tauri");
});

describe("window-state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("initWindowState returns a cleanup function when Tauri unavailable", async () => {
    const { initWindowState } = await import("@lib/window-state");
    const cleanup = await initWindowState();
    expect(typeof cleanup).toBe("function");
    // Should be a no-op
    cleanup();
  });
});
