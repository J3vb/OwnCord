import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/sidebarAreaMocks";
import { byName } from "../../helpers/tableCases";
import { createSidebarArea } from "../../../src/pages/main-page/SidebarArea";
import { channelsStore, type Channel } from "../../../src/stores/channels.store";
import { dmStore, addDmChannel } from "../../../src/stores/dm.store";
import { uiStore, setSidebarMode } from "../../../src/stores/ui.store";
import { voiceStore, joinVoiceChannel, updateVoiceState } from "../../../src/stores/voice.store";
import {
  isDmKeptForCall,
  resetKeptCallDms,
} from "../../../src/features/direct-messages/keptCallDms";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createDmSidebar } from "@components/DmSidebar";
import { createMemberList } from "@components/MemberList";
import "../../../src/pages/main-page/MemberPickerModal";
import {
  MockedFn,
  getMockMount,
  getMockDestroy,
  getMockUpdate,
  resetStores,
  resetMocks,
  makeDm,
  defaultOpts,
  cleanup,
  mountArea,
  firstCallArg,
  lastCallArg,
  enterDmsMode,
  openMemberPicker,
  clickDmEntry,
  makeChannel,
  seedChannels,
  seedMembers,
  optsWithToast,
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
  // DMs mode
  // -------------------------------------------------------------------------

  describe("DMs mode", () => {
    it("mounts DM sidebar when mode is dms", () => {
      enterDmsMode();

      const result = mountArea(container);

      expect(createDmSidebar).toHaveBeenCalled();
      expect(getMockMount(createDmSidebar as MockedFn)).toHaveBeenCalled();

      cleanup(result);
    });

    it("does not mount channel sidebar or member list in DMs mode", () => {
      enterDmsMode();

      const result = mountArea(container);

      expect(createChannelSidebar).not.toHaveBeenCalled();
      expect(createMemberList).not.toHaveBeenCalled();

      cleanup(result);
    });

    it("switches from channels to DMs mode when store changes", () => {
      const result = mountArea(container);

      expect(createChannelSidebar).toHaveBeenCalledTimes(1);

      setSidebarMode("dms");
      uiStore.flush();

      expect(createDmSidebar).toHaveBeenCalled();

      cleanup(result);
    });

    it("switches from DMs back to channels mode when store changes", () => {
      enterDmsMode();

      const result = mountArea(container);

      expect(createDmSidebar).toHaveBeenCalledTimes(1);

      setSidebarMode("channels");
      uiStore.flush();

      expect(createChannelSidebar).toHaveBeenCalled();

      cleanup(result);
    });

    it("destroys previous sidebar content when switching modes", () => {
      const result = mountArea(container);

      const destroyFn = getMockDestroy(createChannelSidebar as MockedFn);

      setSidebarMode("dms");
      uiStore.flush();

      expect(destroyFn).toHaveBeenCalled();

      cleanup(result);
    });

    it("cleans up channel-mode extras (member list) when switching to DMs", () => {
      const result = mountArea(container);

      const memberDestroyFn = getMockDestroy(createMemberList as MockedFn);

      setSidebarMode("dms");
      uiStore.flush();

      expect(memberDestroyFn).toHaveBeenCalled();

      cleanup(result);
    });

    it("refreshes the DM sidebar rows in place when DM store changes in DMs mode", () => {
      enterDmsMode();

      const result = mountArea(container);

      const initialCallCount = (createDmSidebar as MockedFn).mock.calls.length;
      const update = getMockUpdate(createDmSidebar as MockedFn);

      addDmChannel(makeDm({ channelId: 100 }));
      dmStore.flush();

      // B9-21: the sidebar is refreshed, not rebuilt — one instance, updated.
      expect(getMockUpdate(createDmSidebar as MockedFn)).toHaveBeenCalled();
      expect((createDmSidebar as MockedFn).mock.calls.length).toBe(initialCallCount);
      void update;

      cleanup(result);
    });

    // Keyed on the active CHANNEL, not activeDmUserId: a group DM leaves the
    // latter null, so a subscription on it would stop redrawing the list the
    // moment a group became the active conversation.
    it("refreshes the DM sidebar rows in place when the active channel changes in DMs mode", () => {
      enterDmsMode();

      const result = mountArea(container);

      const initialCallCount = (createDmSidebar as MockedFn).mock.calls.length;

      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 4242 }));
      channelsStore.flush?.();

      expect(getMockUpdate(createDmSidebar as MockedFn)).toHaveBeenCalled();
      expect((createDmSidebar as MockedFn).mock.calls.length).toBe(initialCallCount);

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // DM search preservation across refresh (OC-0280, amended by B9-21)
  //
  // refreshDmSidebar() used to destroy and recreate the whole DM sidebar
  // subtree on every dmStore.channels change (presence flips, new messages,
  // unread clears — not just "the DM list changed"), so SidebarArea had to
  // capture the "Find a conversation" filter text and focus and restore them
  // onto the freshly-mounted input. B9-21 makes the sidebar update its rows in
  // place, so the sidebar instance — and its search input node — survive the
  // refresh. These tests pin the stronger contract: the node is reused (same
  // identity) and neither the filter text nor focus is ever dropped.
  // -------------------------------------------------------------------------

  describe("DM search preservation across refresh", () => {
    function mockDmSidebarWithSearchInput(): void {
      (createDmSidebar as MockedFn).mockImplementation(() => {
        let root: HTMLDivElement | null = null;
        return {
          mount: vi.fn((mountContainer: HTMLElement) => {
            root = document.createElement("div");
            const input = document.createElement("input");
            input.className = "dm-search";
            input.placeholder = "Find a conversation";
            root.appendChild(input);
            mountContainer.appendChild(root);
          }),
          // In-place refresh: the real DmSidebar reconciles its rows and leaves
          // the header/search chrome untouched, so this is a no-op here.
          update: vi.fn(),
          destroy: vi.fn(() => {
            root?.remove();
            root = null;
          }),
        };
      });
    }

    it("keeps the search filter text across a DM store change without rebuilding", () => {
      enterDmsMode();
      mockDmSidebarWithSearchInput();

      const result = mountArea(container);

      const searchInput = container.querySelector(".dm-search") as HTMLInputElement;
      expect(searchInput).not.toBeNull();
      searchInput.value = "ali";

      // A DM partner's presence flip / new message rebuilds dmStore.channels
      // even though the user typed nothing and did not touch the DM list.
      addDmChannel(makeDm({ channelId: 100 }));
      dmStore.flush();

      const newSearchInput = container.querySelector(".dm-search") as HTMLInputElement;
      expect(newSearchInput).not.toBeNull();
      expect(newSearchInput.value).toBe("ali");
      // The input node is the same one, not a capture/restore replacement.
      expect(newSearchInput).toBe(searchInput);

      cleanup(result);
    });

    it("keeps keyboard focus on the search input across a DM store change", () => {
      enterDmsMode();
      mockDmSidebarWithSearchInput();

      const result = mountArea(container);

      const searchInput = container.querySelector(".dm-search") as HTMLInputElement;
      searchInput.focus();
      expect(document.activeElement).toBe(searchInput);

      addDmChannel(makeDm({ channelId: 100 }));
      dmStore.flush();

      const newSearchInput = container.querySelector(".dm-search") as HTMLInputElement;
      expect(newSearchInput).not.toBeNull();
      expect(newSearchInput).toBe(searchInput);
      expect(document.activeElement).toBe(newSearchInput);

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Member picker modal
  // -------------------------------------------------------------------------

  describe("member picker modal", () => {
    it("shows member picker with non-current-user members", async () => {
      seedMembers([
        { id: 1, username: "testuser", role: "admin", status: "online" },
        { id: 2, username: "Alice", role: "member", status: "online" },
        { id: 3, username: "Bob", role: "member", status: "idle" },
      ]);

      const result = mountArea(container);

      await openMemberPicker(container);

      const items = document.querySelectorAll(".dm-member-picker-item");
      expect(items.length).toBe(2);

      cleanup(result);
    });

    it("does not open a second picker if one is already open", async () => {
      const result = mountArea(container);

      const addBtn = await openMemberPicker(container);
      addBtn.click();
      await vi.dynamicImportSettled();

      const modals = document.querySelectorAll(".modal-overlay");
      expect(modals.length).toBe(1);

      cleanup(result);
    });

    it("closes picker on cancel button click", async () => {
      const result = mountArea(container);

      await openMemberPicker(container);

      const cancelBtn = document.querySelector(".btn-secondary") as HTMLElement;
      cancelBtn.click();

      expect(document.querySelector(".modal-overlay")).toBeNull();

      cleanup(result);
    });

    it("closes picker when clicking the overlay background", async () => {
      const result = mountArea(container);

      await openMemberPicker(container);

      const overlay = document.querySelector(".modal-overlay") as HTMLElement;
      overlay.click();

      expect(document.querySelector(".modal-overlay")).toBeNull();

      cleanup(result);
    });

    it("clicking a member creates a DM and closes picker", async () => {
      seedMembers([
        { id: 1, username: "testuser", role: "admin", status: "online" },
        { id: 2, username: "Alice", role: "member", status: "online" },
      ]);

      const opts = defaultOpts();
      const result = mountArea(container, opts);

      await openMemberPicker(container);

      // The picker is multi-select since group DMs: a click selects, and the
      // confirm button (labelled for the selection size) commits.
      const item = document.querySelector(".dm-member-picker-item") as HTMLElement;
      item.click();
      const confirm = document.querySelector('[data-testid="dm-picker-create"]') as HTMLElement;
      expect(confirm.textContent).toBe("Create DM");
      confirm.click();

      expect(document.querySelector(".modal-overlay")).toBeNull();

      await vi.waitFor(() => {
        expect(opts.api.createDm).toHaveBeenCalledWith(2);
      });

      cleanup(result);
    });

    it("shows member avatar initial and status in picker", async () => {
      seedMembers([
        { id: 1, username: "testuser", role: "admin", status: "online" },
        { id: 2, username: "Alice", role: "member", status: "idle" },
      ]);

      const result = mountArea(container);

      await openMemberPicker(container);

      const avatar = document.querySelector(".dm-avatar");
      expect(avatar!.textContent).toBe("A");

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // DM conversation select
  // -------------------------------------------------------------------------

  describe("DM conversation select", () => {
    it("clicking a DM entry switches to DMs mode and sets active channel", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const result = mountArea(container);

      clickDmEntry(container);

      expect(uiStore.getState().sidebarMode).toBe("dms");
      expect(uiStore.getState().activeDmUserId).toBe(10);
      expect(channelsStore.getState().activeChannelId).toBe(100);

      cleanup(result);
    });

    it("saves current non-DM channel before switching to DMs", () => {
      seedChannels([makeChannel({ id: 1, name: "general" })], { activeChannelId: 1 });

      addDmChannel(makeDm({ channelId: 100 }));

      const result = mountArea(container);

      clickDmEntry(container);

      expect(uiStore.getState().sidebarMode).toBe("dms");

      cleanup(result);
    });

    it("does not save DM channel as channelBeforeDm", () => {
      seedChannels(
        [
          makeChannel({ id: 1, name: "general" }),
          makeChannel({ id: 50, name: "DmCh", type: "dm" }),
        ],
        { activeChannelId: 50 },
      );

      addDmChannel(makeDm({ channelId: 100 }));

      const result = mountArea(container);

      clickDmEntry(container);
      uiStore.flush();

      // DM was active but type was dm, so channelBeforeDm should be null:
      // going to DMs mode and clicking back should NOT restore the DM
      // channel (50) — it should fall back to the first text channel (1).
      expect(uiStore.getState().sidebarMode).toBe("dms");

      const lastCall = lastCallArg(createDmSidebar as MockedFn);
      lastCall.onBack();

      expect(uiStore.getState().sidebarMode).toBe("channels");
      expect(channelsStore.getState().activeChannelId).toBe(1);
      expect(channelsStore.getState().activeChannelId).not.toBe(50);

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // DM sidebar callbacks
  // -------------------------------------------------------------------------

  describe("DM sidebar callbacks", () => {
    it("passes correct callbacks to createDmSidebar", () => {
      enterDmsMode();

      const result = mountArea(container);

      expect(createDmSidebar).toHaveBeenCalled();
      const callArgs = firstCallArg(createDmSidebar as MockedFn);
      expect(typeof callArgs.onSelectConversation).toBe("function");
      expect(typeof callArgs.onCloseDm).toBe("function");
      expect(typeof callArgs.onNewDm).toBe("function");
      expect(typeof callArgs.onBack).toBe("function");

      cleanup(result);
    });

    it("onSelectConversation opens a DM that arrived after the sidebar was built", () => {
      enterDmsMode();

      const result = mountArea(container);
      const callArgs = firstCallArg(createDmSidebar as MockedFn);

      addDmChannel(makeDm({ channelId: 100 }));
      dmStore.flush();
      callArgs.onSelectConversation(100);

      expect(channelsStore.getState().activeChannelId).toBe(100);

      cleanup(result);
    });

    it("onBack restores previous channel and switches to channels mode", () => {
      seedChannels([makeChannel({ id: 1, name: "general" })], { activeChannelId: 1 });

      addDmChannel(makeDm({ channelId: 100 }));

      const result = mountArea(container);

      // Click DM entry to save channelBeforeDm and switch to DMs mode
      clickDmEntry(container);
      uiStore.flush();

      // Get the onBack callback from the latest createDmSidebar call
      const lastCall = lastCallArg(createDmSidebar as MockedFn);
      lastCall.onBack();

      expect(uiStore.getState().sidebarMode).toBe("channels");
      expect(channelsStore.getState().activeChannelId).toBe(1);

      cleanup(result);
    });

    it.each(
      byName([
        {
          name: "onBack falls back to first text channel if no saved channel",
          channels: [
            makeChannel({ id: 1, name: "general" }),
            makeChannel({ id: 2, name: "voice", type: "voice" }),
          ],
          extra: {},
          expectedActive: 1,
        },
        {
          // No plain "text" channel exists — only an announcement one.
          name: "onBack falls back to an announcement channel when no text channel remains",
          channels: [
            makeChannel({ id: 5, name: "announcements", type: "announcement", canSend: false }),
          ],
          extra: {},
          expectedActive: 5,
        },
        {
          // #random (2) is on screen, and is not first in Map insertion order. DM mode
          // was entered the way the "View all messages" button does it: a bare
          // setSidebarMode, so channelBeforeDm is never recorded. Must not silently
          // jump to #general (1) — the user never asked to leave #random.
          name: "onBack keeps the current channel when DM mode was entered without recording channelBeforeDm ('View all messages' bypass)",
          channels: [
            makeChannel({ id: 1, name: "general" }),
            makeChannel({ id: 2, name: "random" }),
          ],
          extra: { activeChannelId: 2 },
          expectedActive: 2,
        },
      ]),
    )("%s", (_name, { channels, extra, expectedActive }) => {
      seedChannels(channels, extra);
      enterDmsMode();
      const result = mountArea(container);

      lastCallArg(createDmSidebar as MockedFn).onBack();

      expect(uiStore.getState().sidebarMode).toBe("channels");
      expect(channelsStore.getState().activeChannelId).toBe(expectedActive);

      cleanup(result);
    });

    const closeDmFromSidebar = (
      channelId: number,
      opts = defaultOpts(),
    ): ReturnType<typeof createSidebarArea> => {
      const result = mountArea(container, opts);
      lastCallArg(createDmSidebar as MockedFn).onCloseDm(channelId);
      return result;
    };

    const seedActiveAliceDm = (): void => {
      addDmChannel(makeDm({ channelId: 100 }));
      enterDmsMode();
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 100 }));
    };

    it("onCloseDm removes DM and calls closeDm API", () => {
      seedActiveAliceDm();

      const opts = defaultOpts();
      const result = mountArea(container, opts);

      lastCallArg(createDmSidebar as MockedFn).onCloseDm(100);

      expect(opts.api.closeDm).toHaveBeenCalledWith(100);

      cleanup(result);
    });

    describe("call roster when leaving a group DM", () => {
      let mounted: ReturnType<typeof createSidebarArea> | null = null;
      afterEach(() => {
        if (mounted !== null) cleanup(mounted);
        mounted = null;
      });
      const seedRoster = (channelId: number) => {
        updateVoiceState({
          channel_id: channelId,
          user_id: 10,
          username: "Alice",
          muted: false,
          deafened: false,
          speaking: false,
          camera: false,
          screenshare: false,
        });
        voiceStore.flush();
      };
      const closeFrom = (channelId: number, opts = defaultOpts()) => {
        mounted = closeDmFromSidebar(channelId, opts);
        return mounted;
      };

      it("drops the roster once the server accepts the leave", async () => {
        addDmChannel(makeDm({ channelId: 100, isGroup: true }));
        enterDmsMode();
        seedRoster(100);

        closeFrom(100);

        await vi.waitFor(() => {
          voiceStore.flush();
          expect(voiceStore.getState().voiceUsers.has(100)).toBe(false);
        });
      });

      it("keeps the roster when the server refuses the leave", async () => {
        addDmChannel(makeDm({ channelId: 100, isGroup: true }));
        enterDmsMode();
        seedRoster(100);
        const opts = defaultOpts();
        (opts.api.closeDm as MockedFn).mockRejectedValue(new Error("nope"));

        closeFrom(100, opts);

        await vi.waitFor(() => {
          expect(dmStore.getState().channels.map((c) => c.channelId)).toContain(100);
        });
        voiceStore.flush();
        expect(voiceStore.getState().voiceUsers.get(100)?.size).toBe(1);
      });

      it("keeps the roster when a 1:1 DM is closed", async () => {
        addDmChannel(makeDm({ channelId: 100, isGroup: false }));
        enterDmsMode();
        seedRoster(100);
        const opts = defaultOpts();

        closeFrom(100, opts);
        await Promise.resolve();
        await Promise.resolve();

        voiceStore.flush();
        expect(opts.api.closeDm).toHaveBeenCalledWith(100);
        expect(voiceStore.getState().voiceUsers.get(100)?.size).toBe(1);
      });
    });

    // DP-34: the optimistic removal is rolled back when the server refuses.
    it("restores the DM row when closeDm rejects", async () => {
      seedActiveAliceDm();

      const opts = defaultOpts();
      (opts.api.closeDm as MockedFn).mockRejectedValue(new Error("nope"));
      const result = closeDmFromSidebar(100, opts);

      // Gone immediately (optimistic), back once the request rejects.
      expect(dmStore.getState().channels).toHaveLength(0);
      await vi.waitFor(() => {
        expect(dmStore.getState().channels.map((c) => c.channelId)).toContain(100);
      });

      cleanup(result);
    });

    // WP 3B-5 (D14): a local close must not end the DM's live call on a network blip.
    describe("closing a DM while in its call", () => {
      afterEach(() => {
        resetKeptCallDms();
      });

      it("keeps a closed 1:1's call eligible for reconnect retries", () => {
        addDmChannel(makeDm({ channelId: 100 }));
        enterDmsMode();
        joinVoiceChannel(100);

        const result = closeDmFromSidebar(100);

        expect(dmStore.getState().channels).toHaveLength(0);
        expect(isDmKeptForCall(100)).toBe(true);
        cleanup(result);
      });

      it("does not keep a group the user leaves, so its call still ends", () => {
        addDmChannel(makeDm({ channelId: 100, isGroup: true, name: "Crew" }));
        enterDmsMode();
        joinVoiceChannel(100);

        const result = closeDmFromSidebar(100);

        expect(isDmKeptForCall(100)).toBe(false);
        cleanup(result);
      });

      it("does not keep a 1:1 closed while the user is in a different call", () => {
        addDmChannel(makeDm({ channelId: 100 }));
        enterDmsMode();
        joinVoiceChannel(55);

        const result = closeDmFromSidebar(100);

        expect(isDmKeptForCall(100)).toBe(false);
        cleanup(result);
      });

      it("forgets the DM when the server refuses the close and the row returns", async () => {
        addDmChannel(makeDm({ channelId: 100 }));
        enterDmsMode();
        joinVoiceChannel(100);
        const opts = defaultOpts();
        (opts.api.closeDm as MockedFn).mockRejectedValue(new Error("nope"));

        const result = closeDmFromSidebar(100, opts);

        await vi.waitFor(() => {
          expect(dmStore.getState().channels.map((c) => c.channelId)).toContain(100);
        });
        expect(isDmKeptForCall(100)).toBe(false);
        cleanup(result);
      });
    });

    it("restores a rejected closeDm row at its old place, not the top", async () => {
      addDmChannel(makeDm({ channelId: 103 }));
      addDmChannel(makeDm({ channelId: 102 }));
      addDmChannel(makeDm({ channelId: 101 }));
      enterDmsMode();

      const opts = defaultOpts();
      (opts.api.closeDm as MockedFn).mockRejectedValue(new Error("nope"));
      const result = mountArea(container, opts);

      const dmSidebarCalls = (createDmSidebar as MockedFn).mock.calls;
      dmSidebarCalls[dmSidebarCalls.length - 1]![0].onCloseDm(102);

      await vi.waitFor(() => {
        expect(dmStore.getState().channels.map((c) => c.channelId)).toEqual([101, 102, 103]);
      });

      cleanup(result);
    });

    it("tracks the rename-group prompt so page teardown removes it (every other modal in this file does)", () => {
      const dm = makeDm({ channelId: 100, isGroup: true, name: "Old Name" });
      addDmChannel(dm);

      enterDmsMode();

      const result = mountArea(container);

      const lastCall = lastCallArg(createDmSidebar as MockedFn);
      lastCall.onRenameGroup(100);

      // createPromptModal is the real (unmocked) factory — it mounts to
      // document.body, outside `root`, so it survives every teardown path
      // that only removes `root` (a 401/kick/shutdown logout while the
      // prompt is open) unless SidebarArea tracks and destroys it itself,
      // same as every sibling modal in this file.
      expect(document.querySelector(".modal-prompt")).not.toBeNull();

      cleanup(result);

      expect(document.querySelector(".modal-prompt")).toBeNull();
    });

    const closeLastDmWith = (
      channels: readonly Channel[],
    ): ReturnType<typeof createSidebarArea> => {
      addDmChannel(makeDm({ channelId: 100 }));
      enterDmsMode();
      seedChannels(channels, { activeChannelId: 100 });
      return closeDmFromSidebar(100);
    };

    it("onCloseDm goes back to channels when last DM is closed", () => {
      const result = closeLastDmWith([makeChannel({ id: 1, name: "general" })]);

      expect(uiStore.getState().sidebarMode).toBe("channels");

      cleanup(result);
    });

    it("onCloseDm falls back to an announcement channel when the last DM closes with no text channel", () => {
      // channelBeforeDm was never recorded (DM channel added directly, not
      // via selectDmConversation) and no plain "text" channel exists.
      const result = closeLastDmWith([
        makeChannel({ id: 5, name: "announcements", type: "announcement", canSend: false }),
      ]);

      expect(uiStore.getState().sidebarMode).toBe("channels");
      expect(channelsStore.getState().activeChannelId).toBe(5);

      cleanup(result);
    });

    it("onSelectConversation selects a DM in DMs mode", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      enterDmsMode();

      const result = mountArea(container);

      const lastCall = lastCallArg(createDmSidebar as MockedFn);
      lastCall.onSelectConversation(100);

      expect(uiStore.getState().activeDmUserId).toBe(10);
      expect(channelsStore.getState().activeChannelId).toBe(100);

      cleanup(result);
    });

    it("onNewDm opens member picker from DMs mode", async () => {
      enterDmsMode();

      const result = mountArea(container);

      const lastCall = lastCallArg(createDmSidebar as MockedFn);
      lastCall.onNewDm();
      await vi.dynamicImportSettled();

      const modal = document.querySelector(".dm-member-picker-modal");
      expect(modal).not.toBeNull();

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // addDmToChannelsStore (inner function)
  // -------------------------------------------------------------------------

  describe("addDmToChannelsStore (channels mode)", () => {
    it("adds DM channel to channelsStore when clicking a DM entry", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 3 }));

      const result = mountArea(container);

      clickDmEntry(container);

      const ch = channelsStore.getState().channels.get(100);
      expect(ch).toBeDefined();
      expect(ch!.name).toBe("Alice");
      expect(ch!.type).toBe("dm");
      // unreadCount is 0 because setActiveChannel clears it
      expect(ch!.unreadCount).toBe(0);

      cleanup(result);
    });

    it("does not rewrite an existing channel whose name already matches", () => {
      seedChannels([makeChannel({ id: 100, name: "Alice", type: "dm" })]);

      addDmChannel(makeDm({ channelId: 100 }));

      const result = mountArea(container);

      clickDmEntry(container);

      const ch = channelsStore.getState().channels.get(100);
      expect(ch!.name).toBe("Alice");

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Create DM error handling
  // -------------------------------------------------------------------------

  describe("createDm error handling", () => {
    it("shows error toast when DM creation fails", async () => {
      const { opts, toast } = optsWithToast();
      (opts.api.createDm as MockedFn).mockRejectedValue(new Error("Server error"));

      seedMembers([
        { id: 1, username: "testuser", role: "admin", status: "online" },
        { id: 2, username: "Alice", role: "member", status: "online" },
      ]);

      const result = mountArea(container, opts);

      await openMemberPicker(container);
      const item = document.querySelector(".dm-member-picker-item") as HTMLElement;
      item.click();
      (document.querySelector('[data-testid="dm-picker-create"]') as HTMLElement).click();

      await vi.waitFor(() => {
        expect(toast.show).toHaveBeenCalledWith("Server error", "error");
      });

      cleanup(result);
    });
  });
});
