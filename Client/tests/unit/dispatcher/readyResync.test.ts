import { describe, it, expect, vi, afterEach, onTestFinished } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { wireDispatcher } from "../../../src/lib/dispatcher";
import { expectConsole } from "../../helpers/console";
import { channelsStore } from "../../../src/stores/channels.store";
import {
  addOptimisticMessage,
  getChannelMessages,
  setMessages,
  markSendFailed,
  isChannelLoaded,
  getHistoryLoadState,
  prependMessages,
  setAroundMessages,
  isWindowDetached,
} from "../../../src/stores/messages.store";
import { registerReadingAnchor } from "../../../src/features/messaging/readingAnchor";
import { membersStore } from "../../../src/stores/members.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { dmStore } from "../../../src/stores/dm.store";
import {
  clearReactionUsersCache,
  getCachedReactionUsers,
  loadReactionUsers,
  setReactionUsersFetcher,
} from "../../../src/features/messaging/reactionUsers";
import { setMarkReadSender } from "../../../src/lib/readState";
import type { MessageResponse } from "../../../src/lib/types";
import { ensureIdentityKeyPublished as _ensureIdentityKeyPublished } from "../../../src/lib/net/identity";
import {
  useDispatcherHarness,
  readyChannel,
  readyEvent,
  setActiveChannel,
  dmRow,
  readyDm,
  readyMember,
  channelRow,
  seedChannels,
  patchAuth,
  seedDms,
  mock,
  replaceDispatcher,
} from "../../helpers/dispatcherHarness";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

const mockEnsurePublished = vi.mocked(_ensureIdentityKeyPublished);

describe("WS Dispatcher", () => {
  useDispatcherHarness();

  // Re-wires the dispatcher with the given deps (and an empty block list),
  // after tearing down the one the harness wired.
  function rewire(
    deps: Omit<NonNullable<Parameters<typeof wireDispatcher>[1]>, "listBlocks">,
  ): void {
    replaceDispatcher({
      listBlocks: vi.fn().mockResolvedValue({ blocked_user_ids: [] }),
      ...deps,
    });
  }

  it("wires ready to channels, members, and voice stores", () => {
    mock.dispatch("ready", {
      channels: [
        readyChannel(),
        { id: 2, name: "voice", type: "voice", category: null, position: 1 },
      ],
      members: [readyMember({ id: 1, username: "alex", role: "admin" })],
      voice_states: [{ channel_id: 2, user_id: 1, muted: false, deafened: false }],
      roles: [],
    });

    expect(channelsStore.getState().channels.size).toBe(2);
    expect(membersStore.getState().members.size).toBe(1);
    expect(voiceStore.getState().voiceUsers.size).toBe(1);
  });

  it("wires ready with DM channels in payload", () => {
    mock.dispatch(
      "ready",
      readyEvent({
        channels: [readyChannel()],
        roles: [{ id: 1, name: "admin", permissions: 0x7fffffff }],
        dm_channels: [
          {
            channel_id: 100,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            last_message_id: 5,
            last_message: "hello",
            last_message_at: "2026-03-15T10:00:00Z",
            unread_count: 2,
          },
        ],
      }),
    );

    const dms = dmStore.getState().channels;
    expect(dms).toHaveLength(1);
    expect(dms[0]!.channelId).toBe(100);
    expect(dms[0]!.recipient.username).toBe("bob");
    expect(dms[0]!.unreadCount).toBe(2);
  });

  it("ready auto-selects first text channel when no active channel", () => {
    mock.dispatch(
      "ready",
      readyEvent({
        channels: [
          { id: 5, name: "voice-only", type: "voice", category: null, position: 0 },
          readyChannel({ id: 7, position: 1 }),
        ],
      }),
    );

    expect(channelsStore.getState().activeChannelId).toBe(7);
  });

  it("ready auto-selects an announcement channel when no text channel is visible", () => {
    // Announcement channels are full message channels everywhere else (the
    // server ships unread_count/can_send for them, the sidebar renders them,
    // ChannelController gives them a composer) — a user whose only readable
    // channel is an announcement channel must still land on it, not a blank
    // pane, on first ready.
    mock.dispatch(
      "ready",
      readyEvent({
        channels: [{ id: 9, name: "news", type: "announcement", category: null, position: 0 }],
      }),
    );

    expect(channelsStore.getState().activeChannelId).toBe(9);
  });

  it("ready does NOT change active channel when it is still present in the payload", () => {
    // Regression guard for the auto-select branch: an already-active channel
    // that is STILL in the new snapshot must not be reassigned to the first
    // text channel (99 sorts after 1, so a naive "pick first" would move it).
    setActiveChannel(99);

    mock.dispatch(
      "ready",
      readyEvent({
        channels: [
          readyChannel(),
          { id: 99, name: "kept", type: "text", category: null, position: 1 },
        ],
      }),
    );

    expect(channelsStore.getState().activeChannelId).toBe(99);
  });

  it("ready clears the active channel when it is no longer present in the payload", () => {
    // Was locked as "does NOT change active channel when one is already
    // set" — but 99 was never actually IN that payload, so this was really
    // pinning the bug (BUG report #2): a channel deleted/closed while this
    // client was offline stayed "active" forever, leaving its message list
    // and composer mounted against a channel the server no longer knows.
    setActiveChannel(99);

    mock.dispatch("ready", readyEvent({ channels: [readyChannel()] }));

    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("ready keeps the active DM channel when it is still present in dm_channels", () => {
    setActiveChannel(50);

    mock.dispatch("ready", readyEvent({ dm_channels: [readyDm()] }));

    expect(channelsStore.getState().activeChannelId).toBe(50);
  });

  it("ready with no text channels does not set active", () => {
    mock.dispatch(
      "ready",
      readyEvent({
        channels: [{ id: 5, name: "voice-only", type: "voice", category: null, position: 0 }],
      }),
    );

    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("ready with no DM channels in payload leaves dmStore empty", () => {
    mock.dispatch("ready", readyEvent());

    expect(dmStore.getState().channels).toHaveLength(0);
  });

  it("ready with an empty dm_channels array clears stale DM rows", () => {
    // The server always sends dm_channels; [] is an authoritative "no open
    // DMs" (all closed on another device), not "nothing to say".
    seedDms([dmRow()]);

    mock.dispatch("ready", readyEvent({ dm_channels: [] }));

    expect(dmStore.getState().channels).toHaveLength(0);
  });

  describe("ready re-marks the active channel read", () => {
    afterEach(() => {
      setMarkReadSender(null);
    });

    // Resyncs channel 1 while the window has (or lacks) focus; the payload
    // restates 4 unread and 2 mentions. Returns the mark_read sender.
    function resyncActiveChannel(focused: boolean): ReturnType<typeof vi.fn> {
      const focus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
      onTestFinished(() => focus.mockRestore());
      const sender = vi.fn();
      setMarkReadSender(sender);
      setActiveChannel(1);

      mock.dispatch(
        "ready",
        readyEvent({
          channels: [readyChannel({ unread_count: 4, mention_count: 2 })],
          dm_channels: [],
        }),
      );
      return sender;
    }

    it("clears the resurrected badge and advances the server read state for the focused channel", () => {
      // read_states go stale while a channel stays focused (channel_focus is
      // sent once per mount), so a full-ready resync restates non-zero counts
      // for the channel the user is currently reading.
      const sender = resyncActiveChannel(true);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.unreadCount).toBe(0);
      expect(ch?.mentionCount).toBe(0);
      expect(sender).toHaveBeenCalledWith(1);
    });

    it("keeps the restated badge and sends no mark_read for an unfocused resync", () => {
      const sender = resyncActiveChannel(false);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.unreadCount).toBe(4);
      expect(ch?.mentionCount).toBe(2);
      expect(sender).not.toHaveBeenCalled();
    });

    it("clears the badge for the actively viewed DM too", () => {
      const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      onTestFinished(() => focus.mockRestore());
      const sender = vi.fn();
      setMarkReadSender(sender);
      setActiveChannel(50);

      mock.dispatch(
        "ready",
        readyEvent({
          dm_channels: [
            {
              channel_id: 50,
              recipient: { id: 10, username: "bob", avatar: "", status: "online" },
              last_message_id: 5,
              last_message: "hello",
              last_message_at: "2026-03-15T10:00:00Z",
              unread_count: 3,
              mention_count: 1,
            },
          ],
        }),
      );

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.unreadCount).toBe(0);
      expect(dm?.mentionCount).toBe(0);
      expect(sender).toHaveBeenCalledWith(50);
    });

    it("does not send mark_read when no channel was active before the ready", () => {
      const sender = vi.fn();
      setMarkReadSender(sender);

      mock.dispatch("ready", readyEvent({ channels: [readyChannel()], dm_channels: [] }));

      // Auto-select ran, but a first connect is not a resync — the payload's
      // counts are fresh and the user was not yet reading anything.
      expect(sender).not.toHaveBeenCalled();
    });

    // "Cleared by this ready" and "nothing was active" are different states.
    // The presence check spans channels AND dm_channels, so an unrelated open
    // DM must not keep a deleted channel alive; and once cleared, mark_read
    // must not be sent for an id the server no longer recognizes.
    it("does not mark_read the channel this ready just cleared", () => {
      const sender = vi.fn();
      setMarkReadSender(sender);
      setActiveChannel(99);

      mock.dispatch("ready", readyEvent({ channels: [readyChannel()], dm_channels: [readyDm()] }));

      expect(channelsStore.getState().activeChannelId).toBeNull();
      expect(sender).not.toHaveBeenCalled();
    });
  });

  describe("ready reconciles the DM channelsStore mirror", () => {
    function seedDmMirrorRow(unreadCount: number, mentionCount: number): void {
      seedChannels([channelRow({ id: 50, name: "bob", type: "dm", unreadCount, mentionCount })]);
    }

    // The mirror row is only ever created by addDmToChannelsStore (on open),
    // and setChannels' carry loop deliberately preserves dm-typed rows across
    // every ready rebuild — so a DM closed elsewhere while offline keeps a
    // phantom row here forever unless something prunes it.
    it("removes a dm-typed mirror row absent from the fresh dm_channels payload", () => {
      seedDmMirrorRow(3, 1);

      mock.dispatch("ready", readyEvent({ dm_channels: [] }));

      expect(channelsStore.getState().channels.has(50)).toBe(false);
    });

    // incrementUnread/incrementMention bump the mirror in parallel with
    // dmStore once it exists, but only dmStore is restated by `ready` — so a
    // DM read on another device keeps a stale count here that survives every
    // reconnect until this reconciles it too.
    it("restates a surviving dm-typed mirror row's unread/mention counts from the payload", () => {
      seedDmMirrorRow(9, 4);

      mock.dispatch("ready", readyEvent({ dm_channels: [readyDm({ mention_count: 0 })] }));

      const ch = channelsStore.getState().channels.get(50);
      expect(ch?.unreadCount).toBe(0);
      expect(ch?.mentionCount).toBe(0);
    });

    // The two counts drift independently: a mention resolved on another
    // device leaves the unread count exactly where it already was, so a
    // reconciliation keyed on the unread count alone would keep rendering a
    // mention badge that no longer exists.
    it("restates a mirror row whose mention count alone drifted", () => {
      seedDmMirrorRow(2, 4);

      mock.dispatch(
        "ready",
        readyEvent({ dm_channels: [readyDm({ unread_count: 2, mention_count: 1 })] }),
      );

      const ch = channelsStore.getState().channels.get(50);
      expect(ch?.mentionCount).toBe(1);
      expect(ch?.unreadCount).toBe(2);
    });

    it("leaves a non-dm channel row's counts alone", () => {
      seedChannels([channelRow({ id: 1, name: "general", unreadCount: 5 })], {
        activeChannelId: 2,
      });

      mock.dispatch(
        "ready",
        readyEvent({
          channels: [
            {
              id: 1,
              name: "general",
              type: "text",
              category: null,
              position: 0,
              unread_count: 5,
              mention_count: 0,
            },
          ],
          dm_channels: [],
        }),
      );

      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(5);
    });
  });

  describe("ready invalidates loaded message windows on a full-ready resync", () => {
    function storedMessage(id: number, channelId = 1): MessageResponse {
      return {
        id,
        channel_id: channelId,
        user: { id: 1, username: "alex", avatar: null },
        content: `msg ${id}`,
        reply_to: null,
        attachments: [],
        reactions: [],
        pinned: false,
        edited_at: null,
        deleted: false,
        timestamp: "2026-03-15T09:00:00Z",
      };
    }

    it("leaves history alone on the session's very first ready", () => {
      setMessages(1, [storedMessage(10)], false);
      setActiveChannel(1);

      mock.dispatch("ready", readyEvent({ dm_channels: [] }));

      expect(isChannelLoaded(1)).toBe(true);
      expect(getChannelMessages(1)).toHaveLength(1);
    });

    // The full-ready tier (this is the only tier that ever sends `ready`
    // again after the first) never replays chat_message frames, so every
    // channel loaded before the drop keeps a permanent hole unless its
    // window is invalidated and the one on screen is refetched.
    it("invalidates every loaded channel and refetches the active one on a second ready", async () => {
      const getMessages = vi.fn().mockResolvedValue({
        messages: [storedMessage(900)],
        has_more: false,
      });
      rewire({ getMessages });

      setActiveChannel(1);
      setMessages(1, [storedMessage(10)], false);
      setMessages(2, [storedMessage(20, 2)], false);
      // Channel 1 must stay present in every ready payload — otherwise the
      // "channel this session was viewing is gone" branch clears
      // activeChannelId first, which would make the refetch target null for
      // reasons unrelated to what this test is pinning.
      const readyChannels = [readyChannel()];

      // First ready in this dispatcher's lifetime: initial connect.
      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));
      expect(getMessages).not.toHaveBeenCalled();

      // Second ready: a full-ready resync.
      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));

      // The inactive channel is invalidated but not eagerly refetched; its
      // rows stay for an instant render on the next visit (P2-T4).
      expect(isChannelLoaded(2)).toBe(false);
      expect(getChannelMessages(2).map((m) => m.id)).toEqual([20]);

      // The active channel is refetched from the server.
      expect(getMessages).toHaveBeenCalledWith(1, { limit: 50 });
      await Promise.resolve();
      await Promise.resolve();
      expect(getChannelMessages(1).map((m) => m.id)).toEqual([900]);
      expect(isChannelLoaded(1)).toBe(true);
    });

    // OC-0007: invalidateLoadedMessageWindows() synchronously drops the
    // active channel's rows and loadedChannels entry, but leaves
    // historyLoadState untouched. If the resync handler doesn't also mark
    // the channel "loading", MessageList's empty-state branch (no rows +
    // idle load state) reads as a genuinely empty channel for the entire
    // round trip of the refetch, instead of showing the in-region spinner
    // every other first-page fetch shows.
    it("marks the active channel loading (not idle) while the resync refetch is in flight", () => {
      // Never resolves within this test — pins the synchronous state right
      // after the resync `ready` is handled, before the refetch lands.
      const getMessages = vi.fn().mockReturnValue(new Promise(() => {}));
      rewire({ getMessages });

      setActiveChannel(1);
      setMessages(1, [storedMessage(10)], false);
      const readyChannels = [readyChannel()];

      // First ready: initial connect.
      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));

      // Second ready: a full-ready resync. The synchronous invalidation runs
      // and the refetch is fired but never resolves in this test.
      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));

      // The rows stay on screen (P2-T4); the load state is "loading", not
      // idle (null), so a channel that had no rows shows the spinner rather
      // than reading as a channel with no history.
      expect(isChannelLoaded(1)).toBe(false);
      expect(getChannelMessages(1).map((m) => m.id)).toEqual([10]);
      expect(getHistoryLoadState(1)).toBe("loading");
    });

    // OC-0203: the refetch above is fired-and-forgotten against whatever
    // channel was active when the resync `ready` arrived — but the user can
    // switch channels before the HTTP response lands. The continuation must
    // re-check that the fetched channel is still the active one before
    // writing setMessages, or it resurrects a stale pre-resync snapshot for
    // a channel the user already left (and, worse, re-marks it "loaded" so
    // MessageController.loadMessages never refetches it again on return).
    it("does not write a stale resync snapshot for a channel the user switched away from mid-refetch", async () => {
      let resolveGetMessages:
        ((resp: { messages: MessageResponse[]; has_more: boolean }) => void) | null = null;
      const getMessages = vi.fn().mockImplementation(
        () =>
          new Promise<{ messages: MessageResponse[]; has_more: boolean }>((resolve) => {
            resolveGetMessages = resolve;
          }),
      );
      rewire({ getMessages });

      setActiveChannel(1);
      setMessages(1, [storedMessage(10)], false);
      setMessages(2, [storedMessage(20, 2)], false);
      const readyChannels = [readyChannel(), readyChannel({ id: 2, name: "other" })];

      // First ready: initial connect.
      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));

      // Second ready: a full-ready resync. The refetch for channel 1 (the
      // active channel at the time) starts but does not resolve yet.
      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));
      expect(getMessages).toHaveBeenCalledWith(1, { limit: 50 });
      expect(isChannelLoaded(1)).toBe(false);

      // The user switches to channel 2 before that refetch resolves.
      setActiveChannel(2);

      // The stale channel-1 refetch now resolves with its pre-resync-era
      // snapshot.
      resolveGetMessages!({ messages: [storedMessage(900)], has_more: false });
      await Promise.resolve();
      await Promise.resolve();

      // Channel 1 must stay invalidated — writing the stale snapshot here
      // would re-add it to loadedChannels, permanently hiding every message
      // posted to it while the user was looking at channel 2.
      expect(isChannelLoaded(1)).toBe(false);
      expect(getChannelMessages(1).map((m) => m.id)).toEqual([10]);
    });

    // BUG: invalidateLoadedMessageWindows() ran unconditionally, but the
    // refetch below it only runs when there's a resolvable active channel
    // AND api.getMessages exists (api is a Partial<...>, so it may be
    // absent). When it can't refetch, every loaded window is dropped with
    // nothing left to reload it — the mounted MessageList is stuck showing
    // only carried-through pending rows until the user navigates away and
    // back. The default wireDispatcher(mock.ws) from the outer beforeEach
    // has no `api` at all, so there is no getMessages to refetch with here.
    it("keeps loaded history across a resync when there is no getMessages to refetch it", () => {
      setActiveChannel(1);
      setMessages(1, [storedMessage(10)], false);

      const readyChannels = [readyChannel()];

      // First ready: initial connect.
      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));

      // Second ready: a full-ready resync, with nothing able to refetch it.
      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));

      expect(isChannelLoaded(1)).toBe(true);
      expect(getChannelMessages(1)).toHaveLength(1);
    });

    it("drops every cached who-reacted list on a second ready, which replays no reaction_update", async () => {
      const fetcher = vi.fn().mockResolvedValue([{ id: 1, username: "alice", avatar: "" }]);
      setReactionUsersFetcher(fetcher as never);
      clearReactionUsersCache();
      await loadReactionUsers(1, 200, "👍");

      const ready = {
        channels: [],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      };
      mock.dispatch("ready", ready);
      expect(getCachedReactionUsers(200, "👍")).toHaveLength(1);

      mock.dispatch("ready", ready);
      expect(getCachedReactionUsers(200, "👍")).toBeUndefined();
      setReactionUsersFetcher(null);
    });

    it("carries a failed optimistic row through the resync invalidation", () => {
      const getMessages = vi.fn().mockResolvedValue({ messages: [], has_more: false });
      rewire({ getMessages });

      setActiveChannel(1);
      setMessages(1, [storedMessage(10)], false);
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: { id: 1, username: "alex", avatar: null },
        content: "unsent",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("c1", "SLOW_MODE");

      mock.dispatch("ready", readyEvent({ dm_channels: [] }));
      mock.dispatch("ready", readyEvent({ dm_channels: [] }));

      const msgs = getChannelMessages(1);
      expect(msgs.some((m) => m.correlationId === "c1" && m.status === "failed")).toBe(true);
    });

    // Guard added by commit 34c89fb: invalidate only runs when there IS a
    // resolvable active channel to refetch. Without it, a resync landing with
    // no active channel (e.g. logged in but nothing selected yet) would drop
    // every loaded window with nothing able to reload it — the same "stuck
    // empty" bug as the no-getMessages case above, just keyed on activeId
    // instead of api.getMessages. Pins the guard's other half and that no
    // downstream step in the ready handler assumes the invalidation ran.
    it("does not throw and leaves history untouched when no channel is active on resync", () => {
      const getMessages = vi.fn().mockResolvedValue({ messages: [], has_more: false });
      rewire({ getMessages });

      // Channel 1 is loaded but never made active — an empty `channels` list
      // on both readies means nothing ever auto-selects it.
      setMessages(1, [storedMessage(10)], false);

      expect(() => {
        mock.dispatch("ready", readyEvent({ dm_channels: [] }));
        mock.dispatch("ready", readyEvent({ dm_channels: [] }));
      }).not.toThrow();

      expect(getMessages).not.toHaveBeenCalled();
      expect(isChannelLoaded(1)).toBe(true);
      expect(getChannelMessages(1)).toHaveLength(1);
    });

    // NEW residual gap the guard move opens: invalidate and the refetch now
    // always fire together, but invalidate is synchronous while the refetch
    // is async — so a rejection lands *after* the active channel's window is
    // already dropped. The .catch only logs; without also marking the
    // channel load-errored, the mounted MessageList falls back to its empty
    // "no messages yet" welcome state (virtualItems.length === 0 and
    // historyLoadState is still idle) instead of the inline error+Retry
    // state — silently misrepresenting a failed reload as a genuinely empty
    // channel, which is exactly the kind of silent history hole B2-1 exists
    // to prevent.
    it("marks the active channel load-errored when the resync refetch rejects", async () => {
      const getMessages = vi.fn().mockRejectedValue(new Error("network down"));
      rewire({ getMessages });

      setActiveChannel(1);
      setMessages(1, [storedMessage(10)], false);

      const readyChannels = [readyChannel()];

      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));
      mock.dispatch("ready", readyEvent({ channels: readyChannels, dm_channels: [] }));

      await Promise.resolve();
      await Promise.resolve();

      expect(isChannelLoaded(1)).toBe(false);
      expect(getHistoryLoadState(1)).toBe("error");
      expectConsole("warn", /\[dispatcher\] Failed to reload message history after resync/);
    });

    // Mirror of the .then guard: a rejection that lands after the user
    // switched away belongs to a channel whose own mount/retry path now owns
    // its load state. Flagging it errored paints an inline error + Retry on a
    // channel whose load never failed, the next time the user opens it.
    it("does not flag a channel load-errored when the rejection lands after a switch away", async () => {
      let rejectGetMessages: ((err: Error) => void) | null = null;
      const getMessages = vi.fn().mockImplementation(
        () =>
          new Promise<{ messages: MessageResponse[]; has_more: boolean }>((_resolve, reject) => {
            rejectGetMessages = reject;
          }),
      );
      rewire({ getMessages });

      setActiveChannel(1);
      setMessages(1, [storedMessage(10)], false);
      const readyChannels = [readyChannel(), readyChannel({ id: 2, name: "other" })];
      const readyPayload = {
        channels: readyChannels,
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      };

      // First ready: initial connect. Second: the full-ready resync whose
      // refetch for channel 1 is still in flight below.
      mock.dispatch("ready", readyPayload);
      mock.dispatch("ready", readyPayload);
      expect(getMessages).toHaveBeenCalledWith(1, { limit: 50 });

      setActiveChannel(2);
      rejectGetMessages!(new Error("network down"));
      await Promise.resolve();
      await Promise.resolve();

      expect(getHistoryLoadState(1)).not.toBe("error");
      expectConsole("warn", /\[dispatcher\] Failed to reload message history after resync/);
    });

    // P2-T4: a server restart (or any other full resync) keeps the history
    // the reader loaded and splices the refetch into it.
    describe("keeps loaded history (P2-T4)", () => {
      const readyPayload = {
        channels: [readyChannel()],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      };
      /** Newest-first page of ids [from, to], as the REST API returns it. */
      function page(from: number, to: number): MessageResponse[] {
        const out: MessageResponse[] = [];
        for (let id = to; id >= from; id--) out.push(storedMessage(id));
        return out;
      }
      const ids = (from: number, to: number): number[] =>
        Array.from({ length: to - from + 1 }, (_, i) => from + i);
      function load200(): void {
        setMessages(1, page(151, 200), true);
        prependMessages(1, page(101, 150), true);
        prependMessages(1, page(51, 100), true);
        prependMessages(1, page(1, 50), false);
      }
      async function settle(): Promise<void> {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      }

      it("keeps 200 loaded rows synchronously and splices an overlapping tail", async () => {
        const fresh = page(151, 200).map((m) =>
          m.id === 180 ? { ...m, content: "edited while down" } : m,
        );
        const getMessages = vi.fn().mockResolvedValue({ messages: fresh, has_more: true });
        rewire({ getMessages });
        setActiveChannel(1);
        load200();
        const cached = getChannelMessages(1);

        mock.dispatch("ready", readyPayload);
        mock.dispatch("ready", readyPayload);

        expect(getChannelMessages(1)).toBe(cached);
        expect(getHistoryLoadState(1)).toBe("loading");
        expect(getMessages).toHaveBeenCalledWith(1, { limit: 50 });

        await settle();
        const msgs = getChannelMessages(1);
        expect(msgs.map((m) => m.id)).toEqual(ids(1, 200));
        expect(msgs[0]).toBe(cached[0]);
        expect(msgs.find((m) => m.id === 180)!.content).toBe("edited while down");
        expect(isChannelLoaded(1)).toBe(true);
        expect(getHistoryLoadState(1)).toBeNull();
      });

      it("replaces the window when the tail is disjoint from it", async () => {
        const getMessages = vi.fn().mockResolvedValue({ messages: page(301, 350), has_more: true });
        rewire({ getMessages });
        setActiveChannel(1);
        load200();

        mock.dispatch("ready", readyPayload);
        mock.dispatch("ready", readyPayload);
        await settle();

        expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(301, 350));
      });

      it("refetches a detached window around the reader's top visible message", async () => {
        const getMessages = vi.fn();
        const getMessagesAround = vi.fn().mockResolvedValue({
          messages: page(110, 150)
            .reverse()
            .map((m) => (m.id === 130 ? { ...m, content: "edited while down" } : m)),
          has_more_before: true,
          has_more_after: true,
        });
        rewire({ getMessages, getMessagesAround });
        const unregister = registerReadingAnchor((channelId) => (channelId === 1 ? 130 : null));
        try {
          setActiveChannel(1);
          setAroundMessages(1, page(100, 160).reverse(), true, true);

          mock.dispatch("ready", readyPayload);
          mock.dispatch("ready", readyPayload);
          await settle();

          expect(getMessages).not.toHaveBeenCalled();
          expect(getMessagesAround).toHaveBeenCalledWith(1, 130, { limit: 50 });
          const msgs = getChannelMessages(1);
          expect(msgs.map((m) => m.id)).toEqual(ids(100, 160));
          expect(msgs.find((m) => m.id === 130)!.content).toBe("edited while down");
          expect(isWindowDetached(1)).toBe(true);
          expect(isChannelLoaded(1)).toBe(true);
        } finally {
          unregister();
        }
      });

      it("detaches the kept rows when the refetch fails, so no live row lands across the gap", async () => {
        const getMessages = vi.fn().mockRejectedValue(new Error("503"));
        rewire({ getMessages });
        setActiveChannel(1);
        load200();

        mock.dispatch("ready", readyPayload);
        mock.dispatch("ready", readyPayload);
        await settle();

        expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(1, 200));
        expect(isWindowDetached(1)).toBe(true);
        mock.dispatch("chat_message", {
          ...storedMessage(261),
          user: { id: 2, username: "bob", avatar: null },
        });
        expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(1, 200));
        expectConsole("warn", /\[dispatcher\] Failed to reload message history after resync/);
      });

      it("keeps the reader's anchor when a splice overflows the row cap", async () => {
        const getMessages = vi.fn().mockResolvedValue({ messages: page(481, 530), has_more: true });
        rewire({ getMessages });
        const unregister = registerReadingAnchor((channelId) => (channelId === 1 ? 10 : null));
        try {
          setActiveChannel(1);
          setMessages(1, page(451, 500), true);
          for (let top = 450; top > 0; top -= 50) prependMessages(1, page(top - 49, top), top > 50);
          expect(isWindowDetached(1)).toBe(false);

          mock.dispatch("ready", readyPayload);
          mock.dispatch("ready", readyPayload);
          await settle();

          expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(1, 500));
          expect(isWindowDetached(1)).toBe(true);
          expect(isChannelLoaded(1)).toBe(true);
        } finally {
          unregister();
        }
      });

      it("trims the oldest rows when a splice overflows below the reader's anchor", async () => {
        const getMessages = vi.fn().mockResolvedValue({ messages: page(481, 530), has_more: true });
        rewire({ getMessages });
        const unregister = registerReadingAnchor((channelId) => (channelId === 1 ? 490 : null));
        try {
          setActiveChannel(1);
          setMessages(1, page(451, 500), true);
          for (let top = 450; top > 0; top -= 50) prependMessages(1, page(top - 49, top), top > 50);

          mock.dispatch("ready", readyPayload);
          mock.dispatch("ready", readyPayload);
          await settle();

          expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(31, 530));
          expect(isWindowDetached(1)).toBe(false);
        } finally {
          unregister();
        }
      });

      it("falls back to the tail for a detached window no list is showing", async () => {
        const getMessages = vi.fn().mockResolvedValue({ messages: page(451, 500), has_more: true });
        const getMessagesAround = vi.fn();
        rewire({ getMessages, getMessagesAround });
        setActiveChannel(1);
        setAroundMessages(1, page(100, 160).reverse(), true, true);

        mock.dispatch("ready", readyPayload);
        mock.dispatch("ready", readyPayload);
        await settle();

        expect(getMessagesAround).not.toHaveBeenCalled();
        expect(getChannelMessages(1).map((m) => m.id)).toEqual(ids(451, 500));
        expect(isWindowDetached(1)).toBe(false);
      });
    });
  });

  it("on ready publishes the client's identity key when the server copy is stale", async () => {
    mockEnsurePublished.mockClear();
    const updateProfile = vi.fn().mockResolvedValue({});
    const getConfig = vi.fn(() => ({
      host: "chat.example",
      token: "[redacted]" as string | undefined,
    }));
    rewire({ updateProfile, getConfig });

    // We are user 7, "alex"; the server holds no identity key for us yet.
    patchAuth({ user: { id: 7, username: "alex", avatar: null, role: "member" } });

    mock.dispatch(
      "ready",
      readyEvent({
        members: [readyMember({ id: 7, username: "alex", identity_public_key: null })],
      }),
    );

    await Promise.resolve();
    expect(mockEnsurePublished).toHaveBeenCalledWith(
      "chat.example",
      "alex",
      null,
      expect.any(Function),
    );
    // The publish closure must route through api.updateProfile (server requires
    // the username, injected by the orchestrator's caller).
    const closure = mockEnsurePublished.mock.calls[0]![3] as (d: {
      identity_public_key: string;
    }) => Promise<unknown>;
    await closure({ identity_public_key: "k" });
    expect(updateProfile).toHaveBeenCalledWith({ identity_public_key: "k" });
  });

  it("on ready publishes the signed-in user's own key, not the first member's", async () => {
    mockEnsurePublished.mockClear();
    const updateProfile = vi.fn().mockResolvedValue({});
    const getConfig = vi.fn(() => ({
      host: "chat.example",
      token: "[redacted]",
    }));
    rewire({ updateProfile, getConfig });

    patchAuth({ user: { id: 7, username: "alex", avatar: null, role: "member" } });

    mock.dispatch(
      "ready",
      readyEvent({
        members: [
          readyMember({ id: 3, username: "zoe", identity_public_key: "zoe-key" }),
          readyMember({ id: 7, username: "alex", identity_public_key: "alex-key" }),
        ],
      }),
    );

    await Promise.resolve();
    // Both the username and the "key the server already holds" must be ours:
    // picking another member would PATCH our profile under their username,
    // and a foreign current-key makes the idempotence check compare against
    // the wrong value (re-publishing, or worse, skipping a needed publish).
    expect(mockEnsurePublished).toHaveBeenCalledWith(
      "chat.example",
      "alex",
      "alex-key",
      expect.any(Function),
    );
  });

  it("on ready publishes no identity key when nobody is signed in", async () => {
    mockEnsurePublished.mockClear();
    const updateProfile = vi.fn().mockResolvedValue({});
    const getConfig = vi.fn(() => ({
      host: "chat.example",
      token: "[redacted]",
    }));
    rewire({ updateProfile, getConfig });

    // No authStore.user, so currentUserId falls back to the 0 sentinel — a
    // member row carrying that id must not be mistaken for "us" and have a
    // long-term identity key published against it.
    patchAuth({ user: null });

    mock.dispatch(
      "ready",
      readyEvent({
        members: [readyMember({ id: 0, username: "nobody" })],
      }),
    );

    await Promise.resolve();
    expect(mockEnsurePublished).not.toHaveBeenCalled();
  });
});
