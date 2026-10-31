import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockReadDir,
  mockRemove,
  mockRelaunch,
  mockClearPendingPersistedLogs,
  mockClearAttachmentCaches,
  mockClearEmbedCaches,
  mockClearMediaCaches,
  mockClearExternalImageCache,
  deleteDbState,
  mockIsEnabled,
  mockEnable,
  mockDisable,
} = vi.hoisted(() => ({
  mockReadDir: vi.fn().mockResolvedValue([]),
  mockRemove: vi.fn().mockResolvedValue(undefined),
  mockRelaunch: vi.fn().mockResolvedValue(undefined),
  mockClearPendingPersistedLogs: vi.fn(),
  mockClearAttachmentCaches: vi.fn(),
  mockClearEmbedCaches: vi.fn(),
  mockClearMediaCaches: vi.fn(),
  mockClearExternalImageCache: vi.fn(),
  deleteDbState: {
    mode: "success" as
      | "success"
      | "blocked-then-success"
      | "blocked-stuck"
      | "error"
      | "blocked-double"
      | "success-then-blocked",
  },
  mockIsEnabled: vi.fn().mockResolvedValue(false),
  mockEnable: vi.fn().mockResolvedValue(undefined),
  mockDisable: vi.fn().mockResolvedValue(undefined),
}));

// Mock Tauri APIs
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appLogDir: vi.fn().mockResolvedValue("/mock/logs"),
  join: vi.fn((...args: string[]) => args.join("/")),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: mockReadDir,
  remove: mockRemove,
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: mockIsEnabled,
  enable: mockEnable,
  disable: mockDisable,
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@lib/logPersistence", () => ({
  clearPendingPersistedLogs: mockClearPendingPersistedLogs,
}));

vi.mock("../../src/features/messaging/content/attachments", () => ({
  clearAttachmentCaches: mockClearAttachmentCaches,
  clearExternalImageCache: mockClearExternalImageCache,
}));

vi.mock("../../src/features/messaging/content/embeds", () => ({
  clearEmbedCaches: mockClearEmbedCaches,
}));

vi.mock("../../src/features/messaging/content/media", () => ({
  clearMediaCaches: mockClearMediaCaches,
}));

// Stub globalThis.indexedDB with a simple fake that resolves deleteDatabase
vi.stubGlobal("indexedDB", {
  deleteDatabase: (_name: string) => {
    const fakeReq: Record<string, unknown> = {
      onsuccess: null,
      onerror: null,
      onblocked: null,
      result: undefined,
      error: null,
      readyState: "done",
    };
    Promise.resolve().then(() => {
      if (deleteDbState.mode === "success") {
        const fn = fakeReq.onsuccess as ((ev: Event) => void) | null;
        fn?.(new Event("success"));
      } else if (deleteDbState.mode === "blocked-then-success") {
        const fn = fakeReq.onblocked as ((ev: Event) => void) | null;
        fn?.(new Event("blocked"));
        setTimeout(() => {
          const success = fakeReq.onsuccess as ((ev: Event) => void) | null;
          success?.(new Event("success"));
        }, 0);
      } else if (deleteDbState.mode === "blocked-stuck") {
        const fn = fakeReq.onblocked as ((ev: Event) => void) | null;
        fn?.(new Event("blocked"));
      } else if (deleteDbState.mode === "blocked-double") {
        // Fire onblocked twice to test the blockedTimer guard
        const fn = fakeReq.onblocked as ((ev: Event) => void) | null;
        fn?.(new Event("blocked"));
        fn?.(new Event("blocked"));
      } else if (deleteDbState.mode === "success-then-blocked") {
        // Fire onsuccess first, then onblocked — tests the settled guard
        const successFn = fakeReq.onsuccess as ((ev: Event) => void) | null;
        successFn?.(new Event("success"));
        setTimeout(() => {
          const blockedFn = fakeReq.onblocked as ((ev: Event) => void) | null;
          blockedFn?.(new Event("blocked"));
        }, 0);
      } else {
        fakeReq.error = new Error("delete failed");
        const fn = fakeReq.onerror as ((ev: Event) => void) | null;
        fn?.(new Event("error"));
      }
    });
    return fakeReq;
  },
});

import { buildAdvancedTab } from "@components/settings/AdvancedTab";
import { setChannelMutesHost } from "@lib/prefs/channelMutes";
import {
  getGlobalNotificationLevel,
  getServerNotificationLevel,
  setServerNotificationLevel,
  settleNotificationLevelDefault,
} from "@lib/prefs/notificationLevel";

describe("AdvancedTab — Clear All Cache", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    sessionStorage.clear();
    deleteDbState.mode = "success";
    mockReadDir.mockReset();
    mockReadDir.mockResolvedValue([]);
    mockRemove.mockReset();
    mockRemove.mockResolvedValue(undefined);
    mockRelaunch.mockReset();
    mockRelaunch.mockResolvedValue(undefined);
    mockClearPendingPersistedLogs.mockReset();
    mockClearAttachmentCaches.mockReset();
    mockClearEmbedCaches.mockReset();
    mockClearMediaCaches.mockReset();
    mockClearExternalImageCache.mockReset();
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  function getClearAllBtn(): HTMLButtonElement {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const buttons = container.querySelectorAll("button.ac-btn");
    const btn = Array.from(buttons).find(
      (b) => b.textContent === "Clear & Restart",
    ) as HTMLButtonElement;
    expect(btn).toBeDefined();
    return btn;
  }

  function getActionBtn(label: string): HTMLButtonElement {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const buttons = container.querySelectorAll("button.ac-btn");
    const btn = Array.from(buttons).find((b) => b.textContent === label) as HTMLButtonElement;
    expect(btn).toBeDefined();
    return btn;
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it("preserves owncord:profiles after Clear All Cache", async () => {
    localStorage.setItem(
      "owncord:profiles",
      JSON.stringify([{ name: "Local", host: "localhost" }]),
    );
    localStorage.setItem("owncord:settings:fontSize", "16");
    sessionStorage.setItem("some-session-key", "value");

    const btn = getClearAllBtn();

    // First click — confirmation
    btn.click();
    expect(btn.textContent).toBe("Are you sure? Click again");

    // Second click — execute
    btn.click();
    await flush();

    // Profiles MUST be preserved
    expect(localStorage.getItem("owncord:profiles")).not.toBeNull();
    // Other settings should be cleared
    expect(localStorage.getItem("owncord:settings:fontSize")).toBeNull();
    // sessionStorage should be cleared
    expect(sessionStorage.getItem("some-session-key")).toBeNull();
  });

  it("preserves credential keys after Clear All Cache", async () => {
    localStorage.setItem("owncord:credential:localhost", JSON.stringify({ user: "test" }));
    localStorage.setItem("owncord:settings:compactMode", "false");

    const btn = getClearAllBtn();

    btn.click();
    btn.click();
    await flush();

    expect(localStorage.getItem("owncord:credential:localhost")).not.toBeNull();
    expect(localStorage.getItem("owncord:settings:compactMode")).toBeNull();
  });

  it("preserves active and custom theme keys after Clear All Cache", async () => {
    localStorage.setItem("owncord:theme:active", "custom-sunrise");
    localStorage.setItem(
      "owncord:theme:custom:custom-sunrise",
      JSON.stringify({ name: "custom-sunrise" }),
    );
    localStorage.setItem("owncord:settings:accentColor", '"#00c8ff"');

    const btn = getClearAllBtn();

    btn.click();
    btn.click();
    await flush();

    expect(localStorage.getItem("owncord:theme:active")).toBe("custom-sunrise");
    expect(localStorage.getItem("owncord:theme:custom:custom-sunrise")).not.toBeNull();
    expect(localStorage.getItem("owncord:settings:accentColor")).toBeNull();
  });

  it("keeps the notification level across Clear All so the next launch does not reset it to All", async () => {
    settleNotificationLevelDefault();
    expect(getGlobalNotificationLevel()).toBe("mentions");
    setChannelMutesHost("a.example");
    setServerNotificationLevel("nothing");
    localStorage.setItem("owncord:theme:active", "neon-glow");

    const btn = getClearAllBtn();
    btn.click();
    btn.click();
    await flush();

    settleNotificationLevelDefault();
    expect(getGlobalNotificationLevel()).toBe("mentions");
    expect(getServerNotificationLevel()).toBe("nothing");
    setChannelMutesHost(null);
  });

  it("renders two-step confirmation for Clear All", () => {
    const btn = getClearAllBtn();
    expect(btn.textContent).toBe("Clear & Restart");

    btn.click();
    expect(btn.textContent).toBe("Are you sure? Click again");
    expect(btn.classList.contains("ac-btn-danger")).toBe(true);
  });

  it("clears runtime image and preview caches when clearing image cache succeeds", async () => {
    const btn = getActionBtn("Clear");

    btn.click();
    await flush();

    expect(mockClearAttachmentCaches).toHaveBeenCalledTimes(1);
    expect(mockClearEmbedCaches).toHaveBeenCalledTimes(1);
    expect(mockClearMediaCaches).toHaveBeenCalledTimes(1);
    expect(mockClearExternalImageCache).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe("Cleared!");
  });

  it("waits for a blocked image cache deletion to succeed", async () => {
    deleteDbState.mode = "blocked-then-success";
    const btn = getActionBtn("Clear");

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
    expect(mockClearAttachmentCaches).toHaveBeenCalledTimes(1);
    expect(mockClearEmbedCaches).toHaveBeenCalledTimes(1);
    expect(mockClearMediaCaches).toHaveBeenCalledTimes(1);
    expect(mockClearExternalImageCache).toHaveBeenCalledTimes(1);
  });

  it("shows Failed when image cache deletion remains blocked", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "blocked-stuck";
    const btn = getActionBtn("Clear");

    btn.click();
    await vi.advanceTimersByTimeAsync(1000);

    expect(btn.textContent).toBe("Failed");
    expect(mockClearAttachmentCaches).not.toHaveBeenCalled();
    expect(mockClearEmbedCaches).not.toHaveBeenCalled();
    expect(mockClearMediaCaches).not.toHaveBeenCalled();
    expect(mockClearExternalImageCache).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("treats a missing log directory as an already-cleared success", async () => {
    mockReadDir.mockRejectedValueOnce(new Error("No such file or directory"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;
    expect(btn).toBeDefined();

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("shows Failed when removing existing log files errors", async () => {
    mockReadDir.mockResolvedValueOnce([{ name: "app.jsonl", isDirectory: false }]);
    mockRemove.mockRejectedValueOnce(new Error("Permission denied"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;
    expect(btn).toBeDefined();

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Failed");
    });
  });

  it("clears buffered persisted logs before deleting log files", async () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
    expect(mockClearPendingPersistedLogs).toHaveBeenCalledTimes(1);
  });
});

describe("AdvancedTab — Toggles & Structure", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
  });

  it("renders Developer Mode toggle defaulting to off", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const rows = container.querySelectorAll(".setting-row");
    const devRow = rows[0]!;
    const label = devRow.querySelector(".setting-label")!;
    expect(label.textContent).toBe("Developer Mode");

    const toggle = devRow.querySelector(".toggle")!;
    expect(toggle.classList.contains("on")).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("does not offer a Hardware Acceleration toggle that nothing honours", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const labels = Array.from(container.querySelectorAll(".setting-label")).map(
      (l) => l.textContent,
    );
    expect(labels).not.toContain("Hardware Acceleration");
  });

  it("toggles Developer Mode on and persists to localStorage", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const rows = container.querySelectorAll(".setting-row");
    const toggle = rows[0]!.querySelector(".toggle") as HTMLElement;

    toggle.click();
    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("owncord:settings:developerMode")).toBe("true");

    // Toggle off again
    toggle.click();
    expect(toggle.classList.contains("on")).toBe(false);
    expect(localStorage.getItem("owncord:settings:developerMode")).toBe("false");
  });

  it("restores Developer Mode toggle state from localStorage", () => {
    localStorage.setItem("owncord:settings:developerMode", "true");
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const rows = container.querySelectorAll(".setting-row");
    const toggle = rows[0]!.querySelector(".toggle")!;
    expect(toggle.classList.contains("on")).toBe(true);
  });

  it("toggles via keyboard Enter/Space on Developer Mode", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const rows = container.querySelectorAll(".setting-row");
    const toggle = rows[0]!.querySelector(".toggle") as HTMLElement;

    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(toggle.classList.contains("on")).toBe(true);

    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(toggle.classList.contains("on")).toBe(false);
  });

  it("asks before switching servers by default, and turning it off is stored", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const row = Array.from(container.querySelectorAll(".setting-row")).find(
      (r) => r.querySelector(".setting-label")?.textContent === "Ask before switching servers",
    );
    const toggle = row?.querySelector(".toggle") as HTMLElement;
    expect(toggle.classList.contains("on")).toBe(true);

    toggle.click();
    expect(localStorage.getItem("owncord:settings:confirmServerSwitch")).toBe("false");
  });

  it("shows the switch question as off after Don't ask again", () => {
    localStorage.setItem("owncord:settings:confirmServerSwitch", "false");
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const row = Array.from(container.querySelectorAll(".setting-row")).find(
      (r) => r.querySelector(".setting-label")?.textContent === "Ask before switching servers",
    );
    const toggle = row?.querySelector(".toggle") as HTMLElement;
    expect(toggle.classList.contains("on")).toBe(false);
    toggle.click();
    expect(localStorage.getItem("owncord:settings:confirmServerSwitch")).toBe("true");
  });

  it("renders DevTools button in Debug section", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const devtoolsBtn = Array.from(container.querySelectorAll("button.ac-btn")).find(
      (b) => b.textContent === "Open DevTools",
    );
    expect(devtoolsBtn).toBeDefined();
  });

  it("DevTools button invokes open_devtools command", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const devtoolsBtn = Array.from(container.querySelectorAll("button.ac-btn")).find(
      (b) => b.textContent === "Open DevTools",
    ) as HTMLButtonElement;

    devtoolsBtn.click();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_devtools");
    });
  });

  it("DevTools button handles invoke failure gracefully", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DevTools not supported"));

    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const devtoolsBtn = Array.from(container.querySelectorAll("button.ac-btn")).find(
      (b) => b.textContent === "Open DevTools",
    ) as HTMLButtonElement;

    // Should not throw
    devtoolsBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(invoke).toHaveBeenCalledWith("open_devtools");
  });

  it("renders section titles for Debug and Storage & Cache", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const titles = container.querySelectorAll(".settings-section-title");
    const titleTexts = Array.from(titles).map((t) => t.textContent);
    expect(titleTexts).toContain("Debug");
    expect(titleTexts).toContain("Storage & Cache");
  });

  it("shows no Debug heading or separator in a production build", () => {
    vi.stubEnv("DEV", false);
    try {
      const section = buildAdvancedTab(ac.signal);
      container.appendChild(section);

      const titleTexts = Array.from(container.querySelectorAll(".settings-section-title")).map(
        (t) => t.textContent,
      );
      // Activity (WP 8.3) sits before the cache section on the desktop build.
      expect(titleTexts).toEqual(["Activity", "Storage & Cache"]);
      expect(container.querySelectorAll(".settings-separator")).toHaveLength(2);
      expect(container.textContent).not.toContain("Open DevTools");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("makes the cache actions secondary and marks clear-and-restart destructive", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const byText = (text: string): HTMLButtonElement =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button.ac-btn")).find(
        (b) => b.textContent === text,
      )!;
    const clears = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button.ac-btn"),
    ).filter((b) => b.textContent === "Clear");
    expect(clears).toHaveLength(2);
    for (const b of clears) {
      expect(b.classList.contains("secondary")).toBe(true);
      expect(b.classList.contains("destructive")).toBe(false);
    }
    const restart = byText("Clear & Restart");
    expect(restart.classList.contains("secondary")).toBe(true);
    expect(restart.classList.contains("destructive")).toBe(true);
    expect(restart.classList.contains("ac-btn-danger")).toBe(false);
  });

  it("renders separators between sections", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const separators = container.querySelectorAll(".settings-separator");
    expect(separators.length).toBeGreaterThanOrEqual(2);
  });

  it("renders all three cache clear rows", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const labels = Array.from(container.querySelectorAll(".setting-label")).map(
      (l) => l.textContent,
    );
    expect(labels).toContain("Clear Image Cache");
    expect(labels).toContain("Clear Log Files");
    expect(labels).toContain("Clear All Cache & Restart");
  });

  it("shows image cache clear success then resets button text after timeout", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "success";
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[0] as HTMLButtonElement;

    btn.click();
    // Flush microtasks for indexedDB mock
    await vi.advanceTimersByTimeAsync(0);

    expect(btn.textContent).toBe("Cleared!");
    expect(btn.getAttribute("disabled")).toBe("");

    // After 2 seconds, should reset
    await vi.advanceTimersByTimeAsync(2000);
    expect(btn.textContent).toBe("Clear");
    expect(btn.getAttribute("disabled")).toBeNull();
    vi.useRealTimers();
  });

  it("shows image cache clear failure then resets button text after timeout", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "error";
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[0] as HTMLButtonElement;

    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(btn.textContent).toBe("Failed");

    await vi.advanceTimersByTimeAsync(2000);
    expect(btn.textContent).toBe("Clear");
    vi.useRealTimers();
  });

  it("shows log clear success then resets button text after timeout", async () => {
    vi.useFakeTimers();
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[1] as HTMLButtonElement;

    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(btn.textContent).toBe("Cleared!");

    await vi.advanceTimersByTimeAsync(2000);
    expect(btn.textContent).toBe("Clear");
    vi.useRealTimers();
  });

  it("confirmation dialog resets after 3s timeout without second click", async () => {
    vi.useFakeTimers();
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const buttons = container.querySelectorAll("button.ac-btn");
    const btn = Array.from(buttons).find(
      (b) => b.textContent === "Clear & Restart",
    ) as HTMLButtonElement;

    btn.click();
    expect(btn.textContent).toBe("Are you sure? Click again");
    expect(btn.classList.contains("ac-btn-danger")).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(btn.textContent).toBe("Clear & Restart");
    expect(btn.classList.contains("ac-btn-danger")).toBe(false);
    vi.useRealTimers();
  });

  it("Clear All shows Failed when relaunch fails", async () => {
    mockRelaunch.mockRejectedValue(new Error("Relaunch not supported"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const buttons = container.querySelectorAll("button.ac-btn");
    const btn = Array.from(buttons).find(
      (b) => b.textContent === "Clear & Restart",
    ) as HTMLButtonElement;

    btn.click();
    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Failed");
    });
    expect(btn.classList.contains("ac-btn-danger")).toBe(false);
  });

  it("deletes only .jsonl files when clearing log files, skips directories", async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: "app.jsonl", isDirectory: false },
      { name: "old.jsonl", isDirectory: false },
      { name: "subdir", isDirectory: true },
      { name: "readme.txt", isDirectory: false },
    ]);
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
    // Should have removed only the 2 .jsonl files
    expect(mockRemove).toHaveBeenCalledTimes(2);
  });

  it("treats ENOENT as missing-path (no throw)", async () => {
    mockReadDir.mockRejectedValueOnce(new Error("ENOENT: no such file"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("treats 'cannot find the path' as missing-path (no throw)", async () => {
    mockReadDir.mockRejectedValueOnce(new Error("cannot find the path"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("treats 'os error 2' as missing-path (no throw)", async () => {
    mockReadDir.mockRejectedValueOnce(new Error("os error 2"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("treats non-Error throw as missing-path when message matches pattern", async () => {
    mockReadDir.mockRejectedValueOnce("not found");
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("handles double onblocked without error", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "blocked-double";
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[0] as HTMLButtonElement;

    btn.click();
    await vi.advanceTimersByTimeAsync(1000);

    // Should still fail from the first blocked timer
    expect(btn.textContent).toBe("Failed");
    vi.useRealTimers();
  });

  it("handles success followed by blocked (settled guard)", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "success-then-blocked";
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[0] as HTMLButtonElement;

    btn.click();
    // Flush microtask for the initial promise resolution (onsuccess fires)
    await vi.advanceTimersByTimeAsync(0);
    // Flush the setTimeout(onblocked, 0)
    await vi.advanceTimersByTimeAsync(0);
    // Flush the blocked timer (1000ms) which calls finish() but should find settled=true
    await vi.advanceTimersByTimeAsync(1000);

    // Should succeed because onsuccess fired first; blocked timer callback is a no-op
    expect(btn.textContent).toBe("Cleared!");
    vi.useRealTimers();
  });

  it("DevTools handles non-Error rejection gracefully", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce("string rejection");

    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const devtoolsBtn = Array.from(container.querySelectorAll("button.ac-btn")).find(
      (b) => b.textContent === "Open DevTools",
    ) as HTMLButtonElement;

    // Should not throw
    devtoolsBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(invoke).toHaveBeenCalledWith("open_devtools");
  });
});

describe("AdvancedTab — Launch on Login (autostart)", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockIsEnabled.mockReset().mockResolvedValue(false);
    mockEnable.mockReset().mockResolvedValue(undefined);
    mockDisable.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
  });

  function getAutostartToggle(): HTMLElement {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const rows = Array.from(container.querySelectorAll(".setting-row"));
    const row = rows.find(
      (r) => r.querySelector(".setting-label")?.textContent === "Launch on Login",
    );
    expect(row).toBeDefined();
    return row!.querySelector(".toggle") as HTMLElement;
  }

  async function tick(times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it("keeps the toggle ON when the user enables autostart before the init read-back resolves", async () => {
    let resolveIsEnabled!: (v: boolean) => void;
    const isEnabledPromise = new Promise<boolean>((r) => {
      resolveIsEnabled = r;
    });
    mockIsEnabled.mockReturnValueOnce(isEnabledPromise);

    const toggle = getAutostartToggle();

    // Let the init IIFE's dynamic import resolve and its isEnabled() call get
    // issued, but don't resolve it yet — this is the window the finding
    // describes.
    await tick(2);

    // User clicks during that window: turns autostart ON.
    toggle.click();
    expect(toggle.classList.contains("on")).toBe(true);

    // Let the click's own async chain (dynamic import + enable()) fully
    // resolve, so the OS-level write really has completed.
    await tick(3);
    expect(mockEnable).toHaveBeenCalledTimes(1);

    // Now the stale init read finally resolves with the pre-click value.
    resolveIsEnabled(false);
    await tick(3);

    // The click already turned autostart on for real — the late, stale read
    // must not clobber that visual/state.
    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("still applies a fresh init read-back when the user hasn't touched the toggle", async () => {
    mockIsEnabled.mockResolvedValueOnce(true);

    const toggle = getAutostartToggle();
    await tick(3);

    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("still reverts the toggle when the OS write itself fails", async () => {
    mockEnable.mockRejectedValueOnce(new Error("not permitted"));

    const toggle = getAutostartToggle();
    await tick(3);

    toggle.click();
    await tick(3);

    expect(toggle.classList.contains("on")).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

describe("AdvancedTab — Close to Tray and Start Minimized", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();
  const NATIVE_PREFS = { minimizeToTray: true, startMinimized: false };

  type InvokeMock = ReturnType<typeof vi.fn>;
  let invokeMock: InvokeMock;
  let setCalls: Array<{ pref: string; enabled: boolean }>;
  let failSets: boolean;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const { invoke } = await import("@tauri-apps/api/core");
    invokeMock = invoke as InvokeMock;
    setCalls = [];
    failSets = false;
    invokeMock.mockReset().mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_window_prefs") return NATIVE_PREFS;
      if (cmd === "set_window_pref") {
        if (failSets) throw new Error("not saved");
        setCalls.push(args as { pref: string; enabled: boolean });
      }
      return undefined;
    });
    mockIsEnabled.mockReset().mockResolvedValue(false);
    mockEnable.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
    invokeMock.mockReset().mockResolvedValue(undefined);
  });

  async function tick(times = 4): Promise<void> {
    for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
  }

  function row(label: string): HTMLElement | undefined {
    return Array.from(container.querySelectorAll<HTMLElement>(".setting-row")).find(
      (r) => r.querySelector(".setting-label")?.textContent === label,
    );
  }

  function mount(): void {
    container.appendChild(buildAdvancedTab(ac.signal));
  }

  it("shows both rows with the values the host reports", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "get_window_prefs" ? { minimizeToTray: false, startMinimized: true } : undefined,
    );
    mount();
    await tick();

    expect(row("Close to Tray")?.querySelector(".toggle")?.classList.contains("on")).toBe(false);
    expect(row("Start Minimized")?.querySelector(".toggle")?.classList.contains("on")).toBe(true);
  });

  it("removes both rows when the host cannot answer", async () => {
    invokeMock.mockRejectedValue(new Error("no host"));
    mount();
    await tick();

    expect(row("Close to Tray")).toBeUndefined();
    expect(row("Start Minimized")).toBeUndefined();
  });

  it("saves a Close to Tray change through set_window_pref", async () => {
    mount();
    await tick();
    (row("Close to Tray")!.querySelector(".toggle") as HTMLElement).click();
    await tick();

    expect(setCalls).toEqual([{ pref: "minimizeToTray", enabled: false }]);
  });

  it("puts the toggle back when the host cannot save the change", async () => {
    mount();
    await tick();
    failSets = true;
    const toggle = row("Close to Tray")!.querySelector(".toggle") as HTMLElement;
    toggle.click();
    await tick();

    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps a click made before the first read comes back", async () => {
    let release!: (v: unknown) => void;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "get_window_prefs"
        ? new Promise((r) => {
            release = r;
          })
        : Promise.resolve(undefined),
    );
    mount();
    await tick();
    const toggle = row("Close to Tray")!.querySelector(".toggle") as HTMLElement;
    toggle.click();
    await tick();
    release({ minimizeToTray: true, startMinimized: false });
    await tick();

    expect(toggle.classList.contains("on")).toBe(false);
  });

  it("lets a late read apply after a click made before it failed to save", async () => {
    let release!: (v: unknown) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_window_prefs") {
        return new Promise((r) => {
          release = r;
        });
      }
      return cmd === "set_window_pref" ? Promise.reject(new Error("not saved")) : Promise.resolve();
    });
    mount();
    await tick();
    const toggle = row("Close to Tray")!.querySelector(".toggle") as HTMLElement;
    toggle.click();
    await tick();
    // Back to what was shown before the click.
    expect(toggle.classList.contains("on")).toBe(true);
    release({ minimizeToTray: false, startMinimized: false });
    await tick();

    expect(toggle.classList.contains("on")).toBe(false);
  });

  it("refreshes the login entry when Start Minimized turns on while Launch on Login is on", async () => {
    mockIsEnabled.mockResolvedValue(true);
    mount();
    await tick();
    mockEnable.mockClear();
    (row("Start Minimized")!.querySelector(".toggle") as HTMLElement).click();
    await tick(6);

    expect(setCalls).toEqual([{ pref: "startMinimized", enabled: true }]);
    expect(mockEnable).toHaveBeenCalledTimes(1);
  });

  it("leaves the login entry alone when Launch on Login is off", async () => {
    mount();
    await tick();
    (row("Start Minimized")!.querySelector(".toggle") as HTMLElement).click();
    await tick(6);

    expect(mockEnable).not.toHaveBeenCalled();
  });
});
