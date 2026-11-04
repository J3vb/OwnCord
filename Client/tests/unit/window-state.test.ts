import { describe, it, expect, vi, beforeEach } from "vitest";
import { loggerMock } from "../helpers/loggerMock";

// Mock logger
vi.mock("@lib/logger", () => loggerMock());

// Tauri window API unavailable (non-Tauri context, e.g. dev browser).
vi.mock("@tauri-apps/api/window", () => {
  throw new Error("Not in Tauri");
});

describe("window-state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("initWindowState resolves without throwing when Tauri is unavailable", async () => {
    const { initWindowState } = await import("@lib/prefs/windowState");
    await expect(initWindowState()).resolves.toBeUndefined();
  });
});
