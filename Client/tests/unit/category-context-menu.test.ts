/** Category header right-click menu (N13) and text-before-voice order (N23). */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@lib/voice/livekitSession", () => ({ rePinPeerIdentity: vi.fn() }));
vi.mock("@lib/net/e2eeCrypto", () => ({
  importIdentityPublicKey: vi.fn(),
  computeKeyFingerprint: vi.fn(),
}));

import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import { attachChannelContextMenu } from "../../src/components/channel-sidebar/contextMenu";
import {
  channelsStore,
  setChannels,
  getChannelsByCategory,
  type Channel,
} from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { uiStore, isCategoryCollapsed } from "../../src/stores/ui.store";
import { voiceStore } from "../../src/stores/voice.store";
import { setMarkReadSender } from "@lib/readState";
import type { ReadyChannel } from "../../src/lib/types";
import { resetMembersState } from "../helpers/storeResets";
import { signInAs, resetChannelsState } from "../helpers/storeSeeds";

const CHANNELS: ReadyChannel[] = [
  { id: 1, name: "a1", type: "text", category: "Alpha", position: 0, unread_count: 2 },
  { id: 2, name: "a2", type: "text", category: "Alpha", position: 1, unread_count: 0 },
  { id: 3, name: "a3", type: "text", category: "Alpha", position: 2, mention_count: 1 },
  { id: 4, name: "b1", type: "text", category: "Beta", position: 3, unread_count: 5 },
];

describe("category context menu", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let sent: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    setMarkReadSender((id) => sent.push(id));
    resetChannelsState();
    dmStore.setState(() => ({ channels: [] }));
    resetMembersState();
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
    voiceStore.setState((prev) => ({ ...prev, voiceStates: new Map() }));
    signInAs({ id: 2, username: "Member", avatar: null, role: "member" });
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    setChannels(CHANNELS);
    sidebar.mount(container);
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
    setMarkReadSender(null);
    vi.useRealTimers();
  });

  function remount(channels: ReadyChannel[]): void {
    sidebar.destroy?.();
    container.replaceChildren();
    setChannels(channels);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    sidebar.mount(container);
  }

  function openMenu(category: string): HTMLElement {
    const header = container.querySelector<HTMLElement>(`.category[data-category="${category}"]`)!;
    header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
    return document.querySelector<HTMLElement>('[data-testid="category-context-menu"]')!;
  }
  const item = (menu: HTMLElement, id: string): HTMLElement =>
    menu.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

  it("offers the three entries on a category header", () => {
    const menu = openMenu("Alpha");
    expect(menu).not.toBeNull();
    expect(item(menu, "ctx-category-mark-read").textContent).toBe("Mark Category as Read");
    expect(item(menu, "ctx-category-toggle").textContent).toBe("Collapse Category");
    expect(item(menu, "ctx-category-collapse-all").textContent).toBe("Collapse All Categories");
  });

  it("marks only that category's unread channels read", () => {
    item(openMenu("Alpha"), "ctx-category-mark-read").click();
    expect(sent.toSorted()).toEqual([1, 3]);
    expect(channelsStore.getState().channels.get(4)?.unreadCount).toBe(5);
  });

  it("paces a large category like Mark All as Read", () => {
    const many: ReadyChannel[] = Array.from({ length: 6 }, (_, i) => ({
      id: 10 + i,
      name: `c${i}`,
      type: "text" as const,
      category: "Big",
      position: i,
      unread_count: 1,
    }));
    remount(many);
    item(openMenu("Big"), "ctx-category-mark-read").click();
    expect(sent).toHaveLength(4);
    vi.advanceTimersByTime(1100);
    expect(sent).toHaveLength(6);
  });

  it("disables Mark Category as Read when nothing in it is unread", () => {
    remount([{ id: 9, name: "z", type: "text", category: "Quiet", position: 0 }]);
    const mark = item(openMenu("Quiet"), "ctx-category-mark-read");
    expect(mark.classList.contains("disabled")).toBe(true);
    mark.click();
    expect(sent).toEqual([]);
  });

  it("closes when a channel menu opens, and the other way round", () => {
    openMenu("Alpha");
    container
      .querySelector<HTMLElement>('[data-channel-id="1"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
    expect(document.querySelector('[data-testid="category-context-menu"]')).toBeNull();
    expect(document.querySelectorAll(".channel-ctx-menu")).toHaveLength(1);
    openMenu("Beta");
    expect(document.querySelector('[data-testid="channel-context-menu"]')).toBeNull();
    expect(document.querySelectorAll(".channel-ctx-menu")).toHaveLength(1);
  });

  it("toggles Collapse / Expand Category", () => {
    item(openMenu("Alpha"), "ctx-category-toggle").click();
    expect(isCategoryCollapsed("Alpha")).toBe(true);
    expect(item(openMenu("Alpha"), "ctx-category-toggle").textContent).toBe("Expand Category");
    item(openMenu("Alpha"), "ctx-category-toggle").click();
    expect(isCategoryCollapsed("Alpha")).toBe(false);
  });

  it("collapses every category", () => {
    item(openMenu("Alpha"), "ctx-category-collapse-all").click();
    expect(isCategoryCollapsed("Alpha")).toBe(true);
    expect(isCategoryCollapsed("Beta")).toBe(true);
  });
});

describe("text before voice inside a category (N23)", () => {
  beforeEach(() => {
    resetChannelsState();
    setChannels([
      { id: 1, name: "lobby", type: "voice", category: "Mix", position: 0 },
      { id: 2, name: "chat", type: "text", category: "Mix", position: 1 },
      { id: 3, name: "news", type: "announcement", category: "Mix", position: 2 },
      { id: 4, name: "lounge", type: "voice", category: "Mix", position: 3 },
      { id: 5, name: "solo", type: "voice", category: "Only Voice", position: -1 },
    ]);
  });

  it("lists text-type channels first, each kind in position order", () => {
    const grouped = getChannelsByCategory([]);
    expect(grouped.get("Mix")!.map((c) => c.id)).toEqual([2, 3, 1, 4]);
  });

  it("keeps the category order the position sort gave", () => {
    expect([...getChannelsByCategory([]).keys()]).toEqual(["Only Voice", "Mix"]);
  });

  it("Move Up/Down swaps only within the same kind", () => {
    const live = getChannelsByCategory([]).get("Mix")!;
    const onReorder = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    signInAs(
      { id: 1, username: "o", avatar: null, role: "owner" },
      { token: "t", serverName: "s", motd: "" },
    );
    const ac = new AbortController();
    const chat = channelsStore.getState().channels.get(2) as Channel;
    attachChannelContextMenu(
      el,
      chat,
      ac.signal,
      ac.signal,
      undefined,
      undefined,
      undefined,
      live,
      onReorder,
    );
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const menu = document.querySelector('[data-testid="channel-context-menu"]')!;
    // chat is the first text-type row: Move Up is disabled, Move Down swaps with news (3), not lobby.
    expect(menu.querySelector('[data-testid="ctx-move-up"]')!.classList.contains("disabled")).toBe(
      true,
    );
    (menu.querySelector('[data-testid="ctx-move-down"]') as HTMLElement).click();
    expect(onReorder.mock.calls[0]![0].map((r: { channelId: number }) => r.channelId)).toEqual([
      2, 3,
    ]);
    ac.abort();
    el.remove();
    menu.remove();
  });
});
