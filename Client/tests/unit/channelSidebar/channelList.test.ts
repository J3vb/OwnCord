import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as mocks from "../../helpers/channelSidebarMocks";
import { cascadedDeclaration } from "../../helpers/app-css";
import {
  createChannelSidebar,
  type ChannelReorderData,
} from "../../../src/components/ChannelSidebar";
import {
  channelsStore,
  incrementUnread,
  setChannels,
  setActiveChannel,
  setRoles,
  updateChannel,
  type Channel,
} from "../../../src/stores/channels.store";
import { authStore } from "../../../src/stores/auth.store";
import { uiStore } from "../../../src/stores/ui.store";
import { safetyStore } from "../../../src/features/safety/store";
import { voiceStore } from "../../../src/stores/voice.store";
import { membersStore } from "../../../src/stores/members.store";
import { Permission, type ReadyChannel } from "../../../src/lib/types";
import {
  CHANNEL_MUTE_CHANGED,
  getChannelMutesHost,
  muteChannel,
  unmuteChannel,
  invalidateMuteCache,
} from "@lib/prefs/channelMutes";
import { STORAGE_PREFIX } from "@lib/prefs/preferences";
import { setHideMutedChannels } from "@lib/prefs/hideMutedChannels";
import {
  resetStores,
  addVoiceUser,
  testChannels,
  setAdminUser,
} from "../../helpers/channelSidebarHarness";
import { signInAs } from "../../helpers/storeSeeds";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/net/e2eeCrypto", (importOriginal) => mocks.netE2eeCryptoMock(importOriginal));
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/features/profiles/openUserProfilePopup", () =>
  mocks.profilesOpenUserProfilePopupMock(),
);

const { mockOpenUserProfilePopup } = mocks;

describe("ChannelSidebar", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let onVoiceJoin: Mock<(channelId: number) => void>;
  let onOpenCall: Mock<() => void>;

  beforeEach(() => {
    resetStores();
    mockOpenUserProfilePopup.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    onVoiceJoin = vi.fn<(channelId: number) => void>();
    onOpenCall = vi.fn<() => void>();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    // Clean up any context menus left on document.body
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    document.querySelectorAll(".user-vol-menu").forEach((el) => el.remove());
  });

  it("renders channel list from store", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const items = container.querySelectorAll(".channel-item");
    expect(items.length).toBe(4);

    const names = Array.from(container.querySelectorAll(".ch-name")).map((el) => el.textContent);
    expect(names).toContain("general");
    expect(names).toContain("random");
    expect(names).toContain("voice-lobby");
    expect(names).toContain("announcements");
  });

  // ── B9-21: the channel list is a single Tab stop with arrow-key navigation ──
  describe("keyboard navigation", () => {
    it("exposes exactly one Tab stop and marks the active channel", () => {
      setChannels(testChannels);
      setActiveChannel(1);
      sidebar.mount(container);

      const tabbable = container.querySelectorAll(".channel-item[tabindex='0']");
      expect(tabbable.length).toBe(1);
      expect((tabbable[0] as HTMLElement).dataset.channelId).toBe("1");
      expect(tabbable[0]!.getAttribute("aria-current")).toBe("page");
    });

    it("ArrowDown moves focus and the Tab stop to the next row", () => {
      setChannels(testChannels);
      sidebar.mount(container);

      const first = container.querySelector(".channel-item") as HTMLElement;
      first.focus();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

      const focused = document.activeElement as HTMLElement;
      expect(focused).not.toBe(first);
      expect(focused.dataset.channelId).toBe("2");
      expect(focused.getAttribute("tabindex")).toBe("0");
      expect(first.getAttribute("tabindex")).toBe("-1");
    });

    it("Enter on a focused row opens that channel", () => {
      setChannels(testChannels);
      sidebar.mount(container);

      const row = container.querySelector('[data-channel-id="2"]') as HTMLElement;
      row.focus();
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(channelsStore.getState().activeChannelId).toBe(2);
    });
  });

  it("groups channels by category", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const categories = container.querySelectorAll(".category");
    const categoryNames = Array.from(categories).map(
      (el) => el.querySelector(".category-name")?.textContent,
    );

    expect(categoryNames).toContain("Text Channels");
    expect(categoryNames).toContain("Voice Channels");
    expect(categoryNames).toContain("Info");
  });

  // Categories are free text: a voice channel groups under whatever it carries,
  // and shares a category with text channels rather than being pulled into a
  // hardcoded voice section.
  it("groups a voice channel under an arbitrary shared category", () => {
    setChannels([
      { id: 1, name: "chat", type: "text", category: "Gaming", position: 0 },
      { id: 2, name: "lounge", type: "voice", category: "Gaming", position: 1 },
    ]);
    sidebar.mount(container);

    const headers = Array.from(container.querySelectorAll(".category"));
    const names = headers.map((el) => el.querySelector(".category-name")?.textContent);
    expect(names).toEqual(["Gaming"]);

    const group = headers[0]?.parentElement;
    const rendered = Array.from(group?.querySelectorAll(".ch-name") ?? []).map(
      (el) => el.textContent,
    );
    expect(rendered).toEqual(["chat", "lounge"]);
  });

  it("puts only uncategorized voice channels in the fallback Voice group", () => {
    setChannels([
      { id: 1, name: "loose-text", type: "text", category: null, position: 0 },
      { id: 2, name: "loose-voice", type: "voice", category: null, position: 1 },
    ]);
    sidebar.mount(container);

    const names = Array.from(container.querySelectorAll(".category-name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Voice"]);

    // The uncategorized TEXT channel still renders, headerless.
    const allNames = Array.from(container.querySelectorAll(".ch-name")).map((el) => el.textContent);
    expect(allNames).toContain("loose-text");
    expect(allNames).toContain("loose-voice");
  });

  it("click channel sets active and clears unread", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    // Channel 1 (general) has unread_count of 2
    const ch1Before = channelsStore.getState().channels.get(1);
    expect(ch1Before?.unreadCount).toBe(2);

    const firstItem = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(firstItem).not.toBeNull();
    firstItem.click();

    const state = channelsStore.getState();
    expect(state.activeChannelId).toBe(1);
    expect(state.channels.get(1)?.unreadCount).toBe(0);
  });

  it("category collapse toggles visibility", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    // Text Channels category should have 2 channels visible
    const textChannelsBefore = container.querySelectorAll(".channel-item");
    expect(textChannelsBefore.length).toBe(4);

    // Click the "Text Channels" category header to collapse
    const headers = container.querySelectorAll(".category");
    const textHeader = Array.from(headers).find(
      (h) => h.querySelector(".category-name")?.textContent === "Text Channels",
    ) as HTMLElement;
    expect(textHeader).not.toBeUndefined();
    textHeader.click();
    uiStore.flush();

    // After collapse, "Text Channels" channels should be hidden
    // The sidebar re-renders on uiStore change, so channels under
    // collapsed category are not in the DOM
    const itemsAfter = container.querySelectorAll(".channel-item");
    // Voice + Info stay (their own categories); "general" is unread (2), so it
    // is the one row a collapsed Text Channels keeps (WP 2B-5).
    expect(itemsAfter.length).toBe(3);

    // Expand again
    const headersAfter = container.querySelectorAll(".category");
    const textHeaderAfter = Array.from(headersAfter).find(
      (h) => h.querySelector(".category-name")?.textContent === "Text Channels",
    ) as HTMLElement;
    textHeaderAfter.click();
    uiStore.flush();

    const itemsExpanded = container.querySelectorAll(".channel-item");
    expect(itemsExpanded.length).toBe(4);
  });

  it("displays server name from auth store", () => {
    sidebar.mount(container);

    const serverName = container.querySelector(".channel-sidebar-header h2");
    expect(serverName?.textContent).toBe("Test Server");
  });

  it("shows plain unread as bold name and pill only, with no number badge", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    // general (2) and announcements (5) are unread: the `.unread` class carries
    // the bold name and the white pill; the count is not drawn.
    const unreadRows = container.querySelectorAll(".channel-item.unread");
    expect(unreadRows.length).toBe(2);
    expect(container.querySelectorAll(".unread-badge").length).toBe(0);
    expect(container.querySelector('[data-channel-id="1"]')?.textContent).not.toContain("2");
    // The pill and the bold name are CSS on `.unread`; pin both.
    expect(cascadedDeclaration(".channel-item.unread .ch-name", "font-weight")).toBeDefined();
    expect(cascadedDeclaration(".channel-item.unread::before", "background")).toBeDefined();
    // No stylesheet rule styles a server-channel count any more.
    expect(cascadedDeclaration(".channel-item .unread-badge", "background")).toBeUndefined();
  });

  it("keeps the red mention badge, with the count, on a mentioned row", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 7, mention_count: 2 }, testChannels[1]!]);
    sidebar.mount(container);

    const item = container.querySelector('[data-channel-id="1"]')!;
    expect(item.classList.contains("mentioned")).toBe(true);
    expect(item.querySelector(".mention-badge")?.textContent).toBe("2");
    expect(item.querySelector(".unread-badge")).toBeNull();
  });

  it("an unread row with no mentions has no mention badge and no count", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 7, mention_count: 0 }]);
    sidebar.mount(container);

    const item = container.querySelector('[data-channel-id="1"]')!;
    expect(item.classList.contains("unread")).toBe(true);
    expect(item.classList.contains("mentioned")).toBe(false);
    expect(item.querySelector(".mention-badge")).toBeNull();
    expect(item.querySelector(".unread-badge")).toBeNull();
  });

  describe("muted channels (N7)", () => {
    beforeEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });
    afterEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    it("a muted unread row has no .unread class and no badge", () => {
      setChannels([{ ...testChannels[0]!, unread_count: 5, mention_count: 0 }]);
      muteChannel(1);
      sidebar.mount(container);

      const item = container.querySelector('[data-channel-id="1"]')!;
      expect(item.classList.contains("muted")).toBe(true);
      expect(item.classList.contains("unread")).toBe(false);
      expect(item.querySelector(".unread-badge")).toBeNull();
      expect(item.querySelector(".mention-badge")).toBeNull();
      expect(item.hasAttribute("aria-description")).toBe(false);
    });

    it("names plain unread for screen readers, but not a mention", () => {
      setChannels([
        { ...testChannels[0]!, unread_count: 5, mention_count: 0 },
        { ...testChannels[1]!, unread_count: 5, mention_count: 1 },
      ]);
      sidebar.mount(container);

      const plain = container.querySelector(`[data-channel-id="${testChannels[0]!.id}"]`)!;
      const mentioned = container.querySelector(`[data-channel-id="${testChannels[1]!.id}"]`)!;
      expect(plain.getAttribute("aria-description")).toBe("Unread");
      expect(mentioned.hasAttribute("aria-description")).toBe(false);
    });

    it("a muted row with mentions still shows the mention", () => {
      setChannels([{ ...testChannels[0]!, unread_count: 5, mention_count: 2 }]);
      muteChannel(1);
      sidebar.mount(container);

      const item = container.querySelector('[data-channel-id="1"]')!;
      expect(item.classList.contains("unread")).toBe(true);
      expect(item.classList.contains("mentioned")).toBe(true);
      expect(item.querySelector(".mention-badge")?.textContent).toBe("2");
    });

    it("unmuting restores the unread look", () => {
      setChannels([{ ...testChannels[0]!, unread_count: 5, mention_count: 0 }]);
      muteChannel(1);
      sidebar.mount(container);
      unmuteChannel(1);
      channelsStore.flush();
      const item = container.querySelector('[data-channel-id="1"]')!;
      expect(item.classList.contains("unread")).toBe(true);
    });
  });

  it("leaves the mention badge uncapped", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 0, mention_count: 137 }]);
    sidebar.mount(container);

    const badge = container.querySelector('[data-channel-id="1"] .mention-badge');
    expect(badge?.textContent).toBe("137");
  });

  it("clears the mention badge when the channel is activated", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 7, mention_count: 2 }]);
    sidebar.mount(container);

    (container.querySelector('[data-channel-id="1"]') as HTMLElement).click();
    channelsStore.flush();

    expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(0);
    expect(channelsStore.getState().activeChannelId).toBe(1);
    expect(container.querySelector(".mention-badge")).toBeNull();
  });

  it("marks active channel with active class", () => {
    setChannels(testChannels);
    setActiveChannel(2);
    sidebar.mount(container);

    const activeItem = container.querySelector('[data-channel-id="2"]');
    expect(activeItem?.classList.contains("active")).toBe(true);
  });

  it("shows voice icon for voice channels", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]');
    const icon = voiceItem?.querySelector(".ch-icon");
    expect(icon).not.toBeNull();
  });

  it("clicking voice channel calls onVoiceJoin instead of setActiveChannel", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    voiceItem.click();

    // Should NOT set active channel
    expect(channelsStore.getState().activeChannelId).toBeNull();
    // Should call onVoiceJoin with channel id
    expect(onVoiceJoin).toHaveBeenCalledWith(3);
  });

  it("clicking text channel still sets active channel normally", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const textItem = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    textItem.click();

    expect(channelsStore.getState().activeChannelId).toBe(1);
    expect(onVoiceJoin).not.toHaveBeenCalled();
  });

  it("clicking the joined voice channel opens the call instead of leaving (V1)", () => {
    // Discord parity: a click on the channel you are in shows the call; only
    // the voice widget's Disconnect leaves. The sidebar has no leave callback.
    setChannels(testChannels);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3, voiceStatus: "connected" }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    voiceItem.click();

    expect(onOpenCall).toHaveBeenCalledOnce();
    expect(onVoiceJoin).not.toHaveBeenCalled();
    expect(voiceStore.getState().currentChannelId).toBe(3);
  });

  it("a repeat click on the voice channel being joined does not leave it", () => {
    // Every click toggled, so clicking the row again while a join was still
    // joining/securing (a double-click, or retrying a slow join) sent
    // voice_leave before the SFU was ever reached: rapid clicks cycled
    // voice_join/voice_leave on the server several times a second.
    setChannels(testChannels);
    sidebar.mount(container);
    for (const voiceStatus of ["joining", "securing"] as const) {
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3, voiceStatus }));
      voiceStore.flush();
      (container.querySelector('[data-channel-id="3"]') as HTMLElement).click();
      expect(onOpenCall).not.toHaveBeenCalled();
    }
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));
    voiceStore.flush();
    (container.querySelector('[data-channel-id="3"]') as HTMLElement).click();
    expect(onOpenCall).toHaveBeenCalledOnce();
  });

  // ── V9: a collapsed category keeps the voice channel you are in ──

  it("a collapsed category still shows the joined voice channel (V9)", () => {
    setChannels([
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ]);
    // Nobody is in either channel, so only being joined can keep a row.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    uiStore.setState((prev) => ({
      ...prev,
      collapsedCategories: new Set(["Voice Channels"]),
    }));
    sidebar.mount(container);

    expect(container.querySelector('[data-channel-id="3"]')).not.toBeNull();
    expect(container.querySelector('[data-channel-id="5"]')).toBeNull();

    // Leaving hides it; joining the other channel shows that one instead.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
    voiceStore.flush();
    expect(container.querySelector('[data-channel-id="3"]')).toBeNull();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 5 }));
    voiceStore.flush();
    expect(container.querySelector('[data-channel-id="5"]')).not.toBeNull();
    expect(container.querySelector('[data-channel-id="3"]')).toBeNull();

    // Expanding restores every row.
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set<string>() }));
    uiStore.flush();
    expect(container.querySelector('[data-channel-id="3"]')).not.toBeNull();
    expect(container.querySelector('[data-channel-id="5"]')).not.toBeNull();
  });

  it("a collapsed category hides an empty voice channel the user is not in (V9)", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({
      ...prev,
      collapsedCategories: new Set(["Voice Channels"]),
    }));
    sidebar.mount(container);

    expect(container.querySelector('[data-channel-id="3"]')).toBeNull();
    expect(container.querySelector(".voice-user-item")).toBeNull();
  });

  // ── WP 2B-5: a collapsed category keeps the rows that matter ──

  // ── WP 3D-4d: Hide Muted Channels ──

  describe("Hide Muted Channels", () => {
    const text = (id: number, extra: Partial<ReadyChannel> = {}): ReadyChannel => ({
      id,
      name: `text-${id}`,
      type: "text",
      category: "Text Channels",
      position: id,
      unread_count: 0,
      last_message_id: 1,
      ...extra,
    });
    const voice = (id: number): ReadyChannel => ({
      id,
      name: `voice-${id}`,
      type: "voice",
      category: "Voice Channels",
      position: id,
    });
    const rowIds = (): string[] =>
      Array.from(container.querySelectorAll<HTMLElement>(".channel-item")).map(
        (el) => el.dataset.channelId ?? "",
      );
    const flush = (): void => {
      channelsStore.flush();
      voiceStore.flush();
    };

    beforeEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    afterEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    it("shows muted rows while the preference is off", () => {
      setChannels([text(1), text(2)]);
      muteChannel(2);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "2"]);
    });

    it("hides a muted channel while the preference is on, and keeps unmuted ones", () => {
      setChannels([text(1), text(2), text(3)]);
      muteChannel(2);
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "3"]);
    });

    it("keeps the muted channel you are viewing", () => {
      setChannels([text(1), text(2)]);
      muteChannel(1);
      muteChannel(2);
      setHideMutedChannels(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
      sidebar.mount(container);
      expect(rowIds()).toEqual(["2"]);
    });

    it("keeps a muted channel with an unread mention, but not plain unread", () => {
      setChannels([
        text(1, { unread_count: 2, mention_count: 1 }),
        text(2, { unread_count: 5 }),
        text(3),
      ]);
      muteChannel(1);
      muteChannel(2);
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "3"]);
    });

    it("keeps a muted voice channel that has people in it, and hides an empty one", () => {
      setChannels([text(1), voice(10), voice(11)]);
      muteChannel(10);
      muteChannel(11);
      addVoiceUser(10, 30, "alice");
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "10"]);
    });

    it("keeps the header of a category whose channels are all hidden", () => {
      setChannels([text(1), voice(10)]);
      muteChannel(1);
      setHideMutedChannels(true);
      sidebar.mount(container);
      const headers = Array.from(container.querySelectorAll<HTMLElement>(".category")).map(
        (el) => el.dataset.category,
      );
      expect(headers).toEqual(["Text Channels", "Voice Channels"]);
      expect(rowIds()).toEqual(["10"]);
      expect(
        container
          .querySelector('[data-category="Text Channels"]')
          ?.parentElement?.querySelector(".category-channels-container")?.children.length,
      ).toBe(0);
    });

    it("collapsing a category still works with the preference on", () => {
      setChannels([text(1), text(2, { unread_count: 3 })]);
      muteChannel(1);
      setHideMutedChannels(true);
      uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set(["Text Channels"]) }));
      sidebar.mount(container);
      // Collapsed: only the unread unmuted row remains; the muted one stays hidden.
      expect(rowIds()).toEqual(["2"]);
    });

    it("redraws live when the preference is toggled", () => {
      setChannels([text(1), text(2)]);
      muteChannel(2);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "2"]);

      setHideMutedChannels(true);
      expect(rowIds()).toEqual(["1"]);

      setHideMutedChannels(false);
      expect(rowIds()).toEqual(["1", "2"]);
    });

    it("redraws live when a channel is muted and unmuted", () => {
      setChannels([text(1), text(2)]);
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "2"]);

      muteChannel(2);
      expect(rowIds()).toEqual(["1"]);

      unmuteChannel(2);
      expect(rowIds()).toEqual(["1", "2"]);
    });

    it("a focused row that hides moves focus to the row that took its place", () => {
      setChannels([text(1), text(2), text(3)]);
      setHideMutedChannels(true);
      sidebar.mount(container);
      container.querySelector<HTMLElement>('[data-channel-id="2"]')!.focus();

      muteChannel(2);

      expect(rowIds()).toEqual(["1", "3"]);
      expect(document.activeElement).toBe(container.querySelector('[data-channel-id="3"]'));
    });

    it("the last focused row that hides moves focus to the row before it", () => {
      setChannels([text(1), text(2)]);
      setHideMutedChannels(true);
      sidebar.mount(container);
      container.querySelector<HTMLElement>('[data-channel-id="2"]')!.focus();

      muteChannel(2);

      expect(document.activeElement).toBe(container.querySelector('[data-channel-id="1"]'));
    });

    it("redraws live when you switch channels: the one you leave hides, the one you open shows", () => {
      setChannels([text(1), text(2)]);
      muteChannel(1);
      muteChannel(2);
      setHideMutedChannels(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);

      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
      flush();
      expect(rowIds()).toEqual(["2"]);
    });

    it("redraws live when a mention arrives or a voice user joins", () => {
      setChannels([text(1), text(2), voice(10)]);
      muteChannel(2);
      muteChannel(10);
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);

      channelsStore.setState((prev) => {
        const channels = new Map(prev.channels);
        channels.set(2, { ...channels.get(2)!, unreadCount: 1, mentionCount: 1 });
        return { ...prev, channels };
      });
      flush();
      expect(rowIds()).toEqual(["1", "2"]);

      addVoiceUser(10, 30, "alice");
      flush();
      expect(rowIds()).toEqual(["1", "2", "10"]);
    });

    it("ignores an unrelated preference change", () => {
      setChannels([text(1), text(2)]);
      muteChannel(2);
      setHideMutedChannels(true);
      sidebar.mount(container);
      const before = container.querySelector('[data-channel-id="1"]');

      window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "fontSize" } }));

      expect(container.querySelector('[data-channel-id="1"]')).toBe(before);
      expect(rowIds()).toEqual(["1"]);
    });
  });

  describe("collapsed category shows what matters", () => {
    const text = (id: number, extra: Partial<ReadyChannel> = {}): ReadyChannel => ({
      id,
      name: `text-${id}`,
      type: "text",
      category: "Text Channels",
      position: id,
      unread_count: 0,
      last_message_id: 1,
      ...extra,
    });
    const collapse = (...names: string[]): void => {
      uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set(names) }));
    };
    const rowIds = (): string[] =>
      Array.from(container.querySelectorAll<HTMLElement>(".channel-item")).map(
        (el) => el.dataset.channelId ?? "",
      );

    beforeEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    afterEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    it("a collapsed group with one unread channel renders exactly that row", () => {
      setChannels([text(1), text(2, { unread_count: 3 }), text(3)]);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["2"]);
    });

    it("a mentioned muted channel shows; a plain-unread muted one hides and leaves no header marker", () => {
      setChannels([
        text(1, { unread_count: 2, mention_count: 1 }),
        text(2, { unread_count: 4 }),
        text(3),
      ]);
      muteChannel(1);
      muteChannel(2);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);
      // The hidden muted row looks read, so the header carries no dot (3D-2b).
      expect(container.querySelector(".category-unread-dot")).toBeNull();
      expect(container.querySelector(".channel-item.unread")).not.toBeNull();
      expect(container.querySelector('[data-channel-id="2"]')).toBeNull();
    });

    it("a mentioned muted channel alone still shows", () => {
      setChannels([text(1, { unread_count: 2, mention_count: 1 }), text(2)]);
      muteChannel(1);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);
    });

    it("keeps a voice channel with a person and hides an empty one", () => {
      setChannels([
        text(1),
        { id: 3, name: "lobby", type: "voice", category: "Voice Channels", position: 0 },
        { id: 5, name: "empty", type: "voice", category: "Voice Channels", position: 1 },
      ]);
      addVoiceUser(3, 30, "alice");
      collapse("Voice Channels");
      sidebar.mount(container);
      expect(container.querySelector('[data-channel-id="3"]')).not.toBeNull();
      expect(container.querySelector('[data-channel-id="5"]')).toBeNull();
      expect(container.querySelector('.voice-user-item[data-voice-uid="30"]')).not.toBeNull();
      // Live: the last person leaving hides the row again.
      voiceStore.setState((prev) => ({ ...prev, voiceUsers: new Map() }));
      voiceStore.flush();
      expect(container.querySelector('[data-channel-id="3"]')).toBeNull();
    });

    it("keeps the active channel", () => {
      setChannels([text(1), text(2), text(3)]);
      setActiveChannel(2);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["2"]);
    });

    it("rows appear and disappear live as unread state changes", () => {
      setChannels([text(1), text(2), text(3)]);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual([]);

      channelsStore.setState((prev) => {
        const channels = new Map(prev.channels);
        channels.set(2, { ...channels.get(2)!, unreadCount: 1 });
        return { ...prev, channels };
      });
      channelsStore.flush();
      expect(rowIds()).toEqual(["2"]);

      channelsStore.setState((prev) => {
        const channels = new Map(prev.channels);
        channels.set(2, { ...channels.get(2)!, unreadCount: 0 });
        return { ...prev, channels };
      });
      channelsStore.flush();
      expect(rowIds()).toEqual([]);
    });

    it("muting a collapsed unread row hides it; unmuting reverses", () => {
      setChannels([text(1, { unread_count: 2 })]);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);
      muteChannel(1);
      expect(rowIds()).toEqual([]);
      unmuteChannel(1);
      expect(rowIds()).toEqual(["1"]);
    });

    it("an expanded category shows every row", () => {
      setChannels([text(1, { unread_count: 2 }), text(2), text(3, { unread_count: 1 })]);
      muteChannel(3);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "2", "3"]);
    });

    it("Move Up in a collapsed category swaps with the row shown above, not a hidden one", () => {
      const onReorderChannel = vi.fn<(reorders: readonly ChannelReorderData[]) => void>();
      sidebar.destroy?.();
      setAdminUser();
      sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onReorderChannel });
      setChannels([text(1, { unread_count: 1 }), text(2), text(3, { unread_count: 1 })]);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "3"]);

      container
        .querySelector('[data-channel-id="3"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
      (document.querySelector('[data-testid="ctx-move-up"]') as HTMLElement).click();

      expect(onReorderChannel).toHaveBeenCalledWith([
        { channelId: 3, newPosition: 1, previousPosition: 3 },
        { channelId: 1, newPosition: 3, previousPosition: 1 },
      ]);
      expect(channelsStore.getState().channels.get(2)?.position).toBe(2);
    });

    it("a focused row that stops showing hands focus to the category arrow", () => {
      setChannels([text(1), text(2, { unread_count: 1 })]);
      collapse("Text Channels");
      sidebar.mount(container);
      const row = container.querySelector<HTMLElement>('[data-channel-id="2"]')!;
      row.focus();
      expect(document.activeElement).toBe(row);

      channelsStore.setState((prev) => {
        const channels = new Map(prev.channels);
        const ch = channels.get(2)!;
        channels.set(2, { ...ch, unreadCount: 0 });
        return { ...prev, channels };
      });
      channelsStore.flush();

      expect(container.querySelector('[data-channel-id="2"]')).toBeNull();
      expect(document.activeElement).toBe(container.querySelector(".category-arrow"));
    });
  });

  // ── Empty state ──

  it("shows empty state when no channels exist", () => {
    sidebar.mount(container);

    const emptyText = container.querySelector(".channel-list-empty-text");
    expect(emptyText).not.toBeNull();
    expect(emptyText!.textContent).toBe("No channels yet");

    const hint = container.querySelector(".channel-list-empty-hint");
    expect(hint).not.toBeNull();
  });

  it("offers a create affordance in the empty state for a channel manager (#9)", () => {
    // With zero channels there is no category header and therefore no "+";
    // the old hint pointed at a right-click that did nothing.
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });
    sidebar.mount(container);

    const btn = container.querySelector<HTMLElement>("[data-testid='create-channel-empty']");
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onCreateChannel).toHaveBeenCalledWith({ id: 0, name: "" });
  });

  it("hides the empty-state create affordance from a non-manager (#9)", () => {
    sidebar.mount(container);
    expect(container.querySelector("[data-testid='create-channel-empty']")).toBeNull();
  });

  // ── Server name updates ──

  it("updates server name when auth store changes", () => {
    sidebar.mount(container);
    const h2 = container.querySelector(".channel-sidebar-header h2");
    expect(h2?.textContent).toBe("Test Server");

    authStore.setState((prev) => ({ ...prev, serverName: "Renamed Server" }));
    authStore.flush();

    expect(h2?.textContent).toBe("Renamed Server");
  });

  it("falls back to 'Server Name' when serverName is null", () => {
    authStore.setState((prev) => ({ ...prev, serverName: null }));
    sidebar.mount(container);

    const h2 = container.querySelector(".channel-sidebar-header h2");
    expect(h2?.textContent).toBe("Server Name");
  });

  // ── Collapsed category shows arrow-right, expanded shows arrow-down ──

  it("collapsed category header has 'collapsed' class", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({
      ...prev,
      collapsedCategories: new Set(["Text Channels"]),
    }));
    sidebar.mount(container);

    const headers = container.querySelectorAll(".category");
    const textHeader = Array.from(headers).find(
      (h) => h.querySelector(".category-name")?.textContent === "Text Channels",
    );
    expect(textHeader).not.toBeUndefined();
    expect(textHeader!.classList.contains("collapsed")).toBe(true);
  });

  // ── Channels store subscription re-renders on channel map changes ──

  it("re-renders when channels store changes after mount", () => {
    sidebar.mount(container);
    expect(container.querySelectorAll(".channel-item").length).toBe(0);

    // Add channels after mount
    setChannels(testChannels);
    channelsStore.flush();

    expect(container.querySelectorAll(".channel-item").length).toBe(4);
  });

  // ── Destroy cleanup ──

  it("destroy removes the sidebar from the DOM", () => {
    setChannels(testChannels);
    sidebar.mount(container);
    expect(container.querySelector('[data-testid="channel-sidebar"]')).not.toBeNull();

    sidebar.destroy?.();
    expect(container.querySelector('[data-testid="channel-sidebar"]')).toBeNull();
  });

  // ── Drag reorder setup for admin (attaches drag handlers) ──

  it("admin sidebar with onReorderChannel adds channel-draggable class to items", () => {
    const onReorderChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onReorderChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    // Admin + onReorderChannel -> items should have channel-draggable class
    const draggables = container.querySelectorAll(".channel-draggable");
    expect(draggables.length).toBeGreaterThan(0);
  });

  it("non-admin does not get draggable class on channel items", () => {
    const onReorderChannel = vi.fn();
    sidebar.destroy?.();
    signInAs({ id: 2, username: "Member", avatar: null, role: "member" });
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onReorderChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const draggables = container.querySelectorAll(".channel-draggable");
    expect(draggables.length).toBe(0);
  });

  it("destroy cleans up global drag listeners when last sidebar instance is destroyed", () => {
    const onReorderChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onReorderChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    // After mount with drag support, destroy should not throw
    sidebar.destroy?.();

    // Verify sidebar is removed
    expect(container.querySelector('[data-testid="channel-sidebar"]')).toBeNull();

    // Re-create for afterEach cleanup
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
  });
});

// ── Text rows and groups drawn from row models (5.4d-1) ──
//
// The text rows and category groups reconcile from models, so a row's node is
// kept unless something it draws changed. The row's handlers are bound from
// the model too (`access`, `orderIds`), so a role edit rebinds them.
describe("ChannelSidebar text rows and groups on models", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  const VOICE_CH = 3; // "voice-lobby" in testChannels

  function row(channelId: number): HTMLElement | null {
    return container.querySelector<HTMLElement>(`.channel-item[data-channel-id="${channelId}"]`);
  }

  function ctxMenuFor(channelId: number): HTMLElement | null {
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
    row(channelId)!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    return document.querySelector<HTMLElement>('[data-testid="channel-context-menu"]');
  }

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });

  it("an unread count change keeps the focused row's node", () => {
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    setChannels(testChannels); // channel 1 starts with 2 unread
    sidebar.mount(container);
    const focused = row(1)!;
    focused.focus();
    expect(document.activeElement).toBe(focused);
    expect(focused.classList.contains("unread")).toBe(true);

    incrementUnread(1);
    channelsStore.flush();

    // 2 -> 3: the row looks the same, so the node, its focus and its roving
    // tab stop are untouched (it used to be rebuilt and refocused by key).
    expect(channelsStore.getState().channels.get(1)!.unreadCount).toBe(3);
    expect(row(1)).toBe(focused);
    expect(document.activeElement).toBe(focused);
    expect(focused.getAttribute("tabindex")).toBe("0");
  });

  it("a change that flips how the row looks rebuilds it and focus follows", () => {
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    setChannels(testChannels); // channel 2 starts read
    sidebar.mount(container);
    const before = row(2)!;
    before.focus();
    expect(before.classList.contains("unread")).toBe(false);

    incrementUnread(2);
    channelsStore.flush();

    const after = row(2)!;
    expect(after).not.toBe(before);
    expect(after.classList.contains("unread")).toBe(true);
    expect(document.activeElement).toBe(after);
  });

  it("a MANAGE_MESSAGES-only role edit rebinds every text row's menu and keeps voice focus", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: 0 }]);
    signInAs({ id: 3, username: "Mod", avatar: null, role: "moderator" });
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn(), onPurgeChannel });
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);

    const textIds = [1, 2, 4];
    for (const id of textIds) {
      expect(ctxMenuFor(id), `menu ${id}`).not.toBeNull();
      expect(document.querySelector('[data-testid="ctx-purge-messages"]')).toBeNull();
    }
    const voiceWrapper = row(VOICE_CH)!.parentElement;
    const participant = container.querySelector<HTMLElement>(
      '.voice-user-item[data-voice-uid="11"]',
    )!;
    participant.focus();
    expect(document.activeElement).toBe(participant);

    // Only the permission mask changes: no channel, voice or role-name event.
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_MESSAGES }]);
    channelsStore.flush();

    for (const id of textIds) {
      expect(ctxMenuFor(id), `menu ${id}`).not.toBeNull();
      expect(
        document.querySelector('[data-testid="ctx-purge-messages"]'),
        `Purge on ${id}`,
      ).not.toBeNull();
    }
    // The voice wrapper rebound too (a rebuild), and focus followed the key.
    expect(row(VOICE_CH)!.parentElement).not.toBe(voiceWrapper);
    expect(document.activeElement).toBe(
      container.querySelector('.voice-user-item[data-voice-uid="11"]'),
    );
  });

  function setModeratorMask(permissions: number): void {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions }]);
    channelsStore.flush();
  }

  function useModerator(): void {
    signInAs({ id: 3, username: "Mod", avatar: null, role: "moderator" });
  }

  it("a MANAGE_INVITES-only role edit grants and revokes Invite People on text and voice rows", () => {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: 0 }]);
    useModerator();
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onOpenCall: vi.fn(),
      onInviteFromChannel: vi.fn(),
    });
    setChannels(testChannels);
    sidebar.mount(container);
    const invite = (): Element | null =>
      document.querySelector('[data-testid="ctx-invite-people"]');

    for (const id of [1, VOICE_CH]) {
      ctxMenuFor(id);
      expect(invite(), `no invite on ${id}`).toBeNull();
    }

    // Only the permission mask changes: no channel, voice or role-name event.
    setModeratorMask(Permission.MANAGE_INVITES);
    for (const id of [1, VOICE_CH]) {
      expect(ctxMenuFor(id), `menu ${id}`).not.toBeNull();
      expect(invite(), `invite on ${id}`).not.toBeNull();
    }

    setModeratorMask(0);
    for (const id of [1, VOICE_CH]) {
      ctxMenuFor(id);
      expect(invite(), `invite gone on ${id}`).toBeNull();
    }
  });

  it("losing MANAGE_CHANNELS while mounted strips drag and the Edit, Delete and Move entries", () => {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    useModerator();
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onOpenCall: vi.fn(),
      onReorderChannel: vi.fn(),
      onEditChannel: vi.fn(),
      onDeleteChannel: vi.fn(),
    });
    setChannels(testChannels);
    sidebar.mount(container);
    const ids = [1, 2, VOICE_CH];
    const testIds = [
      "ctx-edit-channel",
      "ctx-delete-channel",
      "ctx-move-up",
      "ctx-move-down",
    ] as const;

    for (const id of ids) {
      if (id !== VOICE_CH) {
        expect(row(id)!.classList.contains("channel-draggable"), `draggable ${id}`).toBe(true);
        expect(row(id)!.hasAttribute("data-drag-channel-id"), `drag id ${id}`).toBe(true);
      }
      expect(ctxMenuFor(id), `menu ${id}`).not.toBeNull();
      for (const t of testIds) {
        expect(document.querySelector(`[data-testid="${t}"]`), `${t} on ${id}`).not.toBeNull();
      }
    }

    // Only the permission mask changes: no channel, voice or role-name event.
    setModeratorMask(0);

    expect(container.querySelector(".channel-draggable")).toBeNull();
    expect(container.querySelector("[data-drag-channel-id]")).toBeNull();
    for (const id of ids) {
      ctxMenuFor(id);
      for (const t of testIds) {
        expect(document.querySelector(`[data-testid="${t}"]`), `${t} gone on ${id}`).toBeNull();
      }
    }
  });

  it("a voice capacity edit patches the label and keeps the wrapper", () => {
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    const withMax = (max: number): ReadyChannel[] =>
      testChannels.map((c) => (c.id === VOICE_CH ? { ...c, voice_max_users: max } : c));
    setChannels(withMax(5));
    addVoiceUser(VOICE_CH, 10, "alice");
    sidebar.mount(container);
    const wrapper = row(VOICE_CH)!.parentElement;
    const label = (): string | null | undefined =>
      container.querySelector(`[data-testid="channel-capacity-${VOICE_CH}"]`)?.textContent;
    expect(label()).toBe("1/5");

    setChannels(withMax(8));
    channelsStore.flush();

    expect(label()).toBe("1/8");
    expect(row(VOICE_CH)!.parentElement).toBe(wrapper);
  });

  it("an edit action acts on the live channel, not the one the row was built for", () => {
    const onEditChannel = vi.fn<(channel: Channel) => void>();
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn(), onEditChannel });
    setChannels(testChannels);
    sidebar.mount(container);
    const before = row(2)!;

    // A topic edit is not drawn, so the row is kept; its Edit must still
    // hand over the current channel.
    updateChannel({ id: 2, topic: "new topic" });
    channelsStore.flush();
    expect(row(2)).toBe(before);

    expect(ctxMenuFor(2)).not.toBeNull();
    document.querySelector<HTMLElement>('[data-testid="ctx-edit-channel"]')!.click();
    expect(onEditChannel).toHaveBeenCalledTimes(1);
    expect(onEditChannel.mock.calls[0]![0]).toMatchObject({ id: 2, topic: "new topic" });
  });
});

describe("ChannelSidebar on one select", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  const text = (id: number, extra: Partial<ReadyChannel> = {}): ReadyChannel => ({
    id,
    name: `text-${id}`,
    type: "text",
    category: "Text Channels",
    position: id,
    unread_count: 0,
    last_message_id: 1,
    ...extra,
  });
  const rowIds = (): string[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".channel-item")).map(
      (el) => el.dataset.channelId ?? "",
    );
  const row = (id: number): HTMLElement | null =>
    container.querySelector<HTMLElement>(`.channel-item[data-channel-id="${id}"]`);

  beforeEach(() => {
    resetStores();
    // Mutes persist across tests; start with none.
    unmuteChannel(1);
    unmuteChannel(2);
    invalidateMuteCache();
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    vi.restoreAllMocks();
  });

  it("a muted channel that gains a mention under a collapsed category shows with its badge, and keeps it when expanded", () => {
    setChannels([text(1), text(2)]);
    muteChannel(2);
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set(["Text Channels"]) }));
    sidebar.mount(container);
    expect(rowIds()).toEqual([]);

    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(2, { ...channels.get(2)!, unreadCount: 1, mentionCount: 1 });
      return { ...prev, channels };
    });
    channelsStore.flush();
    expect(rowIds()).toEqual(["2"]);
    expect(row(2)!.querySelector(".mention-badge")?.textContent).toBe("1");
    const badgeText = row(2)!.textContent;

    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set<string>() }));
    uiStore.flush();
    expect(rowIds()).toEqual(["1", "2"]);
    expect(row(2)!.textContent).toBe(badgeText);
    expect(row(2)!.querySelector(".mention-badge")?.textContent).toBe("1");
  });

  it("mount subscribes only through select", () => {
    const stores = [voiceStore, membersStore, authStore, channelsStore, uiStore, safetyStore];
    const subscribe = stores.map((s) => vi.spyOn(s, "subscribe"));
    const selector = stores.map((s) => vi.spyOn(s, "subscribeSelector"));
    setChannels([text(1)]);

    sidebar.mount(container);

    for (const spy of selector) expect(spy).not.toHaveBeenCalled();
    for (const spy of subscribe) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("muting through muteChannel ends with the row muted", () => {
    setChannels([text(1), text(2)]);
    sidebar.mount(container);
    expect(row(2)!.classList.contains("muted")).toBe(false);

    muteChannel(2);

    expect(row(2)!.classList.contains("muted")).toBe(true);
  });

  it("a mute pref-change alone does not redraw; the mute announcement does", () => {
    setChannels([text(1), text(2)]);
    sidebar.mount(container);
    const before = row(2)!;
    expect(before.classList.contains("muted")).toBe(false);

    // Write the list the way writeMuted saves it (a bare id is a forever mute),
    // then drop the cache the module's own pref-change listener would drop.
    const key =
      getChannelMutesHost() === null ? "mutedChannels" : `mutedChannels:${getChannelMutesHost()}`;
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify([2]));
    invalidateMuteCache();
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key } }));

    expect(row(2)).toBe(before);
    expect(row(2)!.classList.contains("muted")).toBe(false);

    window.dispatchEvent(new CustomEvent(CHANNEL_MUTE_CHANGED, { detail: { channelId: 2 } }));

    expect(row(2)!.classList.contains("muted")).toBe(true);
  });

  it("destroy then a store change touches no row", () => {
    setChannels([text(1), text(2)]);
    sidebar.mount(container);
    const first = row(1)!;
    const second = row(2)!;
    const observer = new MutationObserver(() => {});
    observer.observe(first, { attributes: true, childList: true, subtree: true });
    observer.observe(second, { attributes: true, childList: true, subtree: true });
    const nameBefore = container.querySelector("h2");

    sidebar.destroy?.();
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
    channelsStore.flush();
    setRoles([{ id: 9, name: "x", color: null, permissions: 0 }]);
    channelsStore.flush();
    authStore.setState((prev) => ({ ...prev, serverName: "Renamed" }));
    authStore.flush();
    window.dispatchEvent(new CustomEvent("owncord:channel-mute-changed"));
    muteChannel(1);

    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    expect(container.querySelector(".channel-sidebar")).toBeNull();
    expect(nameBefore?.textContent).toBe("Test Server");
  });
});
