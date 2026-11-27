import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUDDIES_COLLAPSED_PREF,
  createCollapsedGroups,
} from "../../../src/features/members/buddies/collapsedGroups";
import { STORAGE_PREFIX } from "@lib/prefs/preferences";
import type { UserStatus } from "@lib/types";
import { makeMember, setTestMembers } from "../../helpers/memberListHarness";
import { resetMembersState } from "../../helpers/storeResets";

const KEY = STORAGE_PREFIX + BUDDIES_COLLAPSED_PREF;
const stored = (): unknown => JSON.parse(localStorage.getItem(KEY) ?? "null");

/** A `storage` event as another window's save fires it here. */
function otherWindowSaves(value: unknown): void {
  const newValue = JSON.stringify(value);
  localStorage.setItem(KEY, newValue);
  window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue }));
}

describe("createCollapsedGroups", () => {
  let owner: AbortController;

  beforeEach(() => {
    localStorage.removeItem(KEY);
    owner = new AbortController();
  });
  afterEach(() => {
    owner.abort();
    vi.restoreAllMocks();
    localStorage.removeItem(KEY);
  });

  it("starts with no group folded", () => {
    expect([...createCollapsedGroups().read()]).toEqual([]);
    expect(BUDDIES_COLLAPSED_PREF).toBe("buddiesCollapsed");
  });

  it("drops unknown keys and duplicates on read, and rewrites only on the next toggle", () => {
    const raw = JSON.stringify(["a:offline", "admin", "a:offline", 3, "a:game"]);
    localStorage.setItem(KEY, raw);
    const groups = createCollapsedGroups();
    expect([...groups.read()].sort()).toEqual(["a:game", "a:offline"]);
    expect(localStorage.getItem(KEY)).toBe(raw);
    groups.toggle("a:game");
    expect(stored()).toEqual(["a:offline"]);
  });

  it("reads a stored value that is not a list as none folded", () => {
    localStorage.setItem(KEY, JSON.stringify({ "a:game": true }));
    expect(createCollapsedGroups().read().size).toBe(0);
  });

  it("round-trips through the pref: a new instance reads what a toggle saved", () => {
    const groups = createCollapsedGroups();
    groups.toggle("a:offline");
    groups.toggle("a:away");
    expect(stored()).toEqual(["a:offline", "a:away"]);
    expect([...createCollapsedGroups().read()].sort()).toEqual(["a:away", "a:offline"]);
    groups.toggle("a:offline");
    expect(stored()).toEqual(["a:away"]);
  });

  it("returns a new Set object only when the set changes", () => {
    const groups = createCollapsedGroups();
    const first = groups.read();
    expect(groups.read()).toBe(first);
    groups.toggle("a:dnd");
    const second = groups.read();
    expect(second).not.toBe(first);
    expect(second.has("a:dnd")).toBe(true);
    expect(first.has("a:dnd")).toBe(false);
    groups.subscribe(owner.signal, () => undefined);
    expect(groups.read()).toBe(second);
  });

  it("still folds in memory when the save fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const groups = createCollapsedGroups();
    const onChange = vi.fn();
    groups.subscribe(owner.signal, onChange);
    groups.toggle("a:online");
    expect(groups.read().has("a:online")).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("one toggle calls onChange exactly once, before the save", () => {
    const groups = createCollapsedGroups();
    let savedFirst: unknown = "unread";
    const onChange = vi.fn(() => {
      savedFirst = stored();
    });
    groups.subscribe(owner.signal, onChange);
    groups.toggle("a:game");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(savedFirst).toBeNull();
  });

  it("takes another window's save, and ignores one that changes nothing", () => {
    const groups = createCollapsedGroups();
    const onChange = vi.fn();
    groups.subscribe(owner.signal, onChange);
    const before = groups.read();
    otherWindowSaves([]);
    window.dispatchEvent(new StorageEvent("storage", { key: "owncord:settings:fontSize" }));
    expect(groups.read()).toBe(before);
    expect(onChange).not.toHaveBeenCalled();

    otherWindowSaves(["a:dnd"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect([...groups.read()]).toEqual(["a:dnd"]);
    const after = groups.read();
    otherWindowSaves(["a:dnd", "a:dnd"]);
    expect(groups.read()).toBe(after);
    expect(onChange).toHaveBeenCalledTimes(1);

    // A cleared storage (a null key) opens every group.
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(groups.read().size).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("subscribe takes a save made since construction, and says so", () => {
    const groups = createCollapsedGroups();
    localStorage.setItem(KEY, JSON.stringify(["a:away"]));
    const onChange = vi.fn();
    groups.subscribe(owner.signal, onChange);
    expect([...groups.read()]).toEqual(["a:away"]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("subscribe with nothing new saved stays silent", () => {
    const groups = createCollapsedGroups();
    const onChange = vi.fn();
    groups.subscribe(owner.signal, onChange);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops listening when its owner ends", () => {
    const groups = createCollapsedGroups();
    const onChange = vi.fn();
    groups.subscribe(owner.signal, onChange);
    owner.abort();
    groups.toggle("a:game");
    otherWindowSaves(["a:dnd"]);
    expect(onChange).not.toHaveBeenCalled();
    expect([...groups.read()]).toEqual(["a:game"]);
  });

  describe("groupOf", () => {
    beforeEach(() => resetMembersState());

    it.each([
      ["online", true, "a:game"],
      ["idle", true, "a:game"],
      ["dnd", true, "a:game"],
      ["online", false, "a:online"],
      ["idle", false, "a:away"],
      ["dnd", false, "a:dnd"],
      ["offline", true, "a:offline"],
      ["invisible", false, "a:offline"],
    ] as const)("%s with a game: %s is in %s", (status: UserStatus, game, key) => {
      setTestMembers([
        makeMember({
          id: 7,
          username: "gil",
          status,
          activity: game ? { name: "Chess", startedAt: 1 } : null,
        }),
      ]);
      expect(createCollapsedGroups().groupOf(7)).toBe(key);
    });

    it("is null for a member who is not listed", () => {
      setTestMembers([]);
      expect(createCollapsedGroups().groupOf(7)).toBeNull();
    });
  });
});
