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
  toggleCategory,
  isCategoryCollapsed,
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
});
