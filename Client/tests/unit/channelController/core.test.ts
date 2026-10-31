import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/channelControllerMocks";
import { createChannelController } from "../../../src/pages/main-page/ChannelController";
import type { ChannelControllerOptions } from "../../../src/pages/main-page/ChannelController";
import { setConnectionStatus } from "@stores/ui.store";
import { loadLastChannel } from "@lib/prefs/lastChannel";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { channelsStore, setChannels } from "@stores/channels.store";
import { createMessageList } from "@components/MessageList";
import {
  clearReactionUsersCache,
  getCachedReactionUsers,
  loadReactionUsers,
  setReactionUsersFetcher,
} from "../../../src/features/messaging/reactionUsers";
import {
  NAVIGATION_DESTINATIONS,
  type ForumViewContext,
} from "../../../src/features/navigation/destinations";
import { requestOpenThread } from "../../../src/features/threads/threadNavigation";
import {
  capturedMessageListOpts,
  capturedMessageInputOpts,
} from "../../helpers/channelControllerMocks";
import {
  makeSlots,
  makeOpts,
  useChannelControllerHarness,
} from "../../helpers/channelControllerHarness";

vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/dom", () => mocks.domMock());
vi.mock("@components/MessageList", () => mocks.messageListMock());
vi.mock("@components/MessageInput", () => mocks.messageInputMock());
vi.mock("@components/NsfwGate", () => mocks.nsfwGateMock());
vi.mock("@components/TypingIndicator", () => mocks.typingIndicatorMock());
vi.mock("@lib/readState", () => mocks.readStateMock());
vi.mock("@stores/messages.store", () => mocks.messagesStoreMock());
vi.mock("@lib/nav/messageNavigation", () => mocks.navMessageNavigationMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());
vi.mock("../../../src/pages/main-page/ChatHeader", (importOriginal) =>
  mocks.pageChatHeaderMock(importOriginal),
);
vi.mock("@stores/dm.store", () => mocks.dmStoreMock());
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("@stores/members.store", () => mocks.membersStoreMock());
vi.mock("@stores/blocks.store", () => mocks.blocksStoreMock());
vi.mock("../../../src/pages/main-page/ThreadPanelHost", () => mocks.pageThreadPanelHostMock());

const {
  mockMessageListMount,
  mockMessageListDestroy,
  mockMessageInputMount,
  mockMessageInputDestroy,
  mockTypingMount,
  mockTypingDestroy,
  mockGetChannelMessages,
  mockStartEdit,
  mockIsIdle,
  mockGetDraft,
  mockRestoreDraft,
  mockRestoreUnsent,
  mockCreateNsfwGate,
  mockRemoveOptimistic,
  mockMarkChannelRead,
  mockLeaveChannel,
  mockMarkChannelReadSeen,
  mockIsWindowDetached,
  mockInvalidateWindow,
  mockThreadOpenById,
} = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChannelController", () => {
  useChannelControllerHarness();

  it("starts with no channel mounted", () => {
    const ctrl = createChannelController(makeOpts());
    expect(ctrl.currentChannelId).toBeNull();
    expect(ctrl.messageList).toBeNull();
  });

  it("mounts channel components", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(ctrl.currentChannelId).toBe(42);
    expect(ctrl.messageList).not.toBeNull();
    expect(mockMessageListMount).toHaveBeenCalledWith(opts.slots.messagesSlot);
    expect(mockMessageInputMount).toHaveBeenCalledWith(opts.slots.inputSlot);
    expect(mockTypingMount).toHaveBeenCalledWith(opts.slots.typingSlot);
  });

  it("sends channel_focus on mount", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(opts.ws.send).toHaveBeenCalledWith({
      type: "channel_focus",
      payload: { channel_id: 42 },
    });
  });

  it("loads messages on mount", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
  });

  it("is no-op when same channel mounted", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");
    vi.clearAllMocks();

    ctrl.mountChannel(42, "general");

    expect(opts.ws.send).not.toHaveBeenCalled();
    expect(mockMessageListMount).not.toHaveBeenCalled();
  });

  it("destroys old channel before mounting new one", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");
    ctrl.mountChannel(99, "random");

    expect(mockMessageListDestroy).toHaveBeenCalled();
    expect(mockTypingDestroy).toHaveBeenCalled();
    expect(mockMessageInputDestroy).toHaveBeenCalled();
    expect(ctrl.currentChannelId).toBe(99);
  });

  it("marks the previous channel read when switching away from it", () => {
    // channel_focus only advances read state for the channel being entered;
    // nothing advances it for the channel being left, so leaving must mark it
    // read explicitly or its badges come back stale on the next `ready`.
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");
    expect(mockMarkChannelRead).not.toHaveBeenCalled();

    ctrl.mountChannel(99, "random");

    expect(mockMarkChannelRead).toHaveBeenCalledWith(42);
  });

  describe("with the server's read pointer", () => {
    beforeEach(() => {
      applyReadyCapabilities({ read_pointer: true });
      mockLeaveChannel.mockClear();
      mockMarkChannelReadSeen.mockClear();
      mockMarkChannelRead.mockClear();
    });
    afterEach(() => resetServerCapabilities());

    it("leaving a channel marks only what was seen, never everything", () => {
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");
      ctrl.mountChannel(99, "random");

      expect(mockLeaveChannel).toHaveBeenCalledWith(42);
      expect(mockMarkChannelRead).not.toHaveBeenCalled();
    });

    it("sending from a detached window marks what was seen, not everything", () => {
      mockIsWindowDetached.mockReturnValueOnce(true);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onSend("hello", null, [], []);

      expect(mockMarkChannelReadSeen).toHaveBeenCalledWith(42);
      expect(mockMarkChannelRead).not.toHaveBeenCalled();
    });

    it("jumping to the present still marks at latest", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      capturedMessageListOpts.onJumpToPresent?.();

      expect(mockMarkChannelRead).toHaveBeenCalledWith(42);
    });
  });

  it("does not mark anything read on the very first mount (no previous channel)", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(mockMarkChannelRead).not.toHaveBeenCalled();
  });

  it("invalidates the previous channel's loaded window when switching away, so a revisit refetches the tail", () => {
    // The server only delivers live broadcasts for the focused channel, so
    // the window being left stops updating the moment focus moves away.
    // loadMessages short-circuits on the loaded flag — leaving must drop it
    // or the revisit renders the old snapshot as if it were current.
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");
    expect(mockInvalidateWindow).not.toHaveBeenCalled();

    ctrl.mountChannel(99, "random");
    expect(mockInvalidateWindow).toHaveBeenCalledWith(42);

    ctrl.mountChannel(42, "general");
    expect(mockInvalidateWindow).toHaveBeenCalledWith(99);
    // Each mount still asks for the tail exactly once.
    expect(opts.msgCtrl.loadMessages).toHaveBeenCalledTimes(3);
  });

  it("drops cached who-reacted lists when leaving a channel, since its reaction updates stop", async () => {
    setReactionUsersFetcher(vi.fn().mockResolvedValue([{ id: 2, username: "bob", avatar: "" }]));
    clearReactionUsersCache();
    const ctrl = createChannelController(makeOpts());
    ctrl.mountChannel(42, "general");
    await loadReactionUsers(42, 500, "👍");
    expect(getCachedReactionUsers(500, "👍")).toHaveLength(1);

    ctrl.mountChannel(99, "random");

    expect(getCachedReactionUsers(500, "👍")).toBeUndefined();
    setReactionUsersFetcher(null);
  });

  // UX-8: the ready-time auto-select no longer clears a badge (selecting is
  // not viewing), so mounting the channel is what clears it.
  describe("mount clears the unread badge", () => {
    it("clears the mounted channel's unread and mention counts", () => {
      setChannels([
        {
          id: 42,
          name: "general",
          type: "text",
          category: null,
          position: 0,
          unread_count: 5,
          mention_count: 2,
        },
      ]);
      expect(channelsStore.getState().channels.get(42)?.unreadCount).toBe(5);

      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      expect(channelsStore.getState().channels.get(42)?.unreadCount).toBe(0);
      expect(channelsStore.getState().channels.get(42)?.mentionCount).toBe(0);
    });

    it("a DM mount does not overwrite the remembered server channel", () => {
      localStorage.clear();
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(5, "random", "text");
      ctrl.mountChannel(40, "alice", "dm");

      expect(loadLastChannel()).toBe(5);
    });
  });

  it("does not invalidate any window on the very first mount, which fetches exactly once", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(mockInvalidateWindow).not.toHaveBeenCalled();
    expect(opts.msgCtrl.loadMessages).toHaveBeenCalledTimes(1);
  });

  it("updates chat header name", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(opts.chatHeaderName!.textContent).toBe("general");
  });

  it("destroyChannel resets state", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");
    ctrl.destroyChannel();

    expect(ctrl.currentChannelId).toBeNull();
    expect(ctrl.messageList).toBeNull();
  });

  describe("destroyChannel edge cases", () => {
    it("destroyChannel is safe to call when no channel is mounted", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      // Should not throw
      ctrl.destroyChannel();
      expect(ctrl.currentChannelId).toBeNull();
    });

    it("destroyChannel aborts the channel signal", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      ctrl.destroyChannel();

      // Verify edit-last-message listener is cleaned up (signal aborted)
      // by dispatching the event and checking startEdit is not called
      mockGetChannelMessages.mockReturnValue([
        { id: 1, content: "msg", user: { id: 1, username: "me" }, deleted: false },
      ]);
      vi.clearAllMocks();
      opts.slots.inputSlot.dispatchEvent(new Event("edit-last-message"));
      expect(mockStartEdit).not.toHaveBeenCalled();
    });

    it("destroyChannel closes any open reaction picker — it survives every other teardown path otherwise", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      ctrl.destroyChannel();

      expect(opts.reactionCtrl.destroy).toHaveBeenCalled();
    });

    it("invalidates the torn-down channel's loaded window, so a bare destroyChannel (not a channel-to-channel switch) does not leave it stale", () => {
      // The NSFW gate's "Go Back" and a resync-driven setActiveChannel(null)
      // both tear down via a bare destroyChannel() with no next mountChannel
      // to invalidate the outgoing channel via the previousChannelId path.
      // Without invalidation here, the channel keeps its "loaded" flag and
      // the next visit renders the pre-teardown snapshot as current.
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      mockInvalidateWindow.mockClear();

      ctrl.destroyChannel();

      expect(mockInvalidateWindow).toHaveBeenCalledWith(42);
    });

    it("does not invalidate anything when destroyChannel is called with no channel mounted", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);

      ctrl.destroyChannel();

      expect(mockInvalidateWindow).not.toHaveBeenCalled();
    });
  });
});

describe("unsent attachments (2A-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsIdle.mockReturnValue(true);
    mockGetDraft.mockReturnValue({ content: "", replyTo: null, attachments: [] });
    setConnectionStatus("connected");
  });

  /** Deliver a frame to every live ws.on listener for `event`, in order. */
  function wsHandler(opts: ChannelControllerOptions, event: string) {
    const on = opts.ws.on as ReturnType<typeof vi.fn>;
    return (payload: unknown, correlationId?: string): void => {
      on.mock.calls.forEach((c, i) => {
        const off = on.mock.results[i]!.value as ReturnType<typeof vi.fn>;
        if (c[0] === event && off.mock.calls.length === 0) {
          (c[1] as (p: unknown, id?: string) => void)(payload, correlationId);
        }
      });
    };
  }

  const report = { id: "u1", filename: "report.pdf" };
  const scan = { id: "u2", filename: "scan.png" };

  function sendFiles(opts: ChannelControllerOptions, replyTo: number | null = null): void {
    vi.mocked(opts.ws.send).mockReturnValue("cid-1");
    capturedMessageInputOpts.onSend("", replyTo, ["u1", "u2"], [report, scan], replyTo !== null);
  }

  it("puts only the skipped files back into the composer", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(42, "general", "text");
    sendFiles(opts);

    wsHandler(opts, "chat_send_ok")(
      { message_id: 7, timestamp: "", skipped_attachment_ids: ["u2", "not-mine"] },
      "cid-1",
    );

    expect(mockRestoreUnsent).toHaveBeenCalledTimes(1);
    expect(mockRestoreUnsent).toHaveBeenCalledWith([scan], "skipped", null);
    expect(mockRemoveOptimistic).not.toHaveBeenCalled();
    ctrl.destroyChannel();
  });

  it("puts skipped files back on a deduplicated retry's ack too", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(42, "general", "text");
    sendFiles(opts);

    wsHandler(opts, "chat_send_ok")(
      { message_id: 7, timestamp: "", deduplicated: true, skipped_attachment_ids: ["u1"] },
      "cid-1",
    );

    expect(mockRestoreUnsent).toHaveBeenCalledWith([report], "skipped", null);
    ctrl.destroyChannel();
  });

  it("stashes the files when the refusal lands with no channel mounted", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(42, "general", "text");
    sendFiles(opts);
    ctrl.destroyChannel();

    wsHandler(opts, "error")({ code: "ATTACHMENTS_UNAVAILABLE", message: "" }, "cid-1");

    ctrl.mountChannel(42, "general", "text");
    expect(mockRestoreDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ id: "u1", unsent: true }),
          expect.objectContaining({ id: "u2", unsent: true }),
        ],
      }),
    );
    ctrl.destroy();
  });

  it("stops listening once the controller is destroyed", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(42, "general", "text");
    sendFiles(opts);
    ctrl.destroy();

    wsHandler(opts, "chat_send_ok")(
      { message_id: 7, timestamp: "", skipped_attachment_ids: ["u1"] },
      "cid-1",
    );
    expect(mockRestoreUnsent).not.toHaveBeenCalled();
  });

  it("leaves the composer alone when an older server sends no skipped list", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(42, "general", "text");
    sendFiles(opts);

    wsHandler(opts, "chat_send_ok")({ message_id: 7, timestamp: "" }, "cid-1");

    expect(mockRestoreUnsent).not.toHaveBeenCalled();
    ctrl.destroyChannel();
  });

  it("stashes skipped files for a channel the user has left", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(42, "general", "text");
    sendFiles(opts);
    ctrl.mountChannel(43, "random", "text");

    wsHandler(opts, "chat_send_ok")(
      { message_id: 7, timestamp: "", skipped_attachment_ids: ["u1"] },
      "cid-1",
    );
    expect(mockRestoreUnsent).not.toHaveBeenCalled();

    ctrl.mountChannel(42, "general", "text");
    expect(mockRestoreDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ id: "u1", unsent: true })],
      }),
    );
    ctrl.destroyChannel();
  });

  it("drops the row and returns every file and the reply on ATTACHMENTS_UNAVAILABLE", () => {
    mockGetChannelMessages.mockReturnValue([{ id: 9, user: { id: 2, username: "ana" } }]);
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(42, "general", "text");
    sendFiles(opts, 9);

    wsHandler(opts, "error")({ code: "ATTACHMENTS_UNAVAILABLE", message: "" }, "cid-1");

    expect(mockRestoreUnsent).toHaveBeenCalledWith([report, scan], "unavailable", {
      messageId: 9,
      username: "ana",
      self: false,
      ping: true,
    });
    // No Retry with the same ids: the send's draft is gone.
    vi.mocked(opts.ws.send).mockClear();
    capturedMessageListOpts.onRetry("cid-1");
    expect(opts.ws.send).not.toHaveBeenCalled();
    mockGetChannelMessages.mockReturnValue([]);
    ctrl.destroyChannel();
  });
});

describe("a forum channel", () => {
  const FORUM = 5151;
  const TEXT = 5152;
  const destinations = NAVIGATION_DESTINATIONS as {
    forum?: { build: (c: ForumViewContext) => HTMLElement };
  };
  const realForum = destinations.forum;
  let built: ForumViewContext[];

  function seed(forumOver: { nsfw?: boolean; nsfw_acknowledged?: boolean } = {}): void {
    setChannels([
      {
        id: FORUM,
        name: "feedback",
        type: "forum",
        category: null,
        position: 0,
        can_send: true,
        ...forumOver,
      },
      { id: TEXT, name: "general", type: "text", category: null, position: 1, can_send: true },
    ]);
  }

  // The (mocked) lazy gate module resolves after its async factory: load it once.
  beforeAll(async () => {
    await import("@components/NsfwGate");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    built = [];
    destinations.forum = {
      build: (ctx) => {
        built.push(ctx);
        const el = document.createElement("div");
        el.className = "forum-view";
        return el;
      },
    };
    seed();
  });
  afterEach(() => {
    destinations.forum = realForum;
  });

  it("mounts the forum view in the messages slot, with no message list, typing row or composer", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(FORUM, "feedback", "forum");

    expect(ctrl.currentChannelId).toBe(FORUM);
    expect(built).toHaveLength(1);
    expect(opts.slots.messagesSlot.querySelector(".forum-view")).not.toBeNull();
    expect(createMessageList).not.toHaveBeenCalled();
    expect(mockMessageInputMount).not.toHaveBeenCalled();
    expect(mockTypingMount).not.toHaveBeenCalled();
    expect(opts.slots.inputSlot.childElementCount).toBe(0);
    expect(opts.msgCtrl.loadMessages).not.toHaveBeenCalled();
    expect(opts.ws.send).toHaveBeenCalledWith({
      type: "channel_focus",
      payload: { channel_id: FORUM },
    });
    ctrl.destroyChannel();
  });

  it("hands the view the channel, the api, the socket and the channel's own signal", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(FORUM, "feedback", "forum");

    const ctx = built[0]!;
    expect(ctx.channelId).toBe(FORUM);
    expect(ctx.api).toBe(opts.api);
    expect(ctx.ws).toBe(opts.ws);
    expect(ctx.signal.aborted).toBe(false);
    ctrl.destroyChannel();
    expect(ctx.signal.aborted).toBe(true);
    expect(opts.slots.messagesSlot.querySelector(".forum-view")).toBeNull();
  });

  it("decides by the stored type when the caller passes none", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(FORUM, "feedback");
    expect(built).toHaveLength(1);
    ctrl.destroyChannel();
  });

  it("mounts a text channel the usual way", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(TEXT, "general", "text");
    expect(built).toHaveLength(0);
    expect(createMessageList).toHaveBeenCalled();
    ctrl.destroyChannel();
  });

  it("leaves a forum without a mark-read, since it holds no messages", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(FORUM, "feedback", "forum");
    ctrl.mountChannel(TEXT, "general", "text");
    expect(mockMarkChannelRead).not.toHaveBeenCalledWith(FORUM);
    expect(mockLeaveChannel).not.toHaveBeenCalledWith(FORUM);
    ctrl.destroyChannel();
  });

  it("opens a followed post asked for from another channel once the forum mounts", () => {
    const opts = makeOpts({
      slots: { ...makeSlots(), threadSlot: document.createElement("div") as HTMLDivElement },
    });
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(TEXT, "general", "text");
    requestOpenThread(77, FORUM);
    expect(mockThreadOpenById).not.toHaveBeenCalled();

    ctrl.mountChannel(FORUM, "feedback", "forum");
    expect(mockThreadOpenById).toHaveBeenCalledTimes(1);
    const [threadId, parentId, signal] = mockThreadOpenById.mock.calls[0]!;
    expect(threadId).toBe(77);
    expect(parentId).toBe(FORUM);
    expect(signal).toBe(built[0]!.signal);

    // The request is spent: the next mount opens nothing.
    ctrl.mountChannel(TEXT, "general", "text");
    ctrl.mountChannel(FORUM, "feedback", "forum");
    expect(mockThreadOpenById).toHaveBeenCalledTimes(1);
    ctrl.destroy();
  });

  it("puts a labelled forum behind the consent gate, mounting nothing of the forum", async () => {
    seed({ nsfw: true, nsfw_acknowledged: false });
    const opts = makeOpts({
      api: {
        acknowledgeNsfw: vi.fn(),
        revokeNsfw: vi.fn(),
      } as unknown as ChannelControllerOptions["api"],
    });
    const ctrl = createChannelController(opts);
    ctrl.mountChannel(FORUM, "feedback", "forum");
    await vi.dynamicImportSettled();
    expect(mockCreateNsfwGate).toHaveBeenCalled();
    expect(built).toHaveLength(0);
    ctrl.destroyChannel();
  });
});
