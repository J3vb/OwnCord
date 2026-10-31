import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/sidebarAreaMocks";
import { createSidebarArea } from "../../../src/pages/main-page/SidebarArea";
import { channelsStore } from "../../../src/stores/channels.store";
import { uiStore } from "../../../src/stores/ui.store";
import { authStore } from "../../../src/stores/auth.store";
import { dmStore, setDmChannels } from "../../../src/stores/dm.store";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createVoiceWidget } from "@components/VoiceWidget";
import { createCreateChannelModal } from "@components/CreateChannelModal";
import "../../../src/pages/main-page/MemberPickerModal";
import { createEditChannelModal } from "@components/EditChannelModal";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";
import { createQuickSwitchOverlay } from "@components/QuickSwitchOverlay";
import { createProfileManager } from "@lib/presence/profiles";
import {
  MockedFn,
  getMockDestroy,
  resetStores,
  resetMocks,
  enterVoiceAndAwaitWidget,
  defaultOpts,
  cleanup,
} from "../../helpers/sidebarAreaHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/presence/profiles", () => mocks.presenceProfilesMock());
vi.mock("@components/ChannelSidebar", () => mocks.channelSidebarMock());
vi.mock("@components/DmSidebar", () => mocks.dmSidebarMock());
vi.mock("@components/MemberList", () => mocks.memberListMock());
vi.mock("@components/UserBar", () => mocks.userBarMock());
vi.mock("@components/VoiceWidget", () => mocks.voiceWidgetMock());
vi.mock("@components/QuickSwitchOverlay", () => mocks.quickSwitchOverlayMock());
vi.mock("@components/CreateChannelModal", () => mocks.createChannelModalMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@components/EditChannelModal", () => mocks.editChannelModalMock());
vi.mock("@components/DeleteChannelModal", () => mocks.deleteChannelModalMock());
vi.mock("../../../src/pages/main-page/VoiceCallbacks", () => mocks.pageVoiceCallbacksMock());
vi.mock("../../../src/pages/main-page/OverlayManagers", () => mocks.pageOverlayManagersMock());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SidebarArea", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    resetMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    // Clean up any modals left on body
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  // -------------------------------------------------------------------------
  // Channel sidebar callbacks
  // -------------------------------------------------------------------------

  describe("channel sidebar callbacks", () => {
    it("passes correct callbacks to createChannelSidebar", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createChannelSidebar).toHaveBeenCalled();
      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      expect(typeof callArgs.onVoiceJoin).toBe("function");
      expect(typeof callArgs.onOpenCall).toBe("function");
      expect(callArgs).not.toHaveProperty("onVoiceLeave");
      expect(typeof callArgs.onCreateChannel).toBe("function");
      expect(typeof callArgs.onEditChannel).toBe("function");
      expect(typeof callArgs.onDeleteChannel).toBe("function");
      expect(typeof callArgs.onReorderChannel).toBe("function");
      expect(typeof callArgs.onPurgeChannel).toBe("function");

      cleanup(result);
    });

    it("the voice widget's call name opens a guild call only after leaving DM mode has shown the channel (1B-1)", async () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
      const onOpenCall = vi.fn();
      const result = createSidebarArea({ ...defaultOpts(), onOpenCall });
      container.appendChild(result.sidebarWrapper);
      await enterVoiceAndAwaitWidget();

      // The page's channel subscriber shows that channel's chat; the call
      // view must open after it, not before.
      const order: string[] = [];
      const unsub = channelsStore.subscribe(() => order.push("channel shown"));
      onOpenCall.mockImplementation(() => order.push("call opened"));
      try {
        const widgetArgs = (createVoiceWidget as MockedFn).mock.calls.at(-1)![0];
        widgetArgs.onOpenCall(4242);
        expect(onOpenCall).not.toHaveBeenCalled();

        await Promise.resolve();
        await Promise.resolve();
        expect(uiStore.getState().sidebarMode).toBe("channels");
        expect(onOpenCall).toHaveBeenCalledOnce();
        expect(order.at(-1)).toBe("call opened");
      } finally {
        unsub();
        cleanup(result);
      }
    });

    it("openCall (the phone call bar's tap) opens a guild call at once from the server view", () => {
      const onOpenCall = vi.fn();
      const result = createSidebarArea({ ...defaultOpts(), onOpenCall });
      container.appendChild(result.sidebarWrapper);

      result.openCall(4242);

      expect(onOpenCall).toHaveBeenCalledOnce();
      cleanup(result);
    });

    it("openCall leaves DM mode before opening a guild call", async () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
      const onOpenCall = vi.fn();
      const result = createSidebarArea({ ...defaultOpts(), onOpenCall });
      container.appendChild(result.sidebarWrapper);

      result.openCall(4242);
      expect(onOpenCall).not.toHaveBeenCalled();
      await Promise.resolve();
      await Promise.resolve();

      expect(uiStore.getState().sidebarMode).toBe("channels");
      expect(onOpenCall).toHaveBeenCalledOnce();
      cleanup(result);
    });

    it("openCall opens a DM call by selecting the DM, not the call view", () => {
      setDmChannels([
        {
          channelId: 77,
          recipient: { id: 7, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 7, username: "bob", avatar: "", status: "online" }],
          name: "",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ]);
      dmStore.flush();
      const onOpenCall = vi.fn();
      const result = createSidebarArea({ ...defaultOpts(), onOpenCall });
      container.appendChild(result.sidebarWrapper);

      result.openCall(77);

      expect(channelsStore.getState().activeChannelId).toBe(77);
      expect(uiStore.getState().sidebarMode).toBe("dms");
      expect(onOpenCall).not.toHaveBeenCalled();
      cleanup(result);
    });

    it("onOpenCall forwards to the page's call opener", () => {
      const onOpenCall = vi.fn();
      const result = createSidebarArea({ ...defaultOpts(), onOpenCall });
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onOpenCall();

      expect(onOpenCall).toHaveBeenCalledOnce();

      cleanup(result);
    });

    it("onCreateChannel opens create channel modal", async () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onCreateChannel("General");
      await vi.dynamicImportSettled();

      expect(createCreateChannelModal).toHaveBeenCalled();

      cleanup(result);
    });

    it("onCreateChannel does not open a second modal if one is active", async () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onCreateChannel("General");
      await vi.dynamicImportSettled();
      callArgs.onCreateChannel("Another");
      await vi.dynamicImportSettled();

      expect(createCreateChannelModal).toHaveBeenCalledTimes(1);

      cleanup(result);
    });

    it("onEditChannel opens edit channel modal", async () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onEditChannel({ id: 1, name: "general", type: "text" });
      await vi.dynamicImportSettled();

      expect(createEditChannelModal).toHaveBeenCalled();

      cleanup(result);
    });

    it("onEditChannel opens nothing when the sidebar is torn down while the editor loads", async () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onEditChannel({ id: 1, name: "general", type: "text" });
      cleanup(result);
      await vi.dynamicImportSettled();

      expect(createEditChannelModal).not.toHaveBeenCalled();
    });

    it("onDeleteChannel opens delete channel modal", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onDeleteChannel({ id: 1, name: "general" });

      expect(createDeleteChannelModal).toHaveBeenCalled();

      cleanup(result);
    });

    it("onPurgeChannel calls the purge API and toasts the server's count", async () => {
      const opts = defaultOpts();
      const toast = { show: vi.fn() };
      (opts.getToast as MockedFn).mockReturnValue(toast);
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      await callArgs.onPurgeChannel({ id: 1, name: "general" }, 50);

      expect(opts.api.purgeMessages).toHaveBeenCalledWith(1, 50);
      expect(toast.show).toHaveBeenCalledWith("Purged 2 messages from #general", "success");

      cleanup(result);
    });

    it("onPurgeChannel surfaces a failure as an error toast", async () => {
      const opts = defaultOpts();
      const toast = { show: vi.fn() };
      (opts.getToast as MockedFn).mockReturnValue(toast);
      (opts.api.purgeMessages as MockedFn).mockRejectedValue(new Error("forbidden"));
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      await callArgs.onPurgeChannel({ id: 1, name: "general" }, 50);

      expect(toast.show).toHaveBeenCalledWith("forbidden", "error");

      cleanup(result);
    });

    it("onReorderChannel calls API for each reorder", () => {
      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onReorderChannel([
        { channelId: 1, newPosition: 0 },
        { channelId: 2, newPosition: 1 },
      ]);

      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(1, { position: 0 });
      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(2, { position: 1 });

      cleanup(result);
    });

    it("onReorderChannel surfaces a failed write as an error toast", async () => {
      // Previously fired with bare `void` and no .catch: a rejected PATCH left
      // the sidebar showing an order the server never accepted, with nothing
      // telling the admin.
      const opts = defaultOpts();
      const toast = { show: vi.fn() };
      (opts.getToast as MockedFn).mockReturnValue(toast);
      (opts.api.adminUpdateChannel as MockedFn)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("forbidden"));
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onReorderChannel([
        { channelId: 1, newPosition: 0 },
        { channelId: 2, newPosition: 1 },
      ]);

      // Flush the Promise.allSettled(...).then(...) microtask chain.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(1, { position: 0 });
      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(2, { position: 1 });
      expect(toast.show).toHaveBeenCalledWith("Failed to save channel order", "error");

      cleanup(result);
    });

    it("onReorderChannel does not toast when every write succeeds", async () => {
      const opts = defaultOpts();
      const toast = { show: vi.fn() };
      (opts.getToast as MockedFn).mockReturnValue(toast);
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onReorderChannel([{ channelId: 1, newPosition: 0 }]);

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(toast.show).not.toHaveBeenCalled();

      cleanup(result);
    });

    describe("onReorderChannel rollback", () => {
      function seedOrder(positions: Record<number, number>): void {
        channelsStore.setState((prev) => {
          const channels = new Map(prev.channels);
          for (const [id, position] of Object.entries(positions)) {
            channels.set(Number(id), {
              id: Number(id),
              name: `ch-${id}`,
              type: "text",
              category: null,
              position,
              unreadCount: 0,
              mentionCount: 0,
              lastMessageId: null,
              canSend: true,
              topic: "",
              slowMode: 0,
              nsfw: false,
              isPrivate: false,
              voiceMaxUsers: 0,
              voiceMaxVideo: 0,
            });
          }
          return { ...prev, channels };
        });
      }
      const positionOf = (id: number): number | undefined =>
        channelsStore.getState().channels.get(id)?.position;
      const flush = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };

      // The sidebar has already applied the optimistic order (channels 1 and
      // 2 swapped) by the time onReorderChannel runs.
      const swap = [
        { channelId: 1, newPosition: 1, previousPosition: 0 },
        { channelId: 2, newPosition: 0, previousPosition: 1 },
      ];

      it("restores only the entry whose own write failed", async () => {
        const opts = defaultOpts();
        const toast = { show: vi.fn() };
        (opts.getToast as MockedFn).mockReturnValue(toast);
        (opts.api.adminUpdateChannel as MockedFn)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("forbidden"));
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedOrder({ 1: 1, 2: 0 });

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel(swap);
        await flush();

        // Channel 1's PATCH was accepted, so it stays at its new position;
        // channel 2's was rejected, so it goes back.
        expect(positionOf(1)).toBe(1);
        expect(positionOf(2)).toBe(1);
        expect(toast.show).toHaveBeenCalledWith("Failed to save channel order", "error");

        cleanup(result);
      });

      it("leaves the new positions in place when every write succeeds", async () => {
        const opts = defaultOpts();
        const toast = { show: vi.fn() };
        (opts.getToast as MockedFn).mockReturnValue(toast);
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedOrder({ 1: 1, 2: 0 });

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel(swap);
        await flush();

        expect(positionOf(1)).toBe(1);
        expect(positionOf(2)).toBe(0);
        expect(toast.show).not.toHaveBeenCalled();

        cleanup(result);
      });

      it("leaves a confirmed entry alone when its broadcast lands before the batch settles", async () => {
        const opts = defaultOpts();
        (opts.api.adminUpdateChannel as MockedFn)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("forbidden"));
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedOrder({ 1: 1, 2: 0 });

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel(swap);
        // The server broadcasts channel_update before it answers the PATCH, so
        // channel 1's confirmed position can arrive before the batch settles.
        seedOrder({ 1: 1 });
        await flush();

        expect(positionOf(1)).toBe(1);
        expect(positionOf(2)).toBe(1);

        cleanup(result);
      });

      it("keeps the server value of a channel confirmed by a broadcast before its write failed", async () => {
        const opts = defaultOpts();
        (opts.api.adminUpdateChannel as MockedFn)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("response lost"));
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedOrder({ 1: 1, 2: 0 });

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel(swap);
        // The server persisted channel 2's move and broadcast it, then the
        // response was lost: the broadcast carries the same position the
        // optimistic update set, so only the broadcast itself tells them apart.
        const onUpdate = (opts.ws.on as MockedFn).mock.calls.find(
          (c: unknown[]) => c[0] === "channel_update",
        )![1] as (payload: { id: number }) => void;
        onUpdate({ id: 2 });
        await flush();

        expect(positionOf(2)).toBe(0);

        cleanup(result);
      });

      it("still rolls back when only an unread badge touched the channel while the write failed", async () => {
        const opts = defaultOpts();
        (opts.api.adminUpdateChannel as MockedFn)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("forbidden"));
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedOrder({ 1: 1, 2: 0 });

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel(swap);
        // An ordinary badge mutation replaces the channel object but is not a
        // channel_update, so it must not count as a server confirmation.
        channelsStore.setState((prev) => {
          const channels = new Map(prev.channels);
          const ch = channels.get(2)!;
          channels.set(2, { ...ch, unreadCount: ch.unreadCount + 1 });
          return { ...prev, channels };
        });
        await flush();

        expect(positionOf(2)).toBe(1);

        cleanup(result);
      });

      it("does not overwrite a newer position that arrived while the failed write was in flight", async () => {
        const opts = defaultOpts();
        (opts.api.adminUpdateChannel as MockedFn)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("response lost"));
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedOrder({ 1: 1, 2: 0 });

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel(swap);
        // A newer reorder (or broadcast) moved channel 2 elsewhere before the
        // failure surfaced; the stale rollback must not clobber it.
        seedOrder({ 2: 5 });
        await flush();

        expect(positionOf(2)).toBe(5);

        cleanup(result);
      });
    });

    describe("onReorderChannel across categories", () => {
      /** Channel 1 sat at position 0 in category 10 "A" (position 0) and the drop
       *  moved it to category 11 "B" (position 1) at position 6; channel 2 in B was
       *  re-slotted from 6 to 7. The store already shows the optimistic result. */
      function seedMoved(): void {
        const base = {
          type: "text" as const,
          unreadCount: 0,
          mentionCount: 0,
          lastMessageId: null,
          canSend: true,
          topic: "",
          slowMode: 0,
          nsfw: false,
          isPrivate: false,
          voiceMaxUsers: 0,
          voiceMaxVideo: 0,
        };
        channelsStore.setState((prev) => ({
          ...prev,
          channels: new Map([
            [
              1,
              {
                ...base,
                id: 1,
                name: "one",
                category: "B",
                categoryId: 11,
                categoryPosition: 1,
                position: 6,
              },
            ],
            [
              2,
              {
                ...base,
                id: 2,
                name: "two",
                category: "B",
                categoryId: 11,
                categoryPosition: 1,
                position: 7,
              },
            ],
          ]),
        }));
      }
      const moved = {
        channelId: 1,
        newPosition: 6,
        previousPosition: 0,
        category: {
          previous: { categoryId: 10, category: "A", categoryPosition: 0 },
          next: { categoryId: 11, category: "B", categoryPosition: 1 },
        },
      };
      const reslotted = { channelId: 2, newPosition: 7, previousPosition: 6 };
      const stored = (id: number) => channelsStore.getState().channels.get(id);
      const flush = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };

      it("PATCHes category_id and position for the moved channel and position alone for the rest", () => {
        const opts = defaultOpts();
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedMoved();

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel([moved, reslotted]);

        expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(1, {
          category_id: 11,
          position: 6,
        });
        expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(2, { position: 7 });

        cleanup(result);
      });

      it("a failed PATCH rolls back both the category and the position, with one error toast", async () => {
        const opts = defaultOpts();
        const toast = { show: vi.fn() };
        (opts.getToast as MockedFn).mockReturnValue(toast);
        (opts.api.adminUpdateChannel as MockedFn)
          .mockRejectedValueOnce(new Error("forbidden"))
          .mockResolvedValueOnce(undefined);
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedMoved();

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel([moved, reslotted]);
        await flush();

        expect(stored(1)).toMatchObject({
          categoryId: 10,
          category: "A",
          categoryPosition: 0,
          position: 0,
        });
        // The re-slotted row's write landed, so it keeps its new slot.
        expect(stored(2)?.position).toBe(7);
        expect(toast.show).toHaveBeenCalledTimes(1);
        expect(toast.show).toHaveBeenCalledWith("forbidden", "error");

        cleanup(result);
      });

      it("does not roll the category back once a channel_update confirmed the write", async () => {
        const opts = defaultOpts();
        (opts.api.adminUpdateChannel as MockedFn)
          .mockRejectedValueOnce(new Error("response lost"))
          .mockResolvedValueOnce(undefined);
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedMoved();

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel([moved, reslotted]);
        const onUpdate = (opts.ws.on as MockedFn).mock.calls.find(
          (c: unknown[]) => c[0] === "channel_update",
        )![1] as (payload: { id: number }) => void;
        onUpdate({ id: 1 });
        await flush();

        expect(stored(1)).toMatchObject({ categoryId: 11, position: 6 });

        cleanup(result);
      });

      it("does not overwrite a newer category that arrived while the failed write was in flight", async () => {
        const opts = defaultOpts();
        (opts.api.adminUpdateChannel as MockedFn)
          .mockRejectedValueOnce(new Error("response lost"))
          .mockResolvedValueOnce(undefined);
        const result = createSidebarArea(opts);
        container.appendChild(result.sidebarWrapper);
        seedMoved();

        const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
        callArgs.onReorderChannel([moved, reslotted]);
        // Another move put the channel in category 12 before the failure surfaced.
        channelsStore.setState((prev) => {
          const channels = new Map(prev.channels);
          channels.set(1, { ...channels.get(1)!, categoryId: 12, category: "C" });
          return { ...prev, channels };
        });
        await flush();

        expect(stored(1)).toMatchObject({ categoryId: 12, category: "C", position: 6 });

        cleanup(result);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Channel modal inner callbacks
  // -------------------------------------------------------------------------

  describe("channel modal inner callbacks", () => {
    it("onCreate callback calls API and destroys modal on success", async () => {
      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onCreateChannel("General");
      await vi.dynamicImportSettled();

      // Get the createCreateChannelModal call args
      const modalCallArgs = (createCreateChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onCreate({ name: "test", type: "text" });

      expect(opts.api.adminCreateChannel).toHaveBeenCalledWith({ name: "test", type: "text" });

      cleanup(result);
    });

    // The modal's own catch is what re-enables the submit button and renders
    // the inline error, so the callback must reject on failure — a swallowed
    // error leaves the modal disabled on "Creating..." with no way to retry.
    it("onCreate rejects and shows error toast on API failure", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminCreateChannel as MockedFn).mockRejectedValue(new Error("Create failed"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onCreateChannel("General");
      await vi.dynamicImportSettled();

      const modalCallArgs = (createCreateChannelModal as MockedFn).mock.calls[0]![0];
      await expect(modalCallArgs.onCreate({ name: "test", type: "text" })).rejects.toThrow(
        "Create failed",
      );

      expect(mockShow).toHaveBeenCalledWith("Create failed", "error");
      // The modal stays open so the user can fix the input and retry.
      expect(getMockDestroy(createCreateChannelModal as MockedFn)).not.toHaveBeenCalled();

      cleanup(result);
    });

    it("onCreate rejects with the original value and shows generic toast for non-Error exceptions", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminCreateChannel as MockedFn).mockRejectedValue("string error");
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onCreateChannel("General");
      await vi.dynamicImportSettled();

      const modalCallArgs = (createCreateChannelModal as MockedFn).mock.calls[0]![0];
      await expect(modalCallArgs.onCreate({ name: "test", type: "text" })).rejects.toBe(
        "string error",
      );

      expect(mockShow).toHaveBeenCalledWith("Failed to create channel", "error");

      cleanup(result);
    });

    it("onClose callback destroys create modal", async () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onCreateChannel("General");
      await vi.dynamicImportSettled();

      const modalCallArgs = (createCreateChannelModal as MockedFn).mock.calls[0]![0];
      modalCallArgs.onClose();

      // After close, should be able to open another modal
      channelCallArgs.onCreateChannel("Another");
      await vi.dynamicImportSettled();
      expect(createCreateChannelModal).toHaveBeenCalledTimes(2);

      cleanup(result);
    });

    it("onSave callback calls API for edit modal", async () => {
      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onEditChannel({ id: 1, name: "general", type: "text" });
      await vi.dynamicImportSettled();

      const modalCallArgs = (createEditChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onSave({ name: "updated" });

      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(1, { name: "updated" });

      cleanup(result);
    });

    it("onSave rejects and shows error toast on edit API failure", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminUpdateChannel as MockedFn).mockRejectedValue(new Error("Update failed"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onEditChannel({ id: 1, name: "general", type: "text" });
      await vi.dynamicImportSettled();

      const modalCallArgs = (createEditChannelModal as MockedFn).mock.calls[0]![0];
      await expect(modalCallArgs.onSave({ name: "updated" })).rejects.toThrow("Update failed");

      expect(mockShow).toHaveBeenCalledWith("Update failed", "error");
      expect(getMockDestroy(createEditChannelModal as MockedFn)).not.toHaveBeenCalled();

      cleanup(result);
    });

    it("onSave rejects with the original value and shows generic toast for non-Error exceptions on edit", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminUpdateChannel as MockedFn).mockRejectedValue(42);
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onEditChannel({ id: 1, name: "general", type: "text" });
      await vi.dynamicImportSettled();

      const modalCallArgs = (createEditChannelModal as MockedFn).mock.calls[0]![0];
      await expect(modalCallArgs.onSave({ name: "updated" })).rejects.toBe(42);

      expect(mockShow).toHaveBeenCalledWith("Failed to update channel", "error");

      cleanup(result);
    });

    it("onClose callback destroys edit modal", async () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onEditChannel({ id: 1, name: "general", type: "text" });
      await vi.dynamicImportSettled();

      const modalCallArgs = (createEditChannelModal as MockedFn).mock.calls[0]![0];
      modalCallArgs.onClose();

      channelCallArgs.onEditChannel({ id: 2, name: "random", type: "text" });

      await vi.dynamicImportSettled();
      expect(createEditChannelModal).toHaveBeenCalledTimes(2);

      cleanup(result);
    });

    it("onConfirm callback calls API for delete modal", async () => {
      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onDeleteChannel({ id: 1, name: "general" });

      const modalCallArgs = (createDeleteChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onConfirm();

      expect(opts.api.adminDeleteChannel).toHaveBeenCalledWith(1);

      cleanup(result);
    });

    it("onConfirm rejects and shows error toast on delete API failure", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminDeleteChannel as MockedFn).mockRejectedValue(new Error("Delete failed"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onDeleteChannel({ id: 1, name: "general" });

      const modalCallArgs = (createDeleteChannelModal as MockedFn).mock.calls[0]![0];
      await expect(modalCallArgs.onConfirm()).rejects.toThrow("Delete failed");

      expect(mockShow).toHaveBeenCalledWith("Delete failed", "error");
      expect(getMockDestroy(createDeleteChannelModal as MockedFn)).not.toHaveBeenCalled();

      cleanup(result);
    });

    it("onConfirm rejects with the original value and shows generic toast for non-Error exceptions on delete", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminDeleteChannel as MockedFn).mockRejectedValue(42);
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onDeleteChannel({ id: 1, name: "general" });

      const modalCallArgs = (createDeleteChannelModal as MockedFn).mock.calls[0]![0];
      await expect(modalCallArgs.onConfirm()).rejects.toBe(42);

      expect(mockShow).toHaveBeenCalledWith("Failed to delete channel", "error");

      cleanup(result);
    });

    it("onClose callback destroys delete modal", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onDeleteChannel({ id: 1, name: "general" });

      const modalCallArgs = (createDeleteChannelModal as MockedFn).mock.calls[0]![0];
      modalCallArgs.onClose();

      channelCallArgs.onDeleteChannel({ id: 2, name: "random" });
      expect(createDeleteChannelModal).toHaveBeenCalledTimes(2);

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Quick switch overlay
  // -------------------------------------------------------------------------

  describe("quick switch overlay", () => {
    it("openQuickSwitch does not throw", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(() => result.openQuickSwitch()).not.toThrow();

      cleanup(result);
    });

    it("does not mount a second overlay from a double-click while profiles are still loading", async () => {
      // `quickSwitchInstance` is only assigned after the loadProfiles()
      // await — a synchronous second call in that window must not slip past
      // the guard and mount a second, orphaned overlay (the same class of bug
      // already fixed with an `opening` flag on the sibling overlay
      // controllers in OverlayManagers.ts).
      let resolveLoad!: () => void;
      const pending = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      (createProfileManager as MockedFn).mockReturnValueOnce({
        loadProfiles: vi.fn().mockReturnValue(pending),
        getAll: vi.fn().mockReturnValue([]),
        store: { getState: () => ({ profiles: [], healthStatuses: new Map() }) },
      });

      // createQuickSwitchOverlay's mock call count is not reset between
      // tests in this file (resetMocks() doesn't touch it), so compare
      // against a baseline rather than an absolute count.
      const callsBefore = (createQuickSwitchOverlay as MockedFn).mock.calls.length;

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      result.openQuickSwitch();
      result.openQuickSwitch();

      resolveLoad();
      // Await the exact promise the source code awaits: its resolution
      // queues each caller's continuation in registration order, and each
      // continuation runs to completion (no further await inside) before the
      // next is dequeued — so once this settles, any second overlay a buggy
      // double-open would have mounted already exists. vi.waitFor's polling
      // cannot be trusted here: it can observe the count between the two
      // continuations and pass before the second one ever runs.
      await pending;

      expect((createQuickSwitchOverlay as MockedFn).mock.calls.length).toBe(callsBefore + 1);

      cleanup(result);
    });

    it("does not mount an orphaned overlay if torn down while profiles are still loading", async () => {
      // MainPage.destroy() removes an ANCESTOR of sidebarWrapper (`root`) and
      // never detaches sidebarWrapper from its own parent, so
      // `sidebarWrapper.parentElement` stays non-null forever — it cannot be
      // used as the "were we torn down while awaiting?" check. Reproduce that
      // exactly: sidebarWrapper stays attached to `container` for the whole
      // test, teardown runs (the real unsubscriber list, same as
      // MainPage.destroy()'s loop) while loadProfiles() is still pending, and
      // only then does the profile load resolve.
      let resolveLoad!: () => void;
      const pending = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      (createProfileManager as MockedFn).mockReturnValueOnce({
        loadProfiles: vi.fn().mockReturnValue(pending),
        getAll: vi.fn().mockReturnValue([]),
        store: { getState: () => ({ profiles: [], healthStatuses: new Map() }) },
      });

      const callsBefore = (createQuickSwitchOverlay as MockedFn).mock.calls.length;

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      result.openQuickSwitch();

      // Teardown, as MainPage.destroy() runs it: every unsubscriber fires
      // (including the one that calls closeQuickSwitch()), but sidebarWrapper
      // is never removed from its parent.
      for (const unsub of result.unsubscribers) unsub();
      expect(result.sidebarWrapper.parentElement).not.toBeNull();

      resolveLoad();
      await pending;

      // No overlay should have been created for a page that no longer exists.
      expect((createQuickSwitchOverlay as MockedFn).mock.calls.length).toBe(callsBefore);
    });

    it("leaves through Add server as a switch, keeping the departed sign-in", async () => {
      const callsBefore = (createQuickSwitchOverlay as MockedFn).mock.calls.length;
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      result.openQuickSwitch();
      await vi.waitFor(() =>
        expect((createQuickSwitchOverlay as MockedFn).mock.calls.length).toBe(callsBefore + 1),
      );
      const { onAddServer } = (createQuickSwitchOverlay as MockedFn).mock.calls.at(-1)![0] as {
        onAddServer: () => void;
      };

      onAddServer();

      expect(authStore.getState().isAuthenticated).toBe(false);
      expect(authStore.getState().logoutReason).toBe("server_switch");

      cleanup(result);
    });
  });
});
