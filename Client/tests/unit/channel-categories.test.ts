/** Real categories, client half (WP 6.5b): grouping and order, collapse by id, the header menu, reorder. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@lib/voice/livekitSession", () => ({ rePinPeerIdentity: vi.fn() }));
vi.mock("@lib/net/e2eeCrypto", () => ({
  importIdentityPublicKey: vi.fn(),
  computeKeyFingerprint: vi.fn(),
}));

import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import {
  categoryGroups,
  channelsStore,
  getChannelsByCategory,
  getKnownCategories,
  resetChannelsStore,
  setCategories,
  setChannels,
  updateChannel,
} from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { authStore } from "../../src/stores/auth.store";
import {
  isCategoryCollapsed,
  loadCollapsedCategories,
  toggleCategory,
  uiStore,
} from "../../src/stores/ui.store";
import { voiceStore } from "../../src/stores/voice.store";
import { channelGroups } from "../../src/features/channels/channelRowModel";
import { visibleCategories } from "../../src/lib/permissions";
import { migrateCollapsedToCategoryIds } from "../../src/features/channels/collapsedMigration";
import {
  CATEGORY_LIST_STALE,
  CATEGORY_NAME_TAKEN,
  canMoveCategory,
  createCategory,
  moveCategory,
  placeCategory,
  type CategoryApi,
} from "../../src/features/channels/categoryActions";
import { ApiClientError } from "@lib/api";
import type { ReadyChannel } from "../../src/lib/types";
import { resetMembersState } from "../helpers/storeResets";
import { signInAs } from "../helpers/storeSeeds";

type Row = Partial<ReadyChannel> & Pick<ReadyChannel, "id" | "name" | "type" | "position">;

function ch(row: Row, category: string | null = null): ReadyChannel {
  return { category, ...row };
}

function keys(): (string | null)[] {
  return [...getChannelsByCategory([]).keys()];
}

beforeEach(() => {
  resetChannelsStore();
});

describe("grouping and order (D7)", () => {
  it("orders uncategorized text, the Voice group, then categories by (position, id)", () => {
    setChannels([
      ch(
        { id: 1, name: "z-games", type: "text", position: 0, category_id: 9, category_position: 2 },
        "Games",
      ),
      ch({ id: 2, name: "lounge", type: "voice", position: 1 }),
      ch({ id: 3, name: "general", type: "text", position: 5 }),
      ch(
        { id: 4, name: "chat", type: "text", position: 2, category_id: 4, category_position: 1 },
        "Chat",
      ),
      // Same category position as Chat: the id breaks the tie.
      ch(
        { id: 5, name: "news", type: "text", position: 3, category_id: 7, category_position: 1 },
        "News",
      ),
    ]);
    expect(keys()).toEqual([null, "Voice", "cat:4", "cat:7", "cat:9"]);
  });

  it("orders channels by (position, id) with text before voice inside a category", () => {
    setChannels([
      ch(
        { id: 1, name: "v", type: "voice", position: 0, category_id: 2, category_position: 0 },
        "C",
      ),
      ch(
        { id: 3, name: "b", type: "text", position: 1, category_id: 2, category_position: 0 },
        "C",
      ),
      ch(
        { id: 2, name: "a", type: "text", position: 1, category_id: 2, category_position: 0 },
        "C",
      ),
    ]);
    expect(
      getChannelsByCategory([])
        .get("cat:2")
        ?.map((c) => c.id),
    ).toEqual([2, 3, 1]);
  });

  it("falls back to name grouping when an older server sends no ids", () => {
    setChannels([
      ch({ id: 1, name: "a", type: "text", position: 0 }, "Beta"),
      ch({ id: 2, name: "b", type: "text", position: 1 }, "Alpha"),
      ch({ id: 3, name: "c", type: "text", position: 2 }, "Beta"),
      ch({ id: 4, name: "d", type: "voice", position: 3 }),
    ]);
    const groups = categoryGroups(channelsStore.getState().channels);
    // Name-only groups keep the order of their first channel, after the synthetic Voice group.
    expect(groups.map((g) => [g.key, g.name, g.categoryId])).toEqual([
      ["Voice", "Voice", 0],
      ["Beta", "Beta", 0],
      ["Alpha", "Alpha", 0],
    ]);
    expect(groups[1]?.channels.map((c) => c.id)).toEqual([1, 3]);
  });

  it("adds a manager's empty categories and trusts the list for name and position", () => {
    setChannels([
      ch(
        { id: 1, name: "a", type: "text", position: 0, category_id: 2, category_position: 5 },
        "Old name",
      ),
    ]);
    setCategories([
      { id: 8, name: "Empty", position: 0 },
      { id: 2, name: "Renamed", position: 1 },
    ]);
    const { channels, categories } = channelsStore.getState();
    const groups = categoryGroups(channels, categories);
    expect(groups.map((g) => [g.key, g.name, g.channels.length])).toEqual([
      ["cat:8", "Empty", 0],
      ["cat:2", "Renamed", 1],
    ]);
    expect(getKnownCategories(categories).map((k) => k.name)).toEqual(["Empty", "Renamed"]);
  });

  it("a non-manager derives groups from channels alone and never sees an empty one", () => {
    setChannels([
      ch(
        { id: 1, name: "a", type: "text", position: 0, category_id: 2, category_position: 0 },
        "Shown",
      ),
    ]);
    expect(channelsStore.getState().categories).toEqual([]);
    expect(keys()).toEqual(["cat:2"]);
  });

  it("edge case 1: a channel_update into a category the client has no list entry for still gets its group", () => {
    setChannels([
      ch(
        { id: 1, name: "a", type: "text", position: 0, category_id: 2, category_position: 0 },
        "Old",
      ),
      ch({ id: 2, name: "b", type: "text", position: 1 }),
    ]);
    // A non-manager: no list entry for category 9 exists or ever will.
    updateChannel({ id: 2, category: "Fresh", category_id: 9, category_position: 4 });
    const groups = categoryGroups(
      channelsStore.getState().channels,
      channelsStore.getState().categories,
    );
    expect(groups.map((g) => [g.key, g.name])).toEqual([
      ["cat:2", "Old"],
      ["cat:9", "Fresh"],
    ]);
    expect(groups[1]?.channels.map((c) => c.id)).toEqual([2]);
  });

  it("a viewer demoted mid-session drops the stale list: empty categories vanish, channel fields rule", () => {
    setChannels([
      ch(
        { id: 1, name: "a", type: "text", position: 0, category_id: 2, category_position: 5 },
        "Real name",
      ),
      ch(
        { id: 2, name: "b", type: "text", position: 1, category_id: 3, category_position: 6 },
        "Other",
      ),
    ]);
    setCategories([
      { id: 3, name: "Stale other", position: 0 },
      { id: 2, name: "Stale name", position: 1 },
      { id: 4, name: "Empty", position: 2 },
    ]);
    const { channels, roles } = channelsStore.getState();
    const list = (selfRole: string) => ({
      channels,
      roles,
      selfRole,
      categories: channelsStore.getState().categories,
    });
    // Still a manager: the list wins and the empty category shows.
    expect(channelGroups(list("owner")).map((g) => [g.key, g.name])).toEqual([
      ["cat:3", "Stale other"],
      ["cat:2", "Stale name"],
      ["cat:4", "Empty"],
    ]);
    // Demoted: the same store still holds the list, but it no longer counts.
    expect(channelGroups(list("member")).map((g) => [g.key, g.name])).toEqual([
      ["cat:2", "Real name"],
      ["cat:3", "Other"],
    ]);
    signInAs({ id: 2, username: "Me", avatar: null, role: "member" }, { serverName: "S" });
    expect(visibleCategories()).toEqual([]);
    expect(getKnownCategories(visibleCategories()).map((k) => k.name)).toEqual([
      "Real name",
      "Other",
    ]);
    expect([...getChannelsByCategory(visibleCategories()).keys()]).toEqual(["cat:2", "cat:3"]);
  });

  it("a reconnect's ready restates the list wholesale", () => {
    setCategories([{ id: 1, name: "A", position: 0 }]);
    setCategories([]);
    expect(channelsStore.getState().categories).toEqual([]);
  });
});

describe("collapse state follows the category id", () => {
  beforeEach(() => {
    localStorage.clear();
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
  });

  const games = (name: string): ReadyChannel[] => [
    ch({ id: 1, name: "a", type: "text", position: 0, category_id: 5, category_position: 0 }, name),
  ];

  it("translates saved names to ids once the channel list arrives, then rewrites the save", () => {
    localStorage.setItem("owncord:collapsed:host", JSON.stringify(["Games", "Voice", "Gone"]));
    loadCollapsedCategories("host");
    // Nothing to translate against yet.
    expect(migrateCollapsedToCategoryIds()).toBe(false);
    setChannels(games("Games"));
    expect(migrateCollapsedToCategoryIds()).toBe(true);

    expect(isCategoryCollapsed("cat:5")).toBe(true);
    // The synthetic Voice key and a name nothing matches are left alone.
    expect(isCategoryCollapsed("Voice")).toBe(true);
    expect(JSON.parse(localStorage.getItem("owncord:collapsed:host") ?? "[]")).toEqual([
      "cat:5",
      "Voice",
      "Gone",
    ]);
  });

  it("is idempotent: a second pass changes nothing", () => {
    localStorage.setItem("owncord:collapsed:host", JSON.stringify(["Games"]));
    loadCollapsedCategories("host");
    setChannels(games("Games"));
    migrateCollapsedToCategoryIds();
    const after = uiStore.getState().collapsedCategories;
    migrateCollapsedToCategoryIds();
    expect(uiStore.getState().collapsedCategories).toBe(after);
  });

  it("edge case 2: a reconnect after a rename keeps the category collapsed", () => {
    loadCollapsedCategories("host");
    setChannels(games("Games"));
    toggleCategory("cat:5");
    expect(isCategoryCollapsed("cat:5")).toBe(true);

    // Renamed elsewhere; this client reconnects and the ready carries the new name.
    setChannels(games("Play"));
    expect(getChannelsByCategory([]).has("cat:5")).toBe(true);
    expect(isCategoryCollapsed("cat:5")).toBe(true);
    expect(JSON.parse(localStorage.getItem("owncord:collapsed:host") ?? "[]")).toEqual(["cat:5"]);
  });
});

describe("category header menu", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  const onCreateCategory = vi.fn();
  const onRenameCategory = vi.fn();
  const onDeleteCategory = vi.fn();
  const onMoveCategory = vi.fn();

  function signIn(role: string): void {
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Me", avatar: null, role },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
  }

  function mount(): void {
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onOpenCall: vi.fn(),
      onCreateChannel: vi.fn(),
      onCreateCategory,
      onRenameCategory,
      onDeleteCategory,
      onMoveCategory,
    });
    sidebar.mount(container);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dmStore.setState(() => ({ channels: [] }));
    resetMembersState();
    voiceStore.setState((prev) => ({ ...prev, voiceStates: new Map() }));
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
    container = document.createElement("div");
    document.body.appendChild(container);
    setChannels([
      ch(
        { id: 1, name: "a", type: "text", position: 0, category_id: 2, category_position: 0 },
        "First",
      ),
      ch(
        { id: 2, name: "b", type: "text", position: 1, category_id: 3, category_position: 1 },
        "Second",
      ),
      ch({ id: 3, name: "c", type: "text", position: 2 }, "Legacy"),
    ]);
    setCategories([
      { id: 2, name: "First", position: 0 },
      { id: 3, name: "Second", position: 1 },
      { id: 4, name: "Empty", position: 2 },
    ]);
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
  });

  function openMenu(selector: string): HTMLElement {
    container
      .querySelector<HTMLElement>(selector)!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
    return document.querySelector<HTMLElement>('[data-testid="category-context-menu"]')!;
  }
  const item = (menu: HTMLElement, id: string): HTMLElement | null =>
    menu.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it("draws a manager's empty category as a header", () => {
    signIn("owner");
    mount();
    expect(container.querySelector('.category[data-category-id="4"]')).not.toBeNull();
  });

  it("offers a manager create, rename, move and delete on a real category", () => {
    signIn("owner");
    mount();
    const menu = openMenu('.category[data-category-id="3"]');
    expect(item(menu, "ctx-category-create")?.textContent).toBe("Create Category");
    expect(item(menu, "ctx-category-rename")?.textContent).toBe("Rename Category");
    expect(item(menu, "ctx-category-move-up")?.textContent).toBe("Move Category Up");
    expect(item(menu, "ctx-category-move-down")?.textContent).toBe("Move Category Down");
    expect(item(menu, "ctx-category-delete")?.textContent).toBe("Delete Category");

    item(menu, "ctx-category-rename")!.click();
    expect(onRenameCategory).toHaveBeenCalledWith({ id: 3, name: "Second" });
  });

  it("routes Move Up and Delete with the category, and disables a move off either end", () => {
    signIn("owner");
    mount();
    item(openMenu('.category[data-category-id="3"]'), "ctx-category-move-up")!.click();
    expect(onMoveCategory).toHaveBeenCalledWith({ id: 3, name: "Second" }, -1);

    item(openMenu('.category[data-category-id="3"]'), "ctx-category-delete")!.click();
    expect(onDeleteCategory).toHaveBeenCalledWith({ id: 3, name: "Second" });

    const first = openMenu('.category[data-category-id="2"]');
    expect(item(first, "ctx-category-move-up")?.classList.contains("disabled")).toBe(true);
    item(first, "ctx-category-move-up")!.click();
    expect(onMoveCategory).toHaveBeenCalledTimes(1);
  });

  it("a name-only category (no id) gets Create Category but no rename, move or delete", () => {
    signIn("owner");
    mount();
    const menu = openMenu('.category[data-category="Legacy"]');
    expect(item(menu, "ctx-category-create")).not.toBeNull();
    for (const id of ["rename", "move-up", "move-down", "delete"]) {
      expect(item(menu, `ctx-category-${id}`)).toBeNull();
    }
  });

  it("hides every management entry from a non-manager, whatever the page wired", () => {
    signIn("member");
    mount();
    const menu = openMenu('.category[data-category-id="3"]');
    expect(item(menu, "ctx-category-toggle")).not.toBeNull();
    for (const id of ["create", "rename", "move-up", "move-down", "delete"]) {
      expect(item(menu, `ctx-category-${id}`)).toBeNull();
    }
  });

  it("hides an entry whose callback the page did not wire", () => {
    signIn("owner");
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    sidebar.mount(container);
    const menu = openMenu('.category[data-category-id="3"]');
    expect(item(menu, "ctx-category-rename")).toBeNull();
    expect(item(menu, "ctx-category-create")).toBeNull();
  });

  it("a rename keeps the header's collapse state and redraws its label", () => {
    signIn("owner");
    mount();
    toggleCategory("cat:3");
    updateChannel({ id: 2, category: "Renamed", category_id: 3, category_position: 1 });
    setCategories([
      { id: 2, name: "First", position: 0 },
      { id: 3, name: "Renamed", position: 1 },
      { id: 4, name: "Empty", position: 2 },
    ]);
    return vi.waitFor(() => {
      const header = container.querySelector<HTMLElement>('.category[data-category-id="3"]');
      expect(header?.querySelector(".category-name")?.textContent).toBe("Renamed");
      expect(header?.classList.contains("collapsed")).toBe(true);
    });
  });

  it("edge case 1 in the DOM: a non-manager's channel moved into an unlisted category draws its group", () => {
    signIn("member");
    setCategories([]);
    mount();
    updateChannel({ id: 3, category: "Fresh", category_id: 9, category_position: 4 });
    return vi.waitFor(() => {
      const header = container.querySelector<HTMLElement>('.category[data-category-id="9"]');
      expect(header?.dataset.category).toBe("Fresh");
      expect(container.querySelector('[data-channel-id="3"]')).not.toBeNull();
    });
  });
});

describe("category actions", () => {
  function api(over: Partial<CategoryApi> = {}): CategoryApi {
    return {
      adminCreateCategory: vi.fn(async () => ({ id: 1, name: "x", position: 0 })),
      adminRenameCategory: vi.fn(async () => ({ id: 1, name: "x", position: 0 })),
      adminDeleteCategory: vi.fn(async () => {}),
      adminReorderCategories: vi.fn(async () => []),
      ...over,
    };
  }
  const show = vi.fn();
  const toast = () => ({ show });

  beforeEach(() => {
    show.mockClear();
    setCategories([
      { id: 10, name: "A", position: 0 },
      { id: 11, name: "B", position: 1 },
      { id: 12, name: "C", position: 2 },
    ]);
  });

  it("moves a category by PUTting the full id list with it swapped with its neighbour", async () => {
    const a = api();
    await moveCategory(a, toast, 12, -1);
    expect(a.adminReorderCategories).toHaveBeenCalledWith([10, 12, 11]);
    await moveCategory(a, toast, 10, 1);
    expect(a.adminReorderCategories).toHaveBeenLastCalledWith([11, 10, 12]);
    expect(show).not.toHaveBeenCalled();
    // Nothing is applied locally: the server's channel_categories frame does that.
    expect(channelsStore.getState().categories.map((c) => c.id)).toEqual([10, 11, 12]);
  });

  it("does nothing off either end, and canMoveCategory says so", async () => {
    const a = api();
    await moveCategory(a, toast, 10, -1);
    await moveCategory(a, toast, 12, 1);
    await moveCategory(a, toast, 99, 1);
    expect(a.adminReorderCategories).not.toHaveBeenCalled();
    expect(canMoveCategory(10, -1)).toBe(false);
    expect(canMoveCategory(10, 1)).toBe(true);
    expect(canMoveCategory(99, 1)).toBe(false);
  });

  it("on 409 CATEGORY_LIST_STALE toasts and keeps the order the client already shows", async () => {
    const a = api({
      adminReorderCategories: vi.fn(async () => {
        throw new ApiClientError(409, CATEGORY_LIST_STALE, "category list is stale");
      }),
    });
    await moveCategory(a, toast, 11, -1);
    expect(show).toHaveBeenCalledWith(
      "The category list changed. Showing the latest order.",
      "info",
    );
    expect(channelsStore.getState().categories.map((c) => c.id)).toEqual([10, 11, 12]);
  });

  it("toasts any other reorder failure as an error", async () => {
    const a = api({
      adminReorderCategories: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await moveCategory(a, toast, 11, -1);
    expect(show).toHaveBeenCalledWith("boom", "error");
  });

  it("places a dragged category before or after another by PUTting the full id list", async () => {
    const a = api();
    await placeCategory(a, toast, 12, 10, true);
    expect(a.adminReorderCategories).toHaveBeenLastCalledWith([12, 10, 11]);
    await placeCategory(a, toast, 10, 12, false);
    expect(a.adminReorderCategories).toHaveBeenLastCalledWith([11, 12, 10]);
    await placeCategory(a, toast, 10, 11, false);
    expect(a.adminReorderCategories).toHaveBeenLastCalledWith([11, 10, 12]);
    // Nothing is applied locally: the channel_categories frame does that.
    expect(channelsStore.getState().categories.map((c) => c.id)).toEqual([10, 11, 12]);
    expect(show).not.toHaveBeenCalled();
  });

  it("sends nothing for a drop that leaves the order alone or names an unknown category", async () => {
    const a = api();
    await placeCategory(a, toast, 11, 10, false); // already right after 10
    await placeCategory(a, toast, 11, 12, true); // already right before 12
    await placeCategory(a, toast, 11, 11, true);
    await placeCategory(a, toast, 99, 10, true);
    await placeCategory(a, toast, 10, 99, true);
    expect(a.adminReorderCategories).not.toHaveBeenCalled();
  });

  it("a drag-reorder that hits 409 CATEGORY_LIST_STALE toasts the list-changed copy and keeps the order", async () => {
    const a = api({
      adminReorderCategories: vi.fn(async () => {
        throw new ApiClientError(409, CATEGORY_LIST_STALE, "category list is stale");
      }),
    });
    await placeCategory(a, toast, 12, 10, true);
    expect(a.adminReorderCategories).toHaveBeenCalledWith([12, 10, 11]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(
      "The category list changed. Showing the latest order.",
      "info",
    );
    expect(channelsStore.getState().categories.map((c) => c.id)).toEqual([10, 11, 12]);
  });

  it("a duplicate name toasts friendly copy and rethrows for the dialog", async () => {
    const a = api({
      adminCreateCategory: vi.fn(async () => {
        throw new ApiClientError(409, CATEGORY_NAME_TAKEN, "category name taken");
      }),
    });
    await expect(createCategory(a, toast, "A")).rejects.toBeInstanceOf(ApiClientError);
    expect(show).toHaveBeenCalledWith("A category with that name already exists", "error");
  });
});
