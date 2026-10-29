import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collapseCategories,
  loadCollapsedCategories,
  migrateCollapsedCategoryNames,
  setConnectionStatus,
  setSessionReplaced,
  toggleCategory,
  uiStore,
} from "@stores/ui.store";
import { listSessionResets, runSessionResets } from "@lib/sessionRegistry";

const KEY = "owncord:collapsed:srv:443";

function stored(key = KEY): unknown {
  const raw = localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

function collapsedKeys(): string[] {
  return Object.keys(localStorage).filter((k) => k.startsWith("owncord:collapsed:"));
}

describe("ui store as the app starts", () => {
  // Reads the module's own starting state: nothing may have touched the store yet.
  it("starts with settings closed, the connection down and no flags raised", () => {
    const state = uiStore.getState();
    expect(state.settingsOpen).toBe(false);
    expect(state.connectionStatus).toBe("disconnected");
    expect(state.connectionDialFailed).toBe(false);
    expect(state.sessionReplaced).toBe(false);
    expect(state.transientError).toBeNull();
    expect(state.updateRequiredHost).toBeNull();
    expect(state.sidebarMode).toBe("channels");
    expect(state.activeDmUserId).toBeNull();
    expect(state.activeView).toBeNull();
    expect(state.settingsTab).toBeNull();
    expect(state.collapsedCategories.size).toBe(0);
  });

  it("registers its session reset", () => {
    expect(listSessionResets()).toContain("ui:session");
  });
});

describe("connection status", () => {
  afterEach(() => {
    setConnectionStatus("disconnected");
    setSessionReplaced(false);
  });

  it("clears the dial-failed flag unless the caller says a dial failed", () => {
    setConnectionStatus("reconnecting", true);
    expect(uiStore.getState().connectionDialFailed).toBe(true);
    setConnectionStatus("reconnecting");
    expect(uiStore.getState().connectionDialFailed).toBe(false);
  });

  it("keeps the replaced flag until a live connection makes this device the one in use", () => {
    setSessionReplaced(true);
    setConnectionStatus("reconnecting");
    expect(uiStore.getState().sessionReplaced).toBe(true);
    setConnectionStatus("disconnected");
    expect(uiStore.getState().sessionReplaced).toBe(true);
    setConnectionStatus("connected");
    expect(uiStore.getState().sessionReplaced).toBe(false);
  });

  it("does not raise the replaced flag by connecting", () => {
    setConnectionStatus("connected");
    expect(uiStore.getState().sessionReplaced).toBe(false);
  });
});

describe("collapsed categories storage", () => {
  beforeEach(() => {
    localStorage.clear();
    runSessionResets("user");
  });

  it("writes nothing before a server has been loaded", () => {
    toggleCategory("Text");
    collapseCategories(["Voice"]);
    expect(collapsedKeys()).toEqual([]);
    expect([...uiStore.getState().collapsedCategories].toSorted()).toEqual(["Text", "Voice"]);
  });

  it("saves a toggle under the server's own key", () => {
    loadCollapsedCategories("srv:443");
    toggleCategory("Text");
    expect(stored()).toEqual(["Text"]);
    toggleCategory("Text");
    expect(stored()).toEqual([]);
  });

  it("collapses several categories at once and saves them", () => {
    loadCollapsedCategories("srv:443");
    toggleCategory("Text");
    collapseCategories(["Voice", "cat:2", "Text"]);
    expect([...uiStore.getState().collapsedCategories].toSorted()).toEqual([
      "Text",
      "Voice",
      "cat:2",
    ]);
    expect((stored() as string[]).toSorted()).toEqual(["Text", "Voice", "cat:2"]);
  });

  it("loads what was saved for the server", () => {
    localStorage.setItem(KEY, JSON.stringify(["a", "b"]));
    loadCollapsedCategories("srv:443");
    expect([...uiStore.getState().collapsedCategories]).toEqual(["a", "b"]);
  });

  it("loads nothing when the saved list holds anything but strings", () => {
    localStorage.setItem(KEY, JSON.stringify(["a", 5]));
    loadCollapsedCategories("srv:443");
    expect(uiStore.getState().collapsedCategories.size).toBe(0);
    localStorage.setItem(KEY, JSON.stringify([5, "a"]));
    loadCollapsedCategories("srv:443");
    expect(uiStore.getState().collapsedCategories.size).toBe(0);
  });

  it("stops saving once the session is reset, until a server is loaded again", () => {
    loadCollapsedCategories("srv:443");
    toggleCategory("Text");
    runSessionResets("user");
    expect(uiStore.getState().collapsedCategories.size).toBe(0);
    toggleCategory("Voice");
    expect(stored()).toEqual(["Text"]);
  });

  it("resets the sidebar to the channel list", () => {
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms", activeDmUserId: 9 }));
    runSessionResets("user");
    expect(uiStore.getState().sidebarMode).toBe("channels");
    expect(uiStore.getState().activeDmUserId).toBeNull();
  });
});

describe("migrating collapsed category names", () => {
  beforeEach(() => {
    localStorage.clear();
    runSessionResets("user");
    loadCollapsedCategories("srv:443");
  });

  it("rewrites a collapsed name to its category key and saves the new list", () => {
    collapseCategories(["Text", "Voice"]);
    migrateCollapsedCategoryNames(new Map([["Text", "cat:3"]]));
    expect([...uiStore.getState().collapsedCategories].toSorted()).toEqual(["Voice", "cat:3"]);
    expect((stored() as string[]).toSorted()).toEqual(["Voice", "cat:3"]);
  });

  it("leaves the set and the saved list alone when nothing translates", () => {
    collapseCategories(["Text"]);
    const before = uiStore.getState().collapsedCategories;
    localStorage.setItem(KEY, JSON.stringify(["marker"]));
    migrateCollapsedCategoryNames(new Map([["Other", "cat:9"]]));
    expect(uiStore.getState().collapsedCategories).toBe(before);
    expect(stored()).toEqual(["marker"]);
  });

  it("leaves an entry alone when its key is the name itself", () => {
    collapseCategories(["Text"]);
    const before = uiStore.getState().collapsedCategories;
    localStorage.setItem(KEY, JSON.stringify(["marker"]));
    migrateCollapsedCategoryNames(new Map([["Text", "Text"]]));
    expect(uiStore.getState().collapsedCategories).toBe(before);
    expect(stored()).toEqual(["marker"]);
  });
});
