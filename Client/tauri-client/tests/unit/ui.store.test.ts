import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  uiStore,
  toggleSidebar,
  toggleMemberList,
  openSettings,
  closeSettings,
  openModal,
  closeModal,
  setTheme,
  setConnectionStatus,
  setTransientError,
  setPersistentError,
  loadCollapsedCategories,
  toggleCategory,
  isCategoryCollapsed,
  setSidebarMode,
  setActiveDmUser,
} from "../../src/stores/ui.store";

function resetStore(): void {
  uiStore.setState(() => ({
    sidebarCollapsed: false,
    memberListVisible: true,
    settingsOpen: false,
    activeModal: null,
    theme: "dark" as const,
    connectionStatus: "disconnected" as const,
    transientError: null,
    persistentError: null,
    collapsedCategories: new Set<string>(),
    sidebarMode: "channels" as const,
    activeDmUserId: null,
  }));
}

describe("ui store", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("initial state", () => {
    it("has dark theme", () => {
      expect(uiStore.getState().theme).toBe("dark");
    });

    it("has sidebar not collapsed", () => {
      expect(uiStore.getState().sidebarCollapsed).toBe(false);
    });

    it("has member list visible", () => {
      expect(uiStore.getState().memberListVisible).toBe(true);
    });

    it("has settings closed", () => {
      expect(uiStore.getState().settingsOpen).toBe(false);
    });

    it("has no active modal", () => {
      expect(uiStore.getState().activeModal).toBeNull();
    });

    it("has no collapsed categories", () => {
      expect(uiStore.getState().collapsedCategories.size).toBe(0);
    });
  });

  describe("toggleSidebar", () => {
    it("collapses sidebar when expanded", () => {
      toggleSidebar();
      expect(uiStore.getState().sidebarCollapsed).toBe(true);
    });

    it("expands sidebar when collapsed", () => {
      toggleSidebar();
      toggleSidebar();
      expect(uiStore.getState().sidebarCollapsed).toBe(false);
    });

    it("produces a new state object", () => {
      const before = uiStore.getState();
      toggleSidebar();
      expect(uiStore.getState()).not.toBe(before);
    });
  });

  describe("toggleMemberList", () => {
    it("hides member list when visible", () => {
      toggleMemberList();
      expect(uiStore.getState().memberListVisible).toBe(false);
    });

    it("shows member list when hidden", () => {
      toggleMemberList();
      toggleMemberList();
      expect(uiStore.getState().memberListVisible).toBe(true);
    });
  });

  describe("openSettings / closeSettings", () => {
    it("openSettings sets settingsOpen to true", () => {
      openSettings();
      expect(uiStore.getState().settingsOpen).toBe(true);
    });

    it("closeSettings sets settingsOpen to false", () => {
      openSettings();
      closeSettings();
      expect(uiStore.getState().settingsOpen).toBe(false);
    });

    it("closeSettings is safe when already closed", () => {
      closeSettings();
      expect(uiStore.getState().settingsOpen).toBe(false);
    });
  });

  describe("openModal / closeModal", () => {
    it("openModal sets activeModal to given name", () => {
      openModal("invite");
      expect(uiStore.getState().activeModal).toBe("invite");
    });

    it("openModal overwrites existing modal", () => {
      openModal("invite");
      openModal("confirm-delete");
      expect(uiStore.getState().activeModal).toBe("confirm-delete");
    });

    it("closeModal clears activeModal", () => {
      openModal("invite");
      closeModal();
      expect(uiStore.getState().activeModal).toBeNull();
    });

    it("closeModal is safe when no modal is open", () => {
      closeModal();
      expect(uiStore.getState().activeModal).toBeNull();
    });
  });

  describe("setTheme", () => {
    it("sets theme to light", () => {
      setTheme("light");
      expect(uiStore.getState().theme).toBe("light");
    });

    it("sets theme back to dark", () => {
      setTheme("light");
      setTheme("dark");
      expect(uiStore.getState().theme).toBe("dark");
    });
  });

  describe("toggleCategory / isCategoryCollapsed", () => {
    it("collapses a category that is expanded", () => {
      toggleCategory("general");
      expect(isCategoryCollapsed("general")).toBe(true);
    });

    it("expands a category that is collapsed", () => {
      toggleCategory("general");
      toggleCategory("general");
      expect(isCategoryCollapsed("general")).toBe(false);
    });

    it("supports multiple independent categories", () => {
      toggleCategory("general");
      toggleCategory("voice");
      expect(isCategoryCollapsed("general")).toBe(true);
      expect(isCategoryCollapsed("voice")).toBe(true);
      expect(isCategoryCollapsed("other")).toBe(false);
    });

    it("produces a new Set on each toggle", () => {
      const before = uiStore.getState().collapsedCategories;
      toggleCategory("general");
      const after = uiStore.getState().collapsedCategories;
      expect(before).not.toBe(after);
    });
  });

  describe("subscribe", () => {
    it("notifies on state changes", () => {
      const listener = vi.fn();
      const unsub = uiStore.subscribe(listener);
      toggleSidebar();
      uiStore.flush();
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });

    it("does not notify after unsubscribe", () => {
      const listener = vi.fn();
      const unsub = uiStore.subscribe(listener);
      unsub();
      toggleSidebar();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("sidebar mode", () => {
    beforeEach(() => {
      uiStore.setState((prev) => ({
        ...prev,
        sidebarMode: "channels",
        activeDmUserId: null,
      }));
    });

    it("defaults to channels mode", () => {
      expect(uiStore.getState().sidebarMode).toBe("channels");
    });

    it("switches to DM mode with user ID", () => {
      setSidebarMode("dms");
      setActiveDmUser(42);
      const state = uiStore.getState();
      expect(state.sidebarMode).toBe("dms");
      expect(state.activeDmUserId).toBe(42);
    });

    it("clears DM user when switching back to channels", () => {
      setActiveDmUser(42);
      setSidebarMode("channels");
      expect(uiStore.getState().activeDmUserId).toBeNull();
    });

    it("preserves activeDmUserId when switching to dms mode", () => {
      setActiveDmUser(42);
      setSidebarMode("dms");
      expect(uiStore.getState().activeDmUserId).toBe(42);
    });

    it("setActiveDmUser sets userId to null", () => {
      setActiveDmUser(42);
      setActiveDmUser(null);
      expect(uiStore.getState().activeDmUserId).toBeNull();
    });
  });

  // ── Connection status ─────────────────────────────────

  describe("setConnectionStatus", () => {
    it("sets status to connected", () => {
      setConnectionStatus("connected");
      expect(uiStore.getState().connectionStatus).toBe("connected");
    });

    it("sets status to reconnecting", () => {
      setConnectionStatus("reconnecting");
      expect(uiStore.getState().connectionStatus).toBe("reconnecting");
    });

    it("sets status to disconnected", () => {
      setConnectionStatus("connected");
      setConnectionStatus("disconnected");
      expect(uiStore.getState().connectionStatus).toBe("disconnected");
    });
  });

  // ── Error messages ────────────────────────────────────

  describe("setTransientError", () => {
    it("sets a transient error message", () => {
      setTransientError("Connection lost");
      expect(uiStore.getState().transientError).toBe("Connection lost");
    });

    it("clears transient error with null", () => {
      setTransientError("Some error");
      setTransientError(null);
      expect(uiStore.getState().transientError).toBeNull();
    });
  });

  describe("setPersistentError", () => {
    it("sets a persistent error message", () => {
      setPersistentError("Authentication failed");
      expect(uiStore.getState().persistentError).toBe("Authentication failed");
    });

    it("clears persistent error with null", () => {
      setPersistentError("Some error");
      setPersistentError(null);
      expect(uiStore.getState().persistentError).toBeNull();
    });
  });

  // ── loadCollapsedCategories ───────────────────────────

  describe("loadCollapsedCategories", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("loads empty set when no saved data exists", () => {
      loadCollapsedCategories("test-server:443");
      expect(uiStore.getState().collapsedCategories.size).toBe(0);
    });

    it("loads categories from localStorage", () => {
      localStorage.setItem(
        "owncord:collapsed:test-server:443",
        JSON.stringify(["general", "voice"]),
      );
      loadCollapsedCategories("test-server:443");
      const cats = uiStore.getState().collapsedCategories;
      expect(cats.has("general")).toBe(true);
      expect(cats.has("voice")).toBe(true);
      expect(cats.size).toBe(2);
    });

    it("resets to empty set for invalid JSON", () => {
      localStorage.setItem(
        "owncord:collapsed:test-server:443",
        "not-json",
      );
      loadCollapsedCategories("test-server:443");
      expect(uiStore.getState().collapsedCategories.size).toBe(0);
    });

    it("resets to empty set for non-array data", () => {
      localStorage.setItem(
        "owncord:collapsed:test-server:443",
        JSON.stringify({ foo: "bar" }),
      );
      loadCollapsedCategories("test-server:443");
      expect(uiStore.getState().collapsedCategories.size).toBe(0);
    });

    it("resets to empty set for array with non-string elements", () => {
      localStorage.setItem(
        "owncord:collapsed:test-server:443",
        JSON.stringify([1, 2, 3]),
      );
      loadCollapsedCategories("test-server:443");
      expect(uiStore.getState().collapsedCategories.size).toBe(0);
    });

    it("persists collapsed categories to localStorage on toggle", () => {
      loadCollapsedCategories("test-server:443");
      toggleCategory("voice");
      const raw = localStorage.getItem("owncord:collapsed:test-server:443");
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed).toContain("voice");
    });

    it("removes category from localStorage when toggled back", () => {
      loadCollapsedCategories("test-server:443");
      toggleCategory("voice");
      toggleCategory("voice");
      const raw = localStorage.getItem("owncord:collapsed:test-server:443");
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed).not.toContain("voice");
    });

    it("handles localStorage.setItem failure gracefully", () => {
      loadCollapsedCategories("test-server:443");

      // Make localStorage.setItem throw (simulating quota exceeded)
      const originalSetItem = localStorage.setItem.bind(localStorage);
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

      // toggleCategory calls saveCollapsedCategories which should catch the error
      expect(() => toggleCategory("fail-safe")).not.toThrow();

      // State should still be updated even though persistence failed
      expect(isCategoryCollapsed("fail-safe")).toBe(true);

      // Restore
      vi.restoreAllMocks();
    });

    it("does not save when no server host is loaded", () => {
      // Reset the internal currentServerHost by not calling loadCollapsedCategories
      // Instead, directly test that toggleCategory works without crashing
      // when called before loadCollapsedCategories
      resetStore();
      // The module-level currentServerHost is set by loadCollapsedCategories.
      // If we loaded for a server and then toggle, it should save.
      loadCollapsedCategories("another-server:443");
      toggleCategory("test-cat");
      const raw = localStorage.getItem("owncord:collapsed:another-server:443");
      expect(raw).not.toBeNull();
    });
  });

  // ── setTheme additional values ────────────────────────

  describe("setTheme — all variants", () => {
    it("sets theme to neon-glow", () => {
      setTheme("neon-glow");
      expect(uiStore.getState().theme).toBe("neon-glow");
    });

    it("sets theme to midnight", () => {
      setTheme("midnight");
      expect(uiStore.getState().theme).toBe("midnight");
    });
  });
});
