import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockReadDir,
  mockRemove,
  mockRelaunch,
  mockClearPendingPersistedLogs,
  mockClearAttachmentCaches,
  mockClearEmbedCaches,
  mockClearMediaCaches,
  deleteDbState,
} = vi.hoisted(() => ({
  mockReadDir: vi.fn().mockResolvedValue([]),
  mockRemove: vi.fn().mockResolvedValue(undefined),
  mockRelaunch: vi.fn().mockResolvedValue(undefined),
  mockClearPendingPersistedLogs: vi.fn(),
  mockClearAttachmentCaches: vi.fn(),
  mockClearEmbedCaches: vi.fn(),
  mockClearMediaCaches: vi.fn(),
  deleteDbState: { mode: "success" as "success" | "blocked-then-success" | "blocked-stuck" | "error" },
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

vi.mock("@components/message-list/attachments", () => ({
  clearAttachmentCaches: mockClearAttachmentCaches,
}));

vi.mock("@components/message-list/embeds", () => ({
  clearEmbedCaches: mockClearEmbedCaches,
}));

vi.mock("@components/message-list/media", () => ({
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
  });

  afterEach(() => {
    container.remove();
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
    const btn = Array.from(buttons).find(
      (b) => b.textContent === label,
    ) as HTMLButtonElement;
    expect(btn).toBeDefined();
    return btn;
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it("preserves owncord:profiles after Clear All Cache", async () => {
    localStorage.setItem("owncord:profiles", JSON.stringify([{ name: "Local", host: "localhost" }]));
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
    localStorage.setItem("owncord:theme:custom:custom-sunrise", JSON.stringify({ name: "custom-sunrise" }));
    localStorage.setItem("owncord:settings:accentColor", '"#00c8ff"');

    const btn = getClearAllBtn();

    btn.click();
    btn.click();
    await flush();

    expect(localStorage.getItem("owncord:theme:active")).toBe("custom-sunrise");
    expect(localStorage.getItem("owncord:theme:custom:custom-sunrise")).not.toBeNull();
    expect(localStorage.getItem("owncord:settings:accentColor")).toBeNull();
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
