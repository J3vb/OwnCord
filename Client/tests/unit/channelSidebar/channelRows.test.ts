import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as mocks from "../../helpers/channelSidebarMocks";
import { createChannelSidebar } from "../../../src/components/ChannelSidebar";
import {
  addChannel,
  channelsStore,
  setChannels,
  updateChannel,
} from "../../../src/stores/channels.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { resetStores, addVoiceUser, testChannels } from "../../helpers/channelSidebarHarness";
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

// ── Channel feature flags in the sidebar ──
//
// nsfw and voice_max_users reach the sidebar through the channel store, so
// these mount a fresh sidebar per case rather than reusing another suite's
// fixture (which seeds voice users and identity state the readouts would pick
// up).
describe("ChannelSidebar channel feature flags", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let onVoiceJoin: Mock<(channelId: number) => void>;
  let onOpenCall: Mock<() => void>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    onVoiceJoin = vi.fn<(channelId: number) => void>();
    onOpenCall = vi.fn<() => void>();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
  });
  describe("NSFW indicator", () => {
    it("marks a flagged text channel", () => {
      setChannels([
        { id: 1, name: "spicy", type: "text", category: "Text Channels", position: 0, nsfw: true },
        { id: 2, name: "general", type: "text", category: "Text Channels", position: 1 },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-nsfw-1']")).not.toBeNull();
      expect(container.querySelector("[data-testid='channel-nsfw-2']")).toBeNull();
    });

    it("marks a flagged voice channel too", () => {
      setChannels([
        { id: 5, name: "lounge", type: "voice", category: "Voice", position: 0, nsfw: true },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-nsfw-5']")).not.toBeNull();
    });

    // The marker is information, not a state — it must not colonise the "#"
    // glyph or the name, which already encode unread/mention/active.
    it("leaves the channel name intact", () => {
      setChannels([
        { id: 1, name: "spicy", type: "text", category: "Text Channels", position: 0, nsfw: true },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-1'] .ch-name")?.textContent).toBe(
        "spicy",
      );
    });
  });

  describe("private channel lock", () => {
    const lock = (id: number): Element | null =>
      container.querySelector(`[data-testid='channel-private-${id}']`);

    it("shows on text, announcement and voice rows, with a title and aria-label", () => {
      setChannels([
        { id: 1, name: "staff", type: "text", category: "Text", position: 0, private: true },
        { id: 2, name: "news", type: "announcement", category: "Text", position: 1, private: true },
        { id: 3, name: "war-room", type: "voice", category: "Voice", position: 0, private: true },
      ]);
      sidebar.mount(container);

      for (const id of [1, 2, 3]) {
        const badge = lock(id);
        expect(badge).not.toBeNull();
        expect(badge?.getAttribute("title")).toBe("Private channel");
        expect(badge?.getAttribute("aria-label")).toBe("Private channel");
        expect(badge?.querySelector("svg")).not.toBeNull();
      }
    });

    it("is not inside the aria-hidden glyph, so it stays announced", () => {
      setChannels([
        { id: 1, name: "staff", type: "text", category: "Text", position: 0, private: true },
      ]);
      sidebar.mount(container);

      expect(lock(1)?.closest("[aria-hidden='true']")).toBeNull();
    });

    it("is absent on a non-private row and on a row from an older server", () => {
      setChannels([
        { id: 1, name: "a", type: "text", category: "Text", position: 0, private: false },
        { id: 2, name: "b", type: "text", category: "Text", position: 1 },
        { id: 3, name: "c", type: "voice", category: "Voice", position: 0 },
      ]);
      sidebar.mount(container);

      expect(lock(1)).toBeNull();
      expect(lock(2)).toBeNull();
      expect(lock(3)).toBeNull();
    });

    it("coexists with the nsfw marker and the voice capacity badge", () => {
      setChannels([
        {
          id: 1,
          name: "staff",
          type: "text",
          category: "Text",
          position: 0,
          private: true,
          nsfw: true,
        },
        {
          id: 5,
          name: "war-room",
          type: "voice",
          category: "Voice",
          position: 0,
          private: true,
          nsfw: true,
          voice_max_users: 5,
        },
      ]);
      sidebar.mount(container);

      expect(lock(1)).not.toBeNull();
      expect(container.querySelector("[data-testid='channel-nsfw-1']")).not.toBeNull();
      expect(lock(5)).not.toBeNull();
      expect(container.querySelector("[data-testid='channel-nsfw-5']")).not.toBeNull();
      expect(container.querySelector("[data-testid='channel-capacity-5']")).not.toBeNull();
    });

    it("redraws the row live when a channel_create flips the flag, both ways", () => {
      setChannels([
        { id: 1, name: "staff", type: "text", category: "Text", position: 0, private: false },
      ]);
      sidebar.mount(container);
      expect(lock(1)).toBeNull();

      addChannel({
        id: 1,
        name: "staff",
        type: "text",
        category: "Text",
        position: 0,
        private: true,
      });

      channelsStore.flush();
      expect(lock(1)).not.toBeNull();

      // An older-server frame without the key keeps the lock.
      addChannel({ id: 1, name: "staff", type: "text", category: "Text", position: 0 });
      channelsStore.flush();
      expect(lock(1)).not.toBeNull();

      addChannel({
        id: 1,
        name: "staff",
        type: "text",
        category: "Text",
        position: 0,
        private: false,
      });

      channelsStore.flush();
      expect(lock(1)).toBeNull();
    });

    it("redraws the row live when a channel_update flips the flag", () => {
      setChannels([
        { id: 1, name: "staff", type: "text", category: "Text", position: 0, private: false },
      ]);
      sidebar.mount(container);

      updateChannel({ id: 1, private: true });

      channelsStore.flush();
      expect(lock(1)).not.toBeNull();

      updateChannel({ id: 1, name: "staff-room" });

      channelsStore.flush();
      expect(lock(1)).not.toBeNull();

      updateChannel({ id: 1, private: false });

      channelsStore.flush();
      expect(lock(1)).toBeNull();
    });
  });

  describe("AFK channel marker", () => {
    const afkTestId = "[data-testid='channel-afk-5']";

    it("shows a moon and an AFK label on the AFK channel only", () => {
      setChannels([
        { id: 5, name: "parking", type: "voice", category: "Voice", position: 0, afk: true },
        { id: 6, name: "lounge", type: "voice", category: "Voice", position: 1 },
      ]);
      sidebar.mount(container);

      const badge = container.querySelector(afkTestId);
      expect(badge?.textContent).toBe("AFK");
      expect(badge?.querySelector("svg")?.getAttribute("data-icon")).toBe("moon");
      expect(container.querySelector("[data-testid='channel-afk-6']")).toBeNull();
    });

    it("appears and disappears in place when the flag changes", () => {
      setChannels([{ id: 5, name: "parking", type: "voice", category: "Voice", position: 0 }]);
      sidebar.mount(container);
      expect(container.querySelector(afkTestId)).toBeNull();
      const wrapper = container.querySelector("[data-testid='channel-5']")!.parentElement;

      updateChannel({ id: 5, afk: true });
      channelsStore.flush();
      expect(container.querySelector(afkTestId)?.textContent).toBe("AFK");
      expect(container.querySelector("[data-testid='channel-5']")!.parentElement).toBe(wrapper);

      updateChannel({ id: 5, afk: false });
      channelsStore.flush();
      expect(container.querySelector(afkTestId)).toBeNull();
    });
  });

  describe("voice capacity readout", () => {
    it("shows connected/limit when the channel has a user limit", () => {
      setChannels([
        {
          id: 5,
          name: "lounge",
          type: "voice",
          category: "Voice",
          position: 0,
          voice_max_users: 5,
        },
      ]);
      addVoiceUser(5, 10, "Alice");
      addVoiceUser(5, 11, "Bob");
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-capacity-5']")?.textContent).toBe(
        "2/5",
      );
    });

    it("shows 0/limit for an empty limited channel", () => {
      setChannels([
        {
          id: 5,
          name: "lounge",
          type: "voice",
          category: "Voice",
          position: 0,
          voice_max_users: 3,
        },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-capacity-5']")?.textContent).toBe(
        "0/3",
      );
    });

    // "3/0" would read as a bug, and the participant rows underneath already
    // show the count.
    it("shows nothing when the channel is unlimited", () => {
      setChannels([{ id: 5, name: "lounge", type: "voice", category: "Voice", position: 0 }]);
      addVoiceUser(5, 10, "Alice");
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-capacity-5']")).toBeNull();
    });

    it("is not rendered for a text channel", () => {
      setChannels([
        { id: 1, name: "general", type: "text", category: "Text Channels", position: 0 },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-capacity-1']")).toBeNull();
    });

    // The client never blocks the join: its participant list can lag, and a
    // refusal it invented would be uncorrectable. The server answers with
    // CHANNEL_FULL.
    it("still joins on click when the channel looks full", () => {
      setChannels([
        {
          id: 5,
          name: "lounge",
          type: "voice",
          category: "Voice",
          position: 0,
          voice_max_users: 1,
        },
      ]);
      addVoiceUser(5, 10, "Alice");
      sidebar.mount(container);

      (container.querySelector("[data-testid='channel-5']") as HTMLElement).click();

      expect(onVoiceJoin).toHaveBeenCalledWith(5);
    });
  });
});

// ── Per-row listeners must not outlive the render that created them (OC-0229) ──
//
// A row's listeners (context menu, drag handlers, ...) must never be registered
// on the sidebar's single factory-lifetime AbortSignal, which only aborts once,
// in destroy(): that signal's "abort" algorithm list is what actually keeps a
// DOM node alive in a browser once addEventListener({ signal }) has been called
// on it, so a detached row whose listener is still on that signal is retained
// for the sidebar's entire lifetime.
//
// B9-21 keys the list, so an unchanged row is now REUSED across a re-render
// instead of being detached and rebuilt. A replaced row (its signature changed)
// must still be disposed before it detaches, or the old leak returns for that
// row. This pins both halves of the keyed contract: identity is kept for an
// unchanged row, and the listeners of a replaced one die with it.
describe("ChannelSidebar row listeners across re-renders", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
  });

  it("reuses an unchanged row's node across a re-render (no detach, no relisten)", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const row = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(row).not.toBeNull();

    // Provoke renderChannels() the same way incrementUnread does for every
    // message delivered to a non-active channel: a fresh channels Map with
    // fresh Channel object references flows through the `s.channels`
    // selector, which is not shallow-equal to the previous one.
    setChannels(testChannels);
    channelsStore.flush();

    // The row is unchanged, so the keyed list reuses the node; its context
    // menu still works and was never re-registered.
    const after = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(after).toBe(row);
    expect(after.isConnected).toBe(true);
    after.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    expect(document.querySelector(".channel-ctx-menu")).not.toBeNull();
  });

  it("reorders rows live when a channel_update changes only a position", () => {
    setChannels(testChannels);
    sidebar.mount(container);
    const order = () =>
      Array.from(container.querySelectorAll(".category-channels-container .channel-item"))
        .map((el) => (el as HTMLElement).dataset.channelId)
        .filter((id) => id === "1" || id === "2");
    expect(order()).toEqual(["1", "2"]);

    updateChannel({ id: 1, position: 5 });
    channelsStore.flush();

    expect(order()).toEqual(["2", "1"]);
  });

  it("disposes a replaced row so its context-menu listener cannot fire again", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const staleRow = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(staleRow).not.toBeNull();

    // Rename channel 1: its signature changes, so the keyed list replaces the
    // node instead of reusing it.
    setChannels(testChannels.map((c) => (c.id === 1 ? { ...c, name: "renamed" } : c)));
    channelsStore.flush();

    const freshRow = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(freshRow).not.toBeNull();
    expect(freshRow).not.toBe(staleRow);
    expect(staleRow.isConnected).toBe(false);

    // The replaced, detached row must not still be able to open a menu -- if
    // it does, its listener is still registered (on a signal that only aborts
    // at sidebar destroy()), which is the retention this finding is about.
    staleRow.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    expect(document.querySelector(".channel-ctx-menu")).toBeNull();

    // The replacement row works normally.
    freshRow.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    expect(document.querySelector(".channel-ctx-menu")).not.toBeNull();
  });
});

// ── Sidebar popovers must not close on an unrelated re-render (OC-0282) ──
//
// The channel context menu and the voice-user volume/moderation menu bridge
// their "close if the sidebar goes away" listener onto renderChannels()'s
// render-scoped AbortSignal, not the sidebar's own lifetime signal. Since
// renderChannels() aborts and replaces that signal on EVERY re-render, an
// open popover is torn down by events that have nothing to do with it -- a
// message in another channel, a peer toggling their mic, a category
// collapsing.
describe("ChannelSidebar popovers survive unrelated re-renders", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu, .user-vol-menu").forEach((el) => el.remove());
  });

  it("keeps the channel context menu open across a re-render unrelated to the menu", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    expect(document.querySelector('[data-testid="channel-context-menu"]')).not.toBeNull();

    // Unrelated re-render, the same shape as a message landing in another
    // channel (dispatcher -> incrementUnread -> new channels Map ->
    // renderChannels()). The open menu has nothing to do with this.
    setChannels(testChannels);
    channelsStore.flush();

    expect(document.querySelector('[data-testid="channel-context-menu"]')).not.toBeNull();
  });

  it("keeps the voice-user volume menu open when an unrelated peer's voice state changes", async () => {
    signInAs({ id: 99, username: "Me", avatar: null, role: "member" });
    setChannels(testChannels);
    addVoiceUser(3, 80, "OtherUser");
    sidebar.mount(container);

    const voiceRow = container.querySelector(
      '.voice-user-item[data-voice-uid="80"]',
    ) as HTMLElement;
    voiceRow.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 150, clientY: 250 }),
    );
    await vi.dynamicImportSettled();
    expect(document.querySelector(".user-vol-menu")).not.toBeNull();

    // Unrelated re-render: a DIFFERENT peer joins/toggles state in the same
    // channel, firing the voice store's structural-signature subscription.
    addVoiceUser(3, 81, "AnotherUser", { muted: true });
    voiceStore.flush();

    expect(document.querySelector(".user-vol-menu")).not.toBeNull();
  });
});
