/**
 * The read pointer through the dispatcher (WP 3D-5d): the capability from
 * `ready`, the `read_state` frame, a refused `mark_unread`, and the focus
 * frame's `read` flag. Server events reach the stores only here.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import * as dispatcherMocks from "../helpers/dispatcherMocks";
import * as voiceSession from "../helpers/voiceSessionMock";

import { wireDispatcher } from "../../src/lib/dispatcher";
import { createMockWsClient } from "../helpers/mock-ws";
import {
  channelsStore,
  getUnreadOnOpen,
  setActiveChannel,
  setChannels,
} from "../../src/stores/channels.store";
import { dmStore, addDmToChannelsStore, setDmChannels } from "../../src/stores/dm.store";
import {
  leaveChannel,
  noteMessageSeen,
  setLiveTailInView,
  setMarkReadSender,
} from "../../src/lib/readState";
import type { WsClient } from "../../src/lib/ws";
import {
  markMessageUnread,
  setMarkUnreadSender,
} from "../../src/components/message-list/markUnread";
import { viewChannel } from "../../src/lib/prefs/lastChannel";
import { readPointerEnabled } from "../../src/lib/net/serverCapabilities";
import type { ReadyChannel, ReadyPayload } from "../../src/lib/types";
import type { WsErrorCodeValue } from "../../src/lib/protocolTypes";
import { expectConsole } from "../helpers/console";
import { resetMessagesState } from "../helpers/storeResets";
import { resetChannelsState } from "../helpers/storeSeeds";
import { makeDmRow, pointerMessage, seedLoadedMessages } from "../helpers/readPointerFixtures";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    disableCamera: vi.fn(async () => {}),
    disableScreenshare: vi.fn(async () => {}),
  }),
);
// voice/wsHandlers loads screenShare lazily on an error frame that carries an
// id. afterEach waits for that import: one still pending when the file ends
// resolves after the mocks are gone and loads the real module into a torn-down
// environment.
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());

function ch(id: number, unread: number, mentions: number, pointer?: number): ReadyChannel {
  return {
    id,
    name: `chan-${id}`,
    type: "text",
    category: null,
    position: id,
    unread_count: unread,
    mention_count: mentions,
    ...(pointer !== undefined ? { last_read_message_id: pointer } : {}),
  };
}

function ready(
  channels: readonly ReadyChannel[],
  capabilities?: ReadyPayload["capabilities"],
): ReadyPayload {
  return {
    ...(capabilities !== undefined ? { capabilities } : {}),
    channels,
    members: [],
    voice_states: [],
    roles: [],
    dm_channels: [],
  };
}

const chan = (id: number) => channelsStore.getState().channels.get(id);

// A refused frame makes the voice handlers load screenShare lazily and
// fire-and-forget. If that load is still in flight when the file's environment
// is torn down, vitest throws an unhandled EnvironmentTeardownError even though
// every test passed. Loading it once up front makes the later import a cache hit.
beforeAll(async () => {
  await import("../../src/lib/voice/screenShare");
});

describe("read pointer through the dispatcher", () => {
  let mock: ReturnType<typeof createMockWsClient>;
  /** The mock as the dispatcher's WsClient (it lacks only the debug socket accessor). */
  const ws = (): WsClient => mock as unknown as WsClient;
  /** The server refuses the frame `id`; the dispatcher logs it. */
  function refuse(code: WsErrorCodeValue, message: string, id: string): void {
    mock.simulateMessage("error", { code, message }, id);
    expectConsole("error", /Server error/);
  }
  /** Authenticates, views channel 1 and returns the channel_focus frames both senders sent. */
  function focusFrames() {
    mock.simulateMessage("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "S",
      motd: "",
    });
    viewChannel(1, "text", ws());
    return mock.getSentMessages().filter((m) => m.type === "channel_focus");
  }
  /** Marks message 10 unread on a read-pointer channel, leaving the request pending. */
  function markUnreadPending(): void {
    mock.simulateMessage("ready", ready([ch(1, 0, 0, 10)], { read_pointer: true }));
    setActiveChannel(1);
    seedLoadedMessages(1, [
      pointerMessage(8),
      pointerMessage(9),
      pointerMessage(10),
      pointerMessage(11),
    ]);
    expect(markMessageUnread(1, 10)).toBe(9);
  }
  let cleanup: () => void;
  let hasFocus: ReturnType<typeof vi.spyOn>;
  let unreads: Array<[number, number]>;
  let reads: Array<[number, number | undefined]>;

  beforeEach(() => {
    dispatcherMocks.mockShowToast.mockClear();
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    resetChannelsState();
    dmStore.setState(() => ({ channels: [] }));
    resetMessagesState();
    setLiveTailInView(1, true);
    unreads = [];
    reads = [];
    setMarkReadSender((c, m) => reads.push([c, m]));
    setMarkUnreadSender((c, m) => {
      unreads.push([c, m]);
      return `req-${unreads.length}`;
    });
    mock = createMockWsClient();
    cleanup = wireDispatcher(ws());
  });

  afterEach(async () => {
    await vi.dynamicImportSettled();
    cleanup();
    setMarkReadSender(null);
    setMarkUnreadSender(null);
    hasFocus.mockRestore();
  });

  describe("ready capability", () => {
    it("is false until a ready, and true after one that says so", () => {
      expect(readPointerEnabled()).toBe(false);
      mock.simulateMessage("ready", ready([ch(1, 0, 0, 5)], { read_pointer: true }));
      expect(readPointerEnabled()).toBe(true);
    });

    it("is false when ready leaves the field out, even after a ready that had it", () => {
      mock.simulateMessage("ready", ready([ch(1, 0, 0)], { read_pointer: true }));
      mock.simulateMessage("ready", ready([ch(1, 0, 0)], {}));
      expect(readPointerEnabled()).toBe(false);
      mock.simulateMessage("ready", ready([ch(1, 0, 0)]));
      expect(readPointerEnabled()).toBe(false);
    });

    it("is reset when the session's dispatcher is torn down", () => {
      mock.simulateMessage("ready", ready([ch(1, 0, 0)], { read_pointer: true }));
      cleanup();
      expect(readPointerEnabled()).toBe(false);
      cleanup = wireDispatcher(ws());
    });

    it("stores the pointer each ready channel and DM carries", () => {
      mock.simulateMessage("ready", {
        ...ready([ch(1, 3, 0, 5)], { read_pointer: true }),
        dm_channels: [
          {
            channel_id: 50,
            recipient: { id: 7, username: "bob", avatar: "", status: "online" },
            last_message_id: 30,
            last_message: "",
            last_message_at: "",
            unread_count: 2,
            last_read_message_id: 10,
          },
        ],
      });
      expect(chan(1)?.lastReadMessageId).toBe(5);
      expect(dmStore.getState().channels[0]?.lastReadMessageId).toBe(10);
    });
  });

  describe("the focus frame's read flag", () => {
    it("is false at both senders with the capability", () => {
      mock.simulateMessage("ready", ready([ch(1, 0, 0)], { read_pointer: true }));
      channelsStore.setState((p) => ({ ...p, activeChannelId: 1 }));
      const focus = focusFrames();
      expect(focus.map((f) => f.payload)).toEqual([
        { channel_id: 1, read: false },
        { channel_id: 1, read: false },
      ]);
    });

    it("is absent without it", () => {
      mock.simulateMessage("ready", ready([ch(1, 0, 0)]));
      channelsStore.setState((p) => ({ ...p, activeChannelId: 1 }));
      const focus = focusFrames();
      expect(focus.map((f) => f.payload)).toEqual([{ channel_id: 1 }, { channel_id: 1 }]);
    });
  });

  describe("read_state", () => {
    it("is ignored before the first ready", () => {
      setChannels([ch(1, 3, 1, 5)]);
      mock.simulateMessage("read_state", {
        channel_id: 1,
        last_read_message_id: 20,
        unread_count: 0,
        mention_count: 0,
      });
      expect(chan(1)?.lastReadMessageId).toBe(5);
      expect(chan(1)?.unreadCount).toBe(3);
    });

    it("replaces a channel's pointer and both counts outright", () => {
      mock.simulateMessage(
        "ready",
        ready([ch(1, 0, 0, 5), ch(2, 9, 4, 5)], { read_pointer: true }),
      );
      mock.simulateMessage("read_state", {
        channel_id: 2,
        last_read_message_id: 8,
        unread_count: 23,
        mention_count: 1,
      });
      expect(chan(2)).toMatchObject({ lastReadMessageId: 8, unreadCount: 23, mentionCount: 1 });
      expect(chan(1)).toMatchObject({ lastReadMessageId: 5, unreadCount: 0 });
    });

    it("is ignored for a channel this client does not know", () => {
      mock.simulateMessage("ready", ready([ch(1, 0, 0, 5)], { read_pointer: true }));
      mock.simulateMessage("read_state", {
        channel_id: 99,
        last_read_message_id: 8,
        unread_count: 1,
        mention_count: 0,
      });
      expect(chan(99)).toBeUndefined();
      expect([...channelsStore.getState().channels.keys()]).toEqual([1]);
    });

    it("keeps the badge at 0 for the channel being read, but stores the pointer", () => {
      mock.simulateMessage("ready", ready([ch(1, 0, 0, 5)], { read_pointer: true }));
      setActiveChannel(1);
      mock.simulateMessage("read_state", {
        channel_id: 1,
        last_read_message_id: 9,
        unread_count: 4,
        mention_count: 2,
      });
      expect(chan(1)).toMatchObject({ lastReadMessageId: 9, unreadCount: 0, mentionCount: 0 });
    });

    it("applies the counts to the active channel when the reader is away", () => {
      mock.simulateMessage("ready", ready([ch(1, 0, 0, 5)], { read_pointer: true }));
      setActiveChannel(1);
      hasFocus.mockReturnValue(false);
      mock.simulateMessage("read_state", {
        channel_id: 1,
        last_read_message_id: 9,
        unread_count: 4,
        mention_count: 2,
      });
      expect(chan(1)).toMatchObject({ lastReadMessageId: 9, unreadCount: 4, mentionCount: 2 });
    });

    it("updates a DM in dmStore and in its channelsStore mirror", () => {
      mock.simulateMessage("ready", ready([ch(1, 0, 0, 5)], { read_pointer: true }));
      setDmChannels([makeDmRow()]);
      addDmToChannelsStore(makeDmRow());
      mock.simulateMessage("read_state", {
        channel_id: 50,
        last_read_message_id: 25,
        unread_count: 5,
        mention_count: 0,
      });
      expect(dmStore.getState().channels[0]).toMatchObject({
        lastReadMessageId: 25,
        unreadCount: 5,
        mentionCount: 0,
      });
      expect(chan(50)).toMatchObject({ lastReadMessageId: 25, unreadCount: 5, mentionCount: 0 });
    });

    it("updates a DM that was never opened (no mirror row)", () => {
      mock.simulateMessage("ready", ready([ch(1, 0, 0, 5)], { read_pointer: true }));
      setDmChannels([makeDmRow()]);
      mock.simulateMessage("read_state", {
        channel_id: 50,
        last_read_message_id: 25,
        unread_count: 0,
        mention_count: 0,
      });
      expect(dmStore.getState().channels[0]?.lastReadMessageId).toBe(25);
      expect(chan(50)).toBeUndefined();
    });
  });

  describe("a refused mark_unread", () => {
    function pending(): void {
      markUnreadPending();
      expect(chan(1)?.lastReadMessageId).toBe(9);
    }

    it("restores the pointer and says so on RATE_LIMITED", () => {
      pending();
      mock.simulateMessage(
        "error",
        { code: "RATE_LIMITED", message: "too many requests" },
        "req-1",
      );
      expectConsole("error", /Server error/);
      expect(chan(1)?.lastReadMessageId).toBe(10);
      expect(dispatcherMocks.mockShowToast).toHaveBeenCalledTimes(1);
      expect(dispatcherMocks.mockShowToast.mock.calls[0]?.[0]).toMatch(/Too many Mark Unread/);
    });

    it("restores the pointer and says so on NOT_FOUND", () => {
      pending();
      refuse("NOT_FOUND", "message not found", "req-1");
      expect(chan(1)?.lastReadMessageId).toBe(10);
      expect(dispatcherMocks.mockShowToast.mock.calls[0]?.[0]).toMatch(/Couldn't mark it unread/);
    });

    it("leaves the pointer alone for an error on some other frame", () => {
      pending();
      refuse("RATE_LIMITED", "slow", "other-frame");
      expect(chan(1)?.lastReadMessageId).toBe(9);
      expect(dispatcherMocks.mockShowToast.mock.calls.map((c) => String(c[0]))).not.toContain(
        expect.stringMatching(/Mark Unread/),
      );
    });

    it("ends the request on any other code too, with the general notice", () => {
      pending();
      refuse("FORBIDDEN", "access denied", "req-1");
      expect(chan(1)?.lastReadMessageId).toBe(10);
      expect(dispatcherMocks.mockShowToast.mock.calls[0]?.[0]).toMatch(/Couldn't mark it unread/);
    });

    it("does nothing against a new ready: its pointer wins and no restore or toast fires", () => {
      pending();
      mock.simulateMessage("ready", ready([ch(1, 3, 0, 7)], { read_pointer: true }));
      refuse("RATE_LIMITED", "slow", "req-1");
      expect(chan(1)?.lastReadMessageId).toBe(7);
      expect(
        dispatcherMocks.mockShowToast.mock.calls.map((c) => String(c[0])).join("|"),
      ).not.toMatch(/Mark Unread|mark it unread/);
    });

    it("does nothing after the connection dropped", () => {
      pending();
      mock.simulateStateChange("connected");
      mock.simulateStateChange("reconnecting");
      refuse("NOT_FOUND", "gone", "req-1");
      expect(chan(1)?.lastReadMessageId).toBe(9);
    });
  });

  describe("Mark Unread on the channel being read", () => {
    const pending = markUnreadPending;
    const answer = { channel_id: 1, last_read_message_id: 9, unread_count: 2, mention_count: 1 };

    it("keeps the counts the server answers with, so a badge is left when the reader leaves", () => {
      pending();
      mock.simulateMessage("read_state", answer);
      expect(chan(1)).toMatchObject({ lastReadMessageId: 9, unreadCount: 2, mentionCount: 1 });
      leaveChannel(1);
      expect(chan(1)).toMatchObject({ unreadCount: 2, mentionCount: 1 });
      // And the next visit draws the line from that count.
      setActiveChannel(null);
      setActiveChannel(1);
      expect(getUnreadOnOpen(1)).toBe(2);
    });

    it("drops an older read_state (a pointer at or above the message) while the answer is pending", () => {
      pending();
      mock.simulateMessage("read_state", { ...answer, last_read_message_id: 11, unread_count: 0 });
      expect(chan(1)?.lastReadMessageId).toBe(9);
      mock.simulateMessage("read_state", answer);
      expect(chan(1)).toMatchObject({ lastReadMessageId: 9, unreadCount: 2 });
      // Answered: a later frame is applied as usual.
      mock.simulateMessage("read_state", { ...answer, last_read_message_id: 11, unread_count: 0 });
      expect(chan(1)?.lastReadMessageId).toBe(11);
    });

    it("a message counted unread while the window is blurred lets a later arrival release the hold", () => {
      pending();
      hasFocus.mockReturnValue(false);
      mock.simulateMessage("chat_message", {
        id: 12,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "while away",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });
      hasFocus.mockReturnValue(true);
      noteMessageSeen(1, 13, true);
      leaveChannel(1);
      expect(reads).toEqual([[1, 13]]);
    });

    it("puts the pointer back and says so when the frame never left", () => {
      pending();
      mock.simulateSendFailure("req-1", "OFFLINE");
      expect(chan(1)?.lastReadMessageId).toBe(10);
      expect(dispatcherMocks.mockShowToast.mock.calls[0]?.[0]).toMatch(/Check your connection/);
    });

    it("ignores a send failure of some other frame", () => {
      pending();
      mock.simulateSendFailure("other", "NETWORK");
      expect(chan(1)?.lastReadMessageId).toBe(9);
      expect(dispatcherMocks.mockShowToast).not.toHaveBeenCalled();
    });
  });
});
