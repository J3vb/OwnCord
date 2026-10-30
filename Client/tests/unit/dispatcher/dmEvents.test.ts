import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { authStore } from "../../../src/stores/auth.store";
import { channelsStore } from "../../../src/stores/channels.store";
import { messagesStore } from "../../../src/stores/messages.store";
import { voiceStore, joinVoiceChannel, leaveVoiceChannel } from "../../../src/stores/voice.store";
import { dmStore } from "../../../src/stores/dm.store";
import { useDispatcherHarness, type DispatcherMock } from "../../helpers/dispatcherHarness";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

describe("WS Dispatcher", () => {
  let cleanup: () => void;
  let mock: DispatcherMock;

  useDispatcherHarness({
    wired: (m, c) => {
      mock = m;
      cleanup = c;
    },
    currentCleanup: () => cleanup,
  });

  describe("chat_message DM store updates", () => {
    const dmChannel = {
      channelId: 50,
      recipient: { id: 10, username: "bob", avatar: "", status: "online" as const },
      participants: [],
      name: "",
      isGroup: false,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    };

    beforeEach(() => {
      dmStore.setState(() => ({ channels: [{ ...dmChannel }] }));
    });

    it("updates DM last message with unread for non-active, non-own message", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 500,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "hey there",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dms = dmStore.getState().channels;
      const dm = dms.find((c) => c.channelId === 50);
      expect(dm?.lastMessage).toBe("hey there");
      expect(dm?.unreadCount).toBe(1);
    });

    it("updates DM preview (no unread) for own message", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 501,
        channel_id: 50,
        user: { id: 5, username: "me", avatar: null },
        content: "my DM reply",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dms = dmStore.getState().channels;
      const dm = dms.find((c) => c.channelId === 50);
      expect(dm?.lastMessage).toBe("my DM reply");
      expect(dm?.unreadCount).toBe(0);
    });

    it("updates DM preview (no unread) when DM channel is active", () => {
      // P4-03: an active DM only skips the badge while the window has focus.
      const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      onTestFinished(() => focus.mockRestore());
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 502,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "active DM msg",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dms = dmStore.getState().channels;
      const dm = dms.find((c) => c.channelId === 50);
      expect(dm?.lastMessage).toBe("active DM msg");
      expect(dm?.unreadCount).toBe(0);
    });

    // OC-0204's DM-path sibling: the same "active means watching the live
    // tail" assumption governs isDmActive here, and breaks the same way when
    // the active DM's loaded window is detached (a jump to an old permalink/
    // search hit inside the conversation).
    it("updates DM last message WITH unread when the active DM's window is detached", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));
      messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set([50]) }));

      mock.dispatch("chat_message", {
        id: 503,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "arrived while reading back-history",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dms = dmStore.getState().channels;
      const dm = dms.find((c) => c.channelId === 50);
      expect(dm?.lastMessage).toBe("arrived while reading back-history");
      expect(dm?.unreadCount).toBe(1);
    });

    it("increments the DM mention badge for an incoming @mention", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 504,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "hey @me",
        mentions: [5],
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      // The badge must fire live: dmStore's mentionCount is what DmSidebar
      // renders (mute-immune), and channelsStore's incrementMention no-ops
      // for DM ids. Without this, the badge appears only after a reconnect.
      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.mentionCount).toBe(1);
      expect(dm?.unreadCount).toBe(1);
    });

    it("does not badge a DM mention in the focused DM", () => {
      // P4-03: an active DM only skips the badge while the window has focus.
      const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      onTestFinished(() => focus.mockRestore());
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 505,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "hey @me",
        mentions: [5],
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.mentionCount).toBe(0);
    });

    // OC-0242: a DM message can land between the server's registerNow and
    // buildReady — `ready` already counts it (unreadCount/mentionCount both
    // bumped, lastMessageId advanced to its id), and the same message is then
    // redelivered as a queued chat_message once writePump drains. The unread
    // guard (lastMessageId monotonicity) already prevents the unread double
    // count; the mention badge must not double count either.
    it("does not double-count a DM mention whose id is already reflected in lastMessageId", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      // Simulate the `ready` snapshot that already counted this exact message.
      dmStore.setState((prev) => ({
        channels: prev.channels.map((c) =>
          c.channelId === 50 ? { ...c, lastMessageId: 504, unreadCount: 1, mentionCount: 1 } : c,
        ),
      }));

      // The same message redelivered as a queued chat_message.
      mock.dispatch("chat_message", {
        id: 504,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "hey @me",
        mentions: [5],
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.unreadCount).toBe(1);
      expect(dm?.mentionCount).toBe(1);
    });
  });

  // ── DM events ─────────────────────────────────────────

  describe("DM events", () => {
    it("should call addDmChannel on dm_channel_open", () => {
      mock.dispatch("dm_channel_open", {
        channel_id: 50,
        recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        last_message_id: null,
        last_message: "",
        last_message_at: "",
        unread_count: 0,
      });

      const channels = dmStore.getState().channels;
      expect(channels).toHaveLength(1);
      expect(channels[0]!.channelId).toBe(50);
      expect(channels[0]!.recipient.username).toBe("bob");
    });

    // A pre-group server sends only `recipient`, which for it IS the whole
    // membership — so the fallback has to be a one-element list, not an empty
    // one, or every group-aware call site breaks against an old server.
    it("treats a recipient-only payload as a one-person participant list", () => {
      mock.dispatch("dm_channel_open", {
        channel_id: 50,
        recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        last_message_id: null,
        last_message: "",
        last_message_at: "",
        unread_count: 0,
      });

      const dm = dmStore.getState().channels[0]!;
      expect(dm.participants).toHaveLength(1);
      expect(dm.participants[0]!.id).toBe(10);
      expect(dm.isGroup).toBe(false);
      expect(dm.name).toBe("");
    });

    it("maps a group dm_channel_open with its full participant list", () => {
      mock.dispatch("dm_channel_open", {
        channel_id: 51,
        recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        recipients: [
          { id: 10, username: "bob", avatar: "", status: "online", display_name: "Bobby" },
          { id: 11, username: "cat", avatar: "", status: "idle" },
        ],
        name: "Crew",
        is_group: true,
        last_message_id: null,
        last_message: "",
        last_message_at: "",
        unread_count: 0,
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 51)!;
      expect(dm.isGroup).toBe(true);
      expect(dm.name).toBe("Crew");
      expect(dm.participants.map((p) => p.id)).toEqual([10, 11]);
      expect(dm.participants[0]!.displayName).toBe("Bobby");
      // DmUser.displayName is non-nullable ("" = no nickname); a participant
      // the server sends without one must map to that, not to undefined —
      // every render path does `displayName || username`.
      expect(dm.participants[1]!.displayName).toBe("");
      // The compat recipient is the first of the list, so an older render path
      // still shows somebody rather than nothing.
      expect(dm.recipient.id).toBe(10);
    });

    it("should call removeDmChannel on dm_channel_close", () => {
      // Seed a DM channel first
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
            mentionCount: 0,
          },
        ],
      }));

      mock.dispatch("dm_channel_close", { channel_id: 50 });
      expect(dmStore.getState().channels).toHaveLength(0);
    });

    describe("call roster of a closed DM", () => {
      const dmRow = (channelId: number, isGroup: boolean) => ({
        channelId,
        recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        participants: [],
        name: "",
        isGroup,
        lastMessageId: null,
        lastMessage: "",
        lastMessageAt: "",
        unreadCount: 0,
        mentionCount: 0,
      });
      const seedCall = (channelId: number) => {
        mock.dispatch("voice_state", {
          channel_id: channelId,
          user_id: 10,
          username: "bob",
          muted: false,
          deafened: false,
          speaking: false,
          camera: false,
          screenshare: false,
        });
        voiceStore.flush();
      };

      it("drops the roster when a group DM is closed (left or removed)", () => {
        dmStore.setState(() => ({ channels: [dmRow(70, true)] }));
        seedCall(70);
        expect(voiceStore.getState().voiceUsers.get(70)?.size).toBe(1);

        mock.dispatch("dm_channel_close", { channel_id: 70 });
        voiceStore.flush();

        expect(voiceStore.getState().voiceUsers.has(70)).toBe(false);
      });

      it("keeps the roster when a 1:1 DM is closed", () => {
        dmStore.setState(() => ({ channels: [dmRow(71, false)] }));
        seedCall(71);

        mock.dispatch("dm_channel_close", { channel_id: 71 });
        voiceStore.flush();

        expect(voiceStore.getState().voiceUsers.get(71)?.size).toBe(1);
      });

      it("leaves the roster to voice_leave while the local user is in that call", () => {
        dmStore.setState(() => ({ channels: [dmRow(72, true)] }));
        seedCall(72);
        joinVoiceChannel(72);
        voiceStore.flush();

        mock.dispatch("dm_channel_close", { channel_id: 72 });
        voiceStore.flush();

        expect(voiceStore.getState().voiceUsers.get(72)?.size).toBe(1);
        leaveVoiceChannel();
        voiceStore.flush();
      });

      it("drops a roster left from an earlier membership when the group is re-added", () => {
        dmStore.setState(() => ({ channels: [dmRow(73, true)] }));
        seedCall(73);
        joinVoiceChannel(73);
        voiceStore.flush();
        mock.dispatch("dm_channel_close", { channel_id: 73 });
        leaveVoiceChannel();
        voiceStore.flush();
        expect(voiceStore.getState().voiceUsers.get(73)?.size).toBe(1);

        mock.dispatch("dm_channel_open", {
          channel_id: 73,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 10, username: "bob", avatar: "", status: "online" }],
          name: "",
          is_group: true,
          owner_id: 10,
          last_message_id: null,
          last_message: "",
          last_message_at: "",
          unread_count: 0,
        });
        voiceStore.flush();

        expect(voiceStore.getState().voiceUsers.has(73)).toBe(false);
      });
    });

    it("falls back to another open DM when the closed DM was active", () => {
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
            mentionCount: 0,
          },
          {
            channelId: 60,
            recipient: { id: 11, username: "carl", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
            mentionCount: 0,
          },
        ],
      }));
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(dmStore.getState().channels.map((c) => c.channelId)).toEqual([60]);
      expect(channelsStore.getState().activeChannelId).toBe(60);
    });

    // setActiveChannel only zeroes the channelsStore mirror row's counts; a
    // DM's badge lives in dmStore (SidebarDmSection reads dmStore.unreadCount,
    // not the channelsStore mirror). Every other "open this DM" path
    // (selectDmConversation, navigateToChannel, markChannelRead) pairs
    // activation with clearDmUnread for exactly this reason — the
    // dm_channel_close fallback must too, or the badge on the DM it just
    // activated survives forever (it's now "active", so new messages take the
    // isDmActive branch and never increment it back).
    it("clears the dmStore unread badge on the DM it falls back to activating", () => {
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
            mentionCount: 0,
          },
          {
            channelId: 60,
            recipient: { id: 11, username: "carl", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 3,
            mentionCount: 1,
          },
        ],
      }));
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(channelsStore.getState().activeChannelId).toBe(60);
      const dm = dmStore.getState().channels.find((c) => c.channelId === 60);
      expect(dm?.unreadCount).toBe(0);
      expect(dm?.mentionCount).toBe(0);
    });

    // The channelsStore mirror row for a DM is only ever synthesized by
    // addDmToChannelsStore (on open, via selectDmConversation) — a DM present
    // in dmStore from `ready` but never opened this session has none. Without
    // synthesizing it here, activating channel 60 lands on an id
    // ChannelController can't resolve and blanks the chat area permanently.
    it("synthesizes the channelsStore mirror row when falling back to a DM never opened this session", () => {
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
            mentionCount: 0,
          },
          {
            channelId: 60,
            recipient: { id: 11, username: "carl", avatar: "", status: "online" },
            participants: [{ id: 11, username: "carl", avatar: "", status: "online" }],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 2,
            mentionCount: 1,
          },
        ],
      }));
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));
      // Channel 60 has no channelsStore row yet — the bug this test locks.
      expect(channelsStore.getState().channels.has(60)).toBe(false);

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(channelsStore.getState().activeChannelId).toBe(60);
      const ch = channelsStore.getState().channels.get(60);
      // Without the fix, ch is undefined here — activation succeeded but the
      // row it needs to resolve a name/type from never got synthesized.
      expect(ch).toBeDefined();
      expect(ch?.type).toBe("dm");
      expect(ch?.name).toBe("carl");
      // setActiveChannel legitimately zeroes a badge on open (existing,
      // correct behavior) — this only confirms that ran against a row that
      // now actually exists, not that synthesis skipped the counts.
      expect(ch?.unreadCount).toBe(0);
    });

    it("falls back to the first text channel when the closed DM was active and no DMs remain", () => {
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
            mentionCount: 0,
          },
        ],
      }));
      channelsStore.setState((prev) => {
        const ch = new Map(prev.channels);
        ch.set(1, {
          id: 1,
          name: "general",
          type: "text" as const,
          category: null,
          position: 0,
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
        return { ...prev, channels: ch, activeChannelId: 50 };
      });

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(channelsStore.getState().activeChannelId).toBe(1);
    });

    it("falls back to an announcement channel when the closed DM was active, no DMs remain, and there is no text channel", () => {
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
            mentionCount: 0,
          },
        ],
      }));
      channelsStore.setState((prev) => {
        const ch = new Map(prev.channels);
        ch.set(30, {
          id: 30,
          name: "news",
          type: "announcement" as const,
          category: null,
          position: 0,
          unreadCount: 0,
          mentionCount: 0,
          lastMessageId: null,
          canSend: false,
          topic: "",
          slowMode: 0,
          nsfw: false,
          isPrivate: false,
          voiceMaxUsers: 0,
          voiceMaxVideo: 0,
        });
        return { ...prev, channels: ch, activeChannelId: 50 };
      });

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(channelsStore.getState().activeChannelId).toBe(30);
    });

    it("does not change the active channel when the closed DM was not active", () => {
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
            mentionCount: 0,
          },
        ],
      }));
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(channelsStore.getState().activeChannelId).toBe(1);
    });
  });
});
