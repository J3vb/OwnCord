import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { restoreTZ, tzPinHonored } from "../../helpers/tz-pin";
import { authStore } from "../../../src/stores/auth.store";
import { channelsStore } from "../../../src/stores/channels.store";
import { dmStore } from "../../../src/stores/dm.store";
import { setUserBlockedByMe } from "../../../src/stores/blocks.store";
import { notifyIncomingMessage as mockNotifyIncomingMessage } from "../../../src/lib/notifications";
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

  describe("chat_message notifications during a reconnect replay burst", () => {
    // The server writes auth_ok before the replay burst, so by the time
    // replayed chat_message frames arrive the client is already "connected"
    // — no connection-state flag can distinguish them. A second auth_ok in
    // this dispatcher's lifetime is always a reconnect handshake; its
    // timestamp is the gate instead.
    beforeEach(() => {
      vi.mocked(mockNotifyIncomingMessage).mockClear();
    });

    it("does not notify for a replay frame timestamped before the reconnect handshake", () => {
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });
      const handshakeAt = Date.now();
      // Second auth_ok in the same dispatcher lifetime = a reconnect.
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      mock.dispatch("chat_message", {
        id: 1,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "missed while offline",
        reply_to: null,
        attachments: [],
        timestamp: new Date(handshakeAt - 5000).toISOString(),
      });

      expect(mockNotifyIncomingMessage).not.toHaveBeenCalled();
    });

    it("still notifies for a genuinely live message after reconnecting", () => {
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });
      const handshakeAt = Date.now();
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      mock.dispatch("chat_message", {
        id: 2,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "live now",
        reply_to: null,
        attachments: [],
        timestamp: new Date(handshakeAt + 1000).toISOString(),
      });

      expect(mockNotifyIncomingMessage).toHaveBeenCalledTimes(1);
      expect(mockNotifyIncomingMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: "live now" }),
      );
    });

    it("does not gate messages on the session's very first connect (no prior handshake)", () => {
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      // Old timestamp, but there was no earlier auth_ok — not a reconnect.
      mock.dispatch("chat_message", {
        id: 3,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "first connect",
        reply_to: null,
        attachments: [],
        timestamp: "2020-01-01T00:00:00Z",
      });

      expect(mockNotifyIncomingMessage).toHaveBeenCalledTimes(1);
    });

    // BUG: the anchor (lastReconnectHandshakeAt) is stamped from the CLIENT's
    // Date.now(), but payload.timestamp is the SERVER's created_at — a raw
    // comparison mixes clock domains. A self-hosted server routinely runs
    // without NTP; if its clock lags the client's, every genuinely live
    // message for the drift window after every reconnect looks like it
    // predates the handshake and gets silently treated as a replay (no
    // notification, no taskbar flash) — and with persistent skew this never
    // recovers.
    it("does not misclassify a live post-reconnect message as a replay when the server clock lags (observed skew)", () => {
      const driftMs = 30_000; // server clock reads 30s behind the client's
      const t0 = Date.now();

      // First connect. A live message here establishes the observed skew
      // before any reconnect exists to misclassify.
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });
      mock.dispatch("chat_message", {
        id: 1,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "before reconnect",
        reply_to: null,
        attachments: [],
        timestamp: new Date(t0 - driftMs).toISOString(),
      });
      vi.mocked(mockNotifyIncomingMessage).mockClear();

      // Reconnect 1s later (client clock).
      vi.setSystemTime(t0 + 1000);
      const handshakeAt = Date.now();
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      // A genuinely live message arrives 1s after the handshake (client
      // clock). Its server timestamp — still 30s behind — reads 29s
      // *before* the handshake in the client's own clock, which a
      // client-clock-only comparison misclassifies as a replay.
      vi.setSystemTime(handshakeAt + 1000);
      mock.dispatch("chat_message", {
        id: 2,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "live after reconnect, server clock still lagging",
        reply_to: null,
        attachments: [],
        timestamp: new Date(Date.now() - driftMs).toISOString(),
      });

      expect(mockNotifyIncomingMessage).toHaveBeenCalledTimes(1);
      expect(mockNotifyIncomingMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: "live after reconnect, server clock still lagging" }),
      );
    });

    // OC-0024: serverClockSkewMs starts at 0 and is only ever sampled inside
    // the "accepted as live" branch it itself gates — so if the channel is
    // quiet between login and the first reconnect, nothing ever seeds it. A
    // few seconds later a genuinely live message shows up with a lagging
    // server timestamp and gets misclassified as a replay forever (the
    // classification that misfires is the same one that would have fixed
    // it). This must not depend on the reconnect having happened recently —
    // a real fix bounds exposure by wall-clock distance from the handshake,
    // not by ever successfully sampling the skew on this connection.
    it("does not permanently blackhole live messages after a reconnect when the skew was never sampled (cold start)", () => {
      const driftMs = 30 * 60 * 1000; // server clock reads 30 minutes behind
      const t0 = Date.now();

      // First connect — the channel is quiet, so no chat_message arrives and
      // serverClockSkewMs is never sampled.
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      // Wi-Fi blips a few seconds later; ws.ts reconnects.
      vi.setSystemTime(t0 + 5000);
      const handshakeAt = Date.now();
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      // A genuinely live message arrives well after the reconnect burst
      // would have finished — its server timestamp is 30 minutes behind
      // because the self-hosted server has no NTP.
      vi.setSystemTime(handshakeAt + 10_000);
      mock.dispatch("chat_message", {
        id: 1,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "live well after reconnect, skew was never sampled",
        reply_to: null,
        attachments: [],
        timestamp: new Date(Date.now() - driftMs).toISOString(),
      });

      expect(mockNotifyIncomingMessage).toHaveBeenCalledTimes(1);
      expect(mockNotifyIncomingMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: "live well after reconnect, skew was never sampled" }),
      );
    });
  });

  // OC-0315: payload.timestamp is the raw SQLite datetime('now') string —
  // naive UTC, no 'Z' suffix (the server never emits one). Date.parse (used
  // by the replay-gate comparison, unlike the parseTimestamp helper built
  // for exactly this) interprets that as LOCAL time. On a viewer whose zone
  // is east of UTC, the parsed epoch reads *earlier* than the true instant,
  // so a genuinely live message can look like it predates the reconnect
  // handshake and gets silently swallowed by the replay gate — worst when
  // serverClockSkewMs is still 0 (nothing has been sampled yet this
  // session), since nothing else offsets the bias. Pin a real east-of-UTC
  // zone to observe it. The probe throws rather than skipping if the pin is
  // not honored, so this block cannot quietly stop running (helpers/tz-pin.ts).
  const oc0315PinHonored = tzPinHonored(
    "Asia/Tokyo",
    () => new Date(2026, 0, 15).getTimezoneOffset() === -540,
  );

  describe.skipIf(!oc0315PinHonored)(
    "naive-UTC server timestamps vs a non-UTC viewer clock",
    () => {
      const originalTZ = process.env.TZ;

      beforeEach(() => {
        process.env.TZ = "Asia/Tokyo";
        vi.mocked(mockNotifyIncomingMessage).mockClear();
      });

      // restoreTZ, not a bare delete: deleting TZ leaves Date pinned to Tokyo
      // for the rest of this forked worker's life, and vitest reuses a worker
      // across test files. See helpers/tz-pin.ts.
      afterEach(() => {
        restoreTZ(originalTZ);
      });

      it("does not misclassify a live message as a replay when serverClockSkewMs is still 0 (cold, never sampled)", () => {
        // Sanity: really pinned east of UTC (Tokyo has no DST, so this is
        // stable year-round, unlike the America/New_York probe elsewhere).
        expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-540);

        mock.dispatch("auth_ok", {
          user: { id: 1, username: "alex", avatar: null, role: "admin" },
          server_name: "TestServer",
          motd: "",
        });
        const handshakeAt = Date.now();
        // Second auth_ok in the same dispatcher lifetime = a reconnect.
        mock.dispatch("auth_ok", {
          user: { id: 1, username: "alex", avatar: null, role: "admin" },
          server_name: "TestServer",
          motd: "",
        });

        // A genuinely live message, 1s after the handshake, stamped by the
        // server in its real wire form: naive UTC, no 'Z'.
        vi.setSystemTime(handshakeAt + 1000);
        const naiveUtcTimestamp = new Date(Date.now())
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d{3}Z$/, "");
        mock.dispatch("chat_message", {
          id: 1,
          channel_id: 1,
          user: { id: 2, username: "bob", avatar: null },
          content: "live now, naive-UTC timestamp",
          reply_to: null,
          attachments: [],
          timestamp: naiveUtcTimestamp,
        });

        expect(mockNotifyIncomingMessage).toHaveBeenCalledTimes(1);
      });
    },
  );

  describe("mention counts", () => {
    function seedChannel(): void {
      channelsStore.setState((prev) => {
        const ch = new Map(prev.channels);
        ch.set(5, {
          id: 5,
          name: "off-topic",
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
        return { ...prev, channels: ch, activeChannelId: 1 };
      });
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "alex", avatar: null, role: "member" },
      }));
    }

    function incoming(extra: Record<string, unknown>): void {
      mock.dispatch("chat_message", {
        id: 200,
        channel_id: 5,
        user: { id: 2, username: "bob", avatar: null },
        content: "ping",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
        ...extra,
      });
    }

    it("increments when the message names the current user", () => {
      seedChannel();
      incoming({ content: "ping @alex", mentions: [1] });
      const ch = channelsStore.getState().channels.get(5);
      expect(ch?.mentionCount).toBe(1);
      expect(ch?.unreadCount).toBe(1);
    });

    it("increments for an honoured @everyone", () => {
      seedChannel();
      incoming({ content: "@everyone", mentions_everyone: true });
      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(1);
    });

    it("does not increment for someone else's mention", () => {
      seedChannel();
      incoming({ content: "ping @bob", mentions: [2] });
      const ch = channelsStore.getState().channels.get(5);
      expect(ch?.mentionCount).toBe(0);
      expect(ch?.unreadCount).toBe(1);
    });

    it("does not increment for an @everyone the sender could not send", () => {
      seedChannel();
      incoming({ content: "@everyone", mentions_everyone: false });
      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(0);
    });

    // OC-0271: the server's applyMentionCounts (mentions.go) narrows an
    // @here fan-out to readers who were online at send time — a reader with
    // no live connection never gets their mention_count bumped for a
    // here-only mention. mentions_everyone alone cannot tell the client
    // which case it is (the wire collapses @here into the same bit as
    // @everyone), so this needs mentions_here too. The reconnect tier that
    // replays this burst never sends a follow-up `ready` to correct a wrong
    // badge, so the client must not raise one in the first place for a
    // here-only mention delivered inside that burst.
    it("does not raise the mention badge for an @here-only mention replayed after a reconnect", () => {
      seedChannel();
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "member" },
        server_name: "TestServer",
        motd: "",
      });
      const handshakeAt = Date.now();
      // Second auth_ok in this dispatcher's lifetime = a reconnect.
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "member" },
        server_name: "TestServer",
        motd: "",
      });

      incoming({
        content: "@here standup",
        mentions_everyone: true,
        mentions_here: true,
        timestamp: new Date(handshakeAt - 1000).toISOString(),
      });

      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(0);
    });

    describe("from a blocked author", () => {
      beforeEach(() => {
        setUserBlockedByMe(2, true);
        onTestFinished(() => setUserBlockedByMe(2, false));
      });

      it("a direct mention in a channel you are away from raises unread, not a mention", () => {
        seedChannel();
        incoming({ content: "ping @alex", mentions: [1] });
        const ch = channelsStore.getState().channels.get(5);
        expect(ch?.mentionCount).toBe(0);
        expect(ch?.unreadCount).toBe(1);
      });

      it("an @everyone raises unread, not a mention", () => {
        seedChannel();
        incoming({ content: "@everyone", mentions_everyone: true });
        const ch = channelsStore.getState().channels.get(5);
        expect(ch?.mentionCount).toBe(0);
        expect(ch?.unreadCount).toBe(1);
      });

      it("a direct mention in a DM raises the DM's unread count, not its mention count", () => {
        seedChannel();
        dmStore.setState(() => ({
          channels: [
            {
              channelId: 50,
              recipient: { id: 2, username: "bob", avatar: "", status: "online" as const },
              participants: [],
              name: "",
              isGroup: true,
              lastMessageId: null,
              lastMessage: "",
              lastMessageAt: "",
              unreadCount: 0,
              mentionCount: 0,
            },
          ],
        }));
        incoming({ channel_id: 50, content: "ping @alex", mentions: [1] });
        const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
        expect(dm?.mentionCount).toBe(0);
        expect(dm?.unreadCount).toBe(1);
      });

      it("unblocking restores the badge", () => {
        seedChannel();
        setUserBlockedByMe(2, false);
        incoming({ content: "ping @alex", mentions: [1] });
        expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(1);
      });
    });

    it("still raises the mention badge for a live (non-replayed) @here mention", () => {
      seedChannel();
      incoming({ content: "@here standup", mentions_everyone: true, mentions_here: true });
      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(1);
    });

    it("still raises the mention badge inside a replay burst for a direct mention alongside @here", () => {
      seedChannel();
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "member" },
        server_name: "TestServer",
        motd: "",
      });
      const handshakeAt = Date.now();
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "member" },
        server_name: "TestServer",
        motd: "",
      });

      incoming({
        content: "@here @alex standup",
        mentions: [1],
        mentions_everyone: true,
        mentions_here: true,
        timestamp: new Date(handshakeAt - 1000).toISOString(),
      });

      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(1);
    });

    // DP-27: a mention in a channel the user is NOT viewing never reaches this
    // client as a chat_message (the server sends it to the channel topic only),
    // so the server pushes the new total per user as mention_count. This is the
    // taskbar/tray badge's live path.
    it("repaints a non-viewed channel's badge from the server's mention_count frame", () => {
      seedChannel();
      expect(channelsStore.getState().activeChannelId).toBe(1);

      mock.dispatch("mention_count", { channel_id: 5, count: 3 });

      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(3);
    });

    it("ignores a mention_count frame for the channel on screen", () => {
      // P4-03: the frame carries an absolute total, not a delta, so applying
      // it to the active channel would reintroduce mentions already seen while
      // it was focused. Its own chat_message handles the badge either way.
      const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      onTestFinished(() => focus.mockRestore());
      seedChannel();
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 5 }));

      mock.dispatch("mention_count", { channel_id: 5, count: 3 });

      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(0);
    });

    it("ignores a mention_count frame for the active channel while the window is unfocused", () => {
      const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
      onTestFinished(() => focus.mockRestore());
      seedChannel();
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 5 }));

      mock.dispatch("mention_count", { channel_id: 5, count: 3 });

      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(0);
    });
  });
});
