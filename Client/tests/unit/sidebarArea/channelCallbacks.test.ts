import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/sidebarAreaMocks";
import { byName } from "../../helpers/tableCases";
import {
  createSidebarArea,
  type SidebarAreaOptions,
} from "../../../src/pages/main-page/SidebarArea";
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
  enterVoiceAndAwaitWidget,
  defaultOpts,
  makeDm,
  cleanup,
  mountArea,
  firstCallArg,
  enterDmsMode,
  optsWithToast,
  makeChannel,
  seedChannels,
  useSidebarAreaHarness,
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

  useSidebarAreaHarness((c) => {
    container = c;
  });

  const flushMicrotasks = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) await Promise.resolve();
  };

  /** Queue each PATCH outcome in call order: an Error rejects, anything else resolves. */
  const queueWrites = (
    opts: SidebarAreaOptions,
    outcomes: ReadonlyArray<Error | undefined>,
  ): void => {
    const write = opts.api.adminUpdateChannel as MockedFn;
    for (const outcome of outcomes) {
      if (outcome === undefined) write.mockResolvedValueOnce(undefined);
      else write.mockRejectedValueOnce(outcome);
    }
  };

  const reorderTwo = () => [
    { channelId: 1, newPosition: 0 },
    { channelId: 2, newPosition: 1 },
  ];

  /** Deliver a channel_update broadcast through the handler SidebarArea registered. */
  const emitChannelUpdate = (opts: SidebarAreaOptions, id: number): void => {
    const onUpdate = (opts.ws.on as MockedFn).mock.calls.find(
      (c: unknown[]) => c[0] === "channel_update",
    )![1] as (payload: { id: number }) => void;
    onUpdate({ id });
  };

  // -------------------------------------------------------------------------
  // Channel sidebar callbacks
  // -------------------------------------------------------------------------

  describe("channel sidebar callbacks", () => {
    const mountWithOpenCall = () => {
      const onOpenCall = vi.fn();
      const result = mountArea(container, { ...defaultOpts(), onOpenCall });
      return { onOpenCall, result };
    };

    it("passes correct callbacks to createChannelSidebar", () => {
      const result = mountArea(container);

      expect(createChannelSidebar).toHaveBeenCalled();
      const callArgs = firstCallArg(createChannelSidebar as MockedFn);
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
      enterDmsMode();
      const { onOpenCall, result } = mountWithOpenCall();
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
      const { onOpenCall, result } = mountWithOpenCall();

      result.openCall(4242);

      expect(onOpenCall).toHaveBeenCalledOnce();
      cleanup(result);
    });

    it("openCall leaves DM mode before opening a guild call", async () => {
      enterDmsMode();
      const { onOpenCall, result } = mountWithOpenCall();

      result.openCall(4242);
      expect(onOpenCall).not.toHaveBeenCalled();
      await Promise.resolve();
      await Promise.resolve();

      expect(uiStore.getState().sidebarMode).toBe("channels");
      expect(onOpenCall).toHaveBeenCalledOnce();
      cleanup(result);
    });

    it("openCall opens a DM call by selecting the DM, not the call view", () => {
      const bob = { id: 7, username: "bob", avatar: "", status: "online" } as const;
      setDmChannels([makeDm({ channelId: 77, recipient: bob, participants: [bob] })]);
      dmStore.flush();
      const { onOpenCall, result } = mountWithOpenCall();

      result.openCall(77);

      expect(channelsStore.getState().activeChannelId).toBe(77);
      expect(uiStore.getState().sidebarMode).toBe("dms");
      expect(onOpenCall).not.toHaveBeenCalled();
      cleanup(result);
    });

    it("onOpenCall forwards to the page's call opener", () => {
      const { onOpenCall, result } = mountWithOpenCall();

      const callArgs = firstCallArg(createChannelSidebar as MockedFn);
      callArgs.onOpenCall();

      expect(onOpenCall).toHaveBeenCalledOnce();

      cleanup(result);
    });

    it("onCreateChannel opens create channel modal", async () => {
      const result = mountArea(container);

      const callArgs = firstCallArg(createChannelSidebar as MockedFn);
      callArgs.onCreateChannel("General");
      await vi.dynamicImportSettled();

      expect(createCreateChannelModal).toHaveBeenCalled();

      cleanup(result);
    });

    it("onCreateChannel does not open a second modal if one is active", async () => {
      const result = mountArea(container);

      const callArgs = firstCallArg(createChannelSidebar as MockedFn);
      callArgs.onCreateChannel("General");
      await vi.dynamicImportSettled();
      callArgs.onCreateChannel("Another");
      await vi.dynamicImportSettled();

      expect(createCreateChannelModal).toHaveBeenCalledTimes(1);

      cleanup(result);
    });

    it("onEditChannel opens edit channel modal", async () => {
      const result = mountArea(container);

      const callArgs = firstCallArg(createChannelSidebar as MockedFn);
      callArgs.onEditChannel({ id: 1, name: "general", type: "text" });
      await vi.dynamicImportSettled();

      expect(createEditChannelModal).toHaveBeenCalled();

      cleanup(result);
    });

    it("onEditChannel opens nothing when the sidebar is torn down while the editor loads", async () => {
      const result = mountArea(container);

      const callArgs = firstCallArg(createChannelSidebar as MockedFn);
      callArgs.onEditChannel({ id: 1, name: "general", type: "text" });
      cleanup(result);
      await vi.dynamicImportSettled();

      expect(createEditChannelModal).not.toHaveBeenCalled();
    });

    it("onDeleteChannel opens delete channel modal", () => {
      const result = mountArea(container);

      const callArgs = firstCallArg(createChannelSidebar as MockedFn);
      callArgs.onDeleteChannel({ id: 1, name: "general" });

      expect(createDeleteChannelModal).toHaveBeenCalled();

      cleanup(result);
    });

    it("onPurgeChannel calls the purge API and toasts the server's count", async () => {
      const { opts, toast } = optsWithToast();
      const result = mountArea(container, opts);

      await firstCallArg(createChannelSidebar as MockedFn).onPurgeChannel(
        { id: 1, name: "general" },
        50,
      );

      expect(opts.api.purgeMessages).toHaveBeenCalledWith(1, 50);
      expect(toast.show).toHaveBeenCalledWith("Purged 2 messages from #general", "success");

      cleanup(result);
    });

    it("onPurgeChannel surfaces a failure as an error toast", async () => {
      const { opts, toast } = optsWithToast();
      (opts.api.purgeMessages as MockedFn).mockRejectedValue(new Error("forbidden"));
      const result = mountArea(container, opts);

      await firstCallArg(createChannelSidebar as MockedFn).onPurgeChannel(
        { id: 1, name: "general" },
        50,
      );

      expect(toast.show).toHaveBeenCalledWith("forbidden", "error");

      cleanup(result);
    });

    it("onReorderChannel calls API for each reorder", () => {
      const opts = defaultOpts();
      const result = mountArea(container, opts);

      firstCallArg(createChannelSidebar as MockedFn).onReorderChannel(reorderTwo());

      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(1, { position: 0 });
      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(2, { position: 1 });

      cleanup(result);
    });

    it("onReorderChannel surfaces a failed write as an error toast", async () => {
      // Previously fired with bare `void` and no .catch: a rejected PATCH left
      // the sidebar showing an order the server never accepted, with nothing
      // telling the admin.
      const { opts, toast } = optsWithToast();
      queueWrites(opts, [undefined, new Error("forbidden")]);
      const result = mountArea(container, opts);

      firstCallArg(createChannelSidebar as MockedFn).onReorderChannel(reorderTwo());

      // Flush the Promise.allSettled(...).then(...) microtask chain.
      await flushMicrotasks(3);

      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(1, { position: 0 });
      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(2, { position: 1 });
      expect(toast.show).toHaveBeenCalledWith("Failed to save channel order", "error");

      cleanup(result);
    });

    it("onReorderChannel does not toast when every write succeeds", async () => {
      const { opts, toast } = optsWithToast();
      const result = mountArea(container, opts);

      firstCallArg(createChannelSidebar as MockedFn).onReorderChannel([
        { channelId: 1, newPosition: 0 },
      ]);

      await flushMicrotasks(3);

      expect(toast.show).not.toHaveBeenCalled();

      cleanup(result);
    });

    describe("onReorderChannel rollback", () => {
      function seedOrder(positions: Record<number, number>): void {
        seedChannels(
          Object.entries(positions).map(([id, position]) =>
            makeChannel({ id: Number(id), name: `ch-${id}`, position }),
          ),
        );
      }
      const positionOf = (id: number): number | undefined =>
        channelsStore.getState().channels.get(id)?.position;

      // The sidebar has already applied the optimistic order (channels 1 and
      // 2 swapped) by the time onReorderChannel runs.
      const swap = [
        { channelId: 1, newPosition: 1, previousPosition: 0 },
        { channelId: 2, newPosition: 0, previousPosition: 1 },
      ];
      const reorderSwap = (opts: SidebarAreaOptions): ReturnType<typeof createSidebarArea> => {
        const result = mountArea(container, opts);
        seedOrder({ 1: 1, 2: 0 });
        firstCallArg(createChannelSidebar as MockedFn).onReorderChannel(swap);
        return result;
      };

      it("restores only the entry whose own write failed", async () => {
        const { opts, toast } = optsWithToast();
        queueWrites(opts, [undefined, new Error("forbidden")]);
        const result = reorderSwap(opts);
        await flushMicrotasks(5);

        // Channel 1's PATCH was accepted, so it stays at its new position;
        // channel 2's was rejected, so it goes back.
        expect(positionOf(1)).toBe(1);
        expect(positionOf(2)).toBe(1);
        expect(toast.show).toHaveBeenCalledWith("Failed to save channel order", "error");

        cleanup(result);
      });

      it("leaves the new positions in place when every write succeeds", async () => {
        const { opts, toast } = optsWithToast();
        const result = reorderSwap(opts);
        await flushMicrotasks(5);

        expect(positionOf(1)).toBe(1);
        expect(positionOf(2)).toBe(0);
        expect(toast.show).not.toHaveBeenCalled();

        cleanup(result);
      });

      it("leaves a confirmed entry alone when its broadcast lands before the batch settles", async () => {
        const opts = defaultOpts();
        queueWrites(opts, [undefined, new Error("forbidden")]);
        const result = reorderSwap(opts);
        // The server broadcasts channel_update before it answers the PATCH, so
        // channel 1's confirmed position can arrive before the batch settles.
        seedOrder({ 1: 1 });
        await flushMicrotasks(5);

        expect(positionOf(1)).toBe(1);
        expect(positionOf(2)).toBe(1);

        cleanup(result);
      });

      it("keeps the server value of a channel confirmed by a broadcast before its write failed", async () => {
        const opts = defaultOpts();
        queueWrites(opts, [undefined, new Error("response lost")]);
        const result = reorderSwap(opts);
        // The server persisted channel 2's move and broadcast it, then the
        // response was lost: the broadcast carries the same position the
        // optimistic update set, so only the broadcast itself tells them apart.
        emitChannelUpdate(opts, 2);
        await flushMicrotasks(5);

        expect(positionOf(2)).toBe(0);

        cleanup(result);
      });

      it("still rolls back when only an unread badge touched the channel while the write failed", async () => {
        const opts = defaultOpts();
        queueWrites(opts, [undefined, new Error("forbidden")]);
        const result = reorderSwap(opts);
        // An ordinary badge mutation replaces the channel object but is not a
        // channel_update, so it must not count as a server confirmation.
        channelsStore.setState((prev) => {
          const channels = new Map(prev.channels);
          const ch = channels.get(2)!;
          channels.set(2, { ...ch, unreadCount: ch.unreadCount + 1 });
          return { ...prev, channels };
        });
        await flushMicrotasks(5);

        expect(positionOf(2)).toBe(1);

        cleanup(result);
      });

      it("does not overwrite a newer position that arrived while the failed write was in flight", async () => {
        const opts = defaultOpts();
        queueWrites(opts, [undefined, new Error("response lost")]);
        const result = reorderSwap(opts);
        // A newer reorder (or broadcast) moved channel 2 elsewhere before the
        // failure surfaced; the stale rollback must not clobber it.
        seedOrder({ 2: 5 });
        await flushMicrotasks(5);

        expect(positionOf(2)).toBe(5);

        cleanup(result);
      });
    });

    describe("onReorderChannel across categories", () => {
      /** Channel 1 sat at position 0 in category 10 "A" (position 0) and the drop
       *  moved it to category 11 "B" (position 1) at position 6; channel 2 in B was
       *  re-slotted from 6 to 7. The store already shows the optimistic result. */
      function seedMoved(): void {
        const inB = { category: "B", categoryId: 11, categoryPosition: 1 };
        seedChannels([
          makeChannel({ id: 1, name: "one", position: 6, ...inB }),
          makeChannel({ id: 2, name: "two", position: 7, ...inB }),
        ]);
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
      const reorderMoved = (opts: SidebarAreaOptions): ReturnType<typeof createSidebarArea> => {
        const result = mountArea(container, opts);
        seedMoved();
        firstCallArg(createChannelSidebar as MockedFn).onReorderChannel([moved, reslotted]);
        return result;
      };

      it("PATCHes category_id and position for the moved channel and position alone for the rest", () => {
        const opts = defaultOpts();
        const result = reorderMoved(opts);

        expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(1, {
          category_id: 11,
          position: 6,
        });
        expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(2, { position: 7 });

        cleanup(result);
      });

      it("a failed PATCH rolls back both the category and the position, with one error toast", async () => {
        const { opts, toast } = optsWithToast();
        queueWrites(opts, [new Error("forbidden"), undefined]);
        const result = reorderMoved(opts);
        await flushMicrotasks(5);

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
        queueWrites(opts, [new Error("response lost"), undefined]);
        const result = reorderMoved(opts);
        emitChannelUpdate(opts, 1);
        await flushMicrotasks(5);

        expect(stored(1)).toMatchObject({ categoryId: 11, position: 6 });

        cleanup(result);
      });

      it("does not overwrite a newer category that arrived while the failed write was in flight", async () => {
        const opts = defaultOpts();
        queueWrites(opts, [new Error("response lost"), undefined]);
        const result = reorderMoved(opts);
        // Another move put the channel in category 12 before the failure surfaced.
        channelsStore.setState((prev) => {
          const channels = new Map(prev.channels);
          channels.set(1, { ...channels.get(1)!, categoryId: 12, category: "C" });
          return { ...prev, channels };
        });
        await flushMicrotasks(5);

        expect(stored(1)).toMatchObject({ categoryId: 12, category: "C", position: 6 });

        cleanup(result);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Channel modal inner callbacks
  // -------------------------------------------------------------------------

  describe("channel modal inner callbacks", () => {
    type SidebarCallbacks = Record<string, (arg?: unknown) => unknown>;
    interface ModalKind {
      readonly method: "adminCreateChannel" | "adminUpdateChannel" | "adminDeleteChannel";
      readonly factory: MockedFn;
      readonly loadsLazily: boolean;
      readonly open: (sidebar: SidebarCallbacks, again?: boolean) => void;
      readonly submit: (modal: SidebarCallbacks) => unknown;
    }
    const createKind: ModalKind = {
      method: "adminCreateChannel",
      factory: createCreateChannelModal as MockedFn,
      loadsLazily: true,
      open: (sidebar, again) => sidebar.onCreateChannel!(again === true ? "Another" : "General"),
      submit: (modal) => modal.onCreate!({ name: "test", type: "text" }),
    };
    const editKind: ModalKind = {
      method: "adminUpdateChannel",
      factory: createEditChannelModal as MockedFn,
      loadsLazily: true,
      open: (sidebar, again) =>
        sidebar.onEditChannel!(
          again === true
            ? { id: 2, name: "random", type: "text" }
            : { id: 1, name: "general", type: "text" },
        ),
      submit: (modal) => modal.onSave!({ name: "updated" }),
    };
    const deleteKind: ModalKind = {
      method: "adminDeleteChannel",
      factory: createDeleteChannelModal as MockedFn,
      loadsLazily: false,
      open: (sidebar, again) =>
        sidebar.onDeleteChannel!(
          again === true ? { id: 2, name: "random" } : { id: 1, name: "general" },
        ),
      submit: (modal) => modal.onConfirm!(),
    };

    /** Mount, open the modal, and hand back the sidebar and modal callbacks. */
    const openModal = async (kind: ModalKind, opts: SidebarAreaOptions) => {
      const result = mountArea(container, opts);
      const sidebar: SidebarCallbacks = firstCallArg(createChannelSidebar as MockedFn);
      kind.open(sidebar);
      if (kind.loadsLazily) await vi.dynamicImportSettled();
      const modal: SidebarCallbacks = firstCallArg(kind.factory);
      return { result, sidebar, modal };
    };

    it.each(
      byName([
        {
          name: "onCreate callback calls API and destroys modal on success",
          kind: createKind,
          calledWith: [{ name: "test", type: "text" }],
        },
        {
          name: "onSave callback calls API for edit modal",
          kind: editKind,
          calledWith: [1, { name: "updated" }],
        },
        {
          name: "onConfirm callback calls API for delete modal",
          kind: deleteKind,
          calledWith: [1],
        },
      ]),
    )("%s", async (_name, { kind, calledWith }) => {
      const opts = defaultOpts();
      const { result, modal } = await openModal(kind, opts);

      await kind.submit(modal);

      expect(opts.api[kind.method]).toHaveBeenCalledWith(...calledWith);

      cleanup(result);
    });

    // The modal's own catch is what re-enables the submit button and renders
    // the inline error, so the callback must reject on failure — a swallowed
    // error leaves the modal disabled on "Creating..." with no way to retry.
    it.each(
      byName([
        {
          name: "onCreate rejects and shows error toast on API failure",
          kind: createKind,
          message: "Create failed",
        },
        {
          name: "onSave rejects and shows error toast on edit API failure",
          kind: editKind,
          message: "Update failed",
        },
        {
          name: "onConfirm rejects and shows error toast on delete API failure",
          kind: deleteKind,
          message: "Delete failed",
        },
      ]),
    )("%s", async (_name, { kind, message }) => {
      const { opts, toast } = optsWithToast();
      (opts.api[kind.method] as MockedFn).mockRejectedValue(new Error(message));
      const { result, modal } = await openModal(kind, opts);

      await expect(kind.submit(modal)).rejects.toThrow(message);

      expect(toast.show).toHaveBeenCalledWith(message, "error");
      // The modal stays open so the user can fix the input and retry.
      expect(getMockDestroy(kind.factory)).not.toHaveBeenCalled();

      cleanup(result);
    });

    it.each(
      byName([
        {
          name: "onCreate rejects with the original value and shows generic toast for non-Error exceptions",
          kind: createKind,
          reason: "string error",
          toastMessage: "Failed to create channel",
        },
        {
          name: "onSave rejects with the original value and shows generic toast for non-Error exceptions on edit",
          kind: editKind,
          reason: 42,
          toastMessage: "Failed to update channel",
        },
        {
          name: "onConfirm rejects with the original value and shows generic toast for non-Error exceptions on delete",
          kind: deleteKind,
          reason: 42,
          toastMessage: "Failed to delete channel",
        },
      ]),
    )("%s", async (_name, { kind, reason, toastMessage }) => {
      const { opts, toast } = optsWithToast();
      (opts.api[kind.method] as MockedFn).mockRejectedValue(reason);
      const { result, modal } = await openModal(kind, opts);

      await expect(kind.submit(modal)).rejects.toBe(reason);

      expect(toast.show).toHaveBeenCalledWith(toastMessage, "error");

      cleanup(result);
    });

    it.each(
      byName([
        { name: "onClose callback destroys create modal", kind: createKind },
        { name: "onClose callback destroys edit modal", kind: editKind },
        { name: "onClose callback destroys delete modal", kind: deleteKind },
      ]),
    )("%s", async (_name, { kind }) => {
      const { result, sidebar, modal } = await openModal(kind, defaultOpts());

      modal.onClose!();

      // After close, should be able to open another modal
      kind.open(sidebar, true);
      if (kind.loadsLazily) await vi.dynamicImportSettled();
      expect(kind.factory).toHaveBeenCalledTimes(2);

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Quick switch overlay
  // -------------------------------------------------------------------------

  describe("quick switch overlay", () => {
    /** The next profile manager's loadProfiles() stays pending until resolveLoad(). */
    const holdProfileLoad = (): { pending: Promise<void>; resolveLoad: () => void } => {
      let resolveLoad!: () => void;
      const pending = new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
      (createProfileManager as MockedFn).mockReturnValueOnce({
        loadProfiles: vi.fn().mockReturnValue(pending),
        getAll: vi.fn().mockReturnValue([]),
        store: { getState: () => ({ profiles: [], healthStatuses: new Map() }) },
      });
      return { pending, resolveLoad };
    };

    it("openQuickSwitch does not throw", () => {
      const result = mountArea(container);

      expect(() => result.openQuickSwitch()).not.toThrow();

      cleanup(result);
    });

    it("does not mount a second overlay from a double-click while profiles are still loading", async () => {
      // `quickSwitchInstance` is only assigned after the loadProfiles()
      // await — a synchronous second call in that window must not slip past
      // the guard and mount a second, orphaned overlay (the same class of bug
      // already fixed with an `opening` flag on the sibling overlay
      // controllers in OverlayManagers.ts).
      const { pending, resolveLoad } = holdProfileLoad();

      // createQuickSwitchOverlay's mock call count is not reset between
      // tests in this file (resetMocks() doesn't touch it), so compare
      // against a baseline rather than an absolute count.
      const callsBefore = (createQuickSwitchOverlay as MockedFn).mock.calls.length;

      const result = mountArea(container);

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
      const { pending, resolveLoad } = holdProfileLoad();

      const callsBefore = (createQuickSwitchOverlay as MockedFn).mock.calls.length;

      const result = mountArea(container);

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
      const result = mountArea(container);

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
