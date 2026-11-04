/**
 * Quick Switcher (Ctrl+K) parity (N9): ordering, DM rows, markers, the empty
 * state, and the manager routing a pick through navigateToChannel.
 */
import { makeDm } from "../helpers/dmHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { createQuickSwitcher } from "@components/QuickSwitcher";
import { createQuickSwitcherManager } from "../../src/pages/main-page/OverlayManagers";
import { channelsStore, setChannels } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { uiStore, setSidebarMode, setActiveDmUser } from "@stores/ui.store";
import type { ReadyChannel } from "../../src/lib/types";
import { resetChannelsState } from "../helpers/storeSeeds";

function dm(channelId: number, username: string, over: Partial<DmChannel> = {}): DmChannel {
  const user = { id: channelId + 100, username, avatar: "", status: "online" };
  return makeDm({ channelId, recipient: user, participants: [user], ...over });
}

function names(container: HTMLElement): (string | null | undefined)[] {
  return Array.from(container.querySelectorAll(".quick-switcher__item")).map(
    (el) => el.querySelector(".quick-switcher__name")?.textContent,
  );
}

function type(container: HTMLElement, value: string): void {
  const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

beforeEach(() => {
  resetChannelsState();
  dmStore.setState(() => ({ channels: [] }));
  uiStore.setState((p) => ({ ...p, sidebarMode: "channels", activeDmUserId: null }));
});

describe("QuickSwitcher content", () => {
  let container: HTMLDivElement;
  let switcher: ReturnType<typeof createQuickSwitcher>;

  function open(): void {
    switcher = createQuickSwitcher({ onSelectChannel: vi.fn(), onClose: vi.fn() });
    switcher.mount(container);
  }

  useMountContainer(
    (c) => {
      container = c;
    },
    () => switcher.destroy?.(),
  );

  it("ranks prefix matches before substring matches", () => {
    setChannels([
      { id: 1, name: "off-general", type: "text", category: null, position: 0 },
      { id: 2, name: "general", type: "text", category: null, position: 1 },
      { id: 3, name: "gen-chat", type: "text", category: null, position: 2 },
    ]);
    open();
    type(container, "gen");
    expect(names(container)).toEqual(["general", "gen-chat", "off-general"]);
  });

  it("shows a No results line when nothing matches, and hides it otherwise", () => {
    setChannels([{ id: 1, name: "general", type: "text", category: null, position: 0 }]);
    open();
    expect(container.querySelector('[data-testid="quick-switcher-empty"]')?.textContent).toBe("");
    type(container, "zzz");
    expect(container.querySelector('[data-testid="quick-switcher-empty"]')?.textContent).toBe(
      "No results",
    );
    expect(
      container.querySelector('[data-testid="quick-switcher-empty"]')?.getAttribute("role"),
    ).toBe("status");
    // Not a child of the listbox, which may hold only options.
    expect(
      container.querySelector('[role="listbox"] [data-testid="quick-switcher-empty"]'),
    ).toBeNull();
    type(container, "gen");
    expect(container.querySelector('[data-testid="quick-switcher-empty"]')?.textContent).toBe("");
  });

  it("draws a megaphone for announcement channels and # for text", () => {
    setChannels([
      { id: 1, name: "news", type: "announcement", category: null, position: 0 },
      { id: 2, name: "chat", type: "text", category: null, position: 1 },
    ]);
    open();
    const icons = Array.from(container.querySelectorAll(".quick-switcher__icon svg")).map((el) =>
      el.getAttribute("data-icon"),
    );
    expect(icons).toEqual(["megaphone", "hash"]);
  });

  it("shows an unread dot and a mention count", () => {
    setChannels([
      { id: 1, name: "quiet", type: "text", category: null, position: 0, unread_count: 0 },
      { id: 2, name: "busy", type: "text", category: null, position: 1, unread_count: 4 },
      {
        id: 3,
        name: "pinged",
        type: "text",
        category: null,
        position: 2,
        unread_count: 5,
        mention_count: 2,
      },
    ]);
    open();
    expect(container.querySelector('[data-testid="qs-unread-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="qs-unread-2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="qs-mentions-3"]')?.textContent).toBe("2");
    expect(container.querySelector('[data-testid="qs-unread-3"]')).toBeNull();
  });

  it("lists DM conversations from dmStore with their markers", () => {
    setChannels([{ id: 1, name: "general", type: "text", category: null, position: 0 }]);
    dmStore.setState(() => ({
      channels: [dm(50, "bob", { mentionCount: 3, unreadCount: 3 })],
    }));
    open();
    expect(names(container)).toEqual(["general", "bob"]);
    expect(container.querySelector('[data-testid="qs-mentions-50"]')?.textContent).toBe("3");
  });
});

describe("QuickSwitcher manager pick", () => {
  let root: HTMLDivElement;
  const channels: ReadyChannel[] = [
    { id: 1, name: "general", type: "text", category: null, position: 0 },
    { id: 2, name: "random", type: "text", category: null, position: 1, unread_count: 2 },
  ];

  async function openAndPick(id: number, onBeforeDm?: () => void): Promise<() => void> {
    const manager = createQuickSwitcherManager(() => root, undefined, undefined, onBeforeDm);
    const detach = manager.attach();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    const row = root.querySelector<HTMLElement>(`.quick-switcher__item[data-channelid="${id}"]`);
    expect(row).not.toBeNull();
    row!.click();
    return detach;
  }

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    setChannels(channels);
    dmStore.setState(() => ({ channels: [dm(50, "bob")] }));
  });
  afterEach(() => root.remove());

  it("picking a channel from DM mode returns the sidebar to channels and navigates", async () => {
    setSidebarMode("dms");
    setActiveDmUser(150);
    const detach = await openAndPick(2);
    expect(uiStore.getState().sidebarMode).toBe("channels");
    expect(uiStore.getState().activeDmUserId).toBeNull();
    expect(channelsStore.getState().activeChannelId).toBe(2);
    // navigateToChannel clears the unread badge.
    expect(channelsStore.getState().channels.get(2)?.unreadCount).toBe(0);
    detach();
  });

  it("picking a channel from DM mode drops the saved channel-before-DM", async () => {
    setSidebarMode("dms");
    const onLeaveDm = vi.fn();
    const manager = createQuickSwitcherManager(
      () => root,
      undefined,
      undefined,
      undefined,
      onLeaveDm,
    );
    const detach = manager.attach();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    root.querySelector<HTMLElement>('.quick-switcher__item[data-channelid="1"]')!.click();
    expect(onLeaveDm).toHaveBeenCalledOnce();
    detach();
  });

  it("picking a DM opens it in DM mode, remembering the channel first", async () => {
    const onBeforeDm = vi.fn();
    const detach = await openAndPick(50, onBeforeDm);
    expect(onBeforeDm).toHaveBeenCalledOnce();
    expect(uiStore.getState().sidebarMode).toBe("dms");
    expect(uiStore.getState().activeDmUserId).toBe(150);
    expect(channelsStore.getState().activeChannelId).toBe(50);
    detach();
  });
});
