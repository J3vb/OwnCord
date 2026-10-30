import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { setActivityRefusalHandler } from "../../../src/lib/presence/gameActivityBridge";
import { expectConsole } from "../../helpers/console";
import { membersStore } from "../../../src/stores/members.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { dmStore } from "../../../src/stores/dm.store";
import {
  resetServerCapabilities,
  serverSupportsGameActivity,
  serverSupportsListeningActivity,
} from "../../../src/lib/net/serverCapabilities";
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

  it("wires presence to members store", () => {
    // Add a member first
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(1, { id: 1, username: "alex", avatar: null, role: "admin", status: "online" as const });
      return { ...prev, members: m };
    });

    mock.dispatch("presence", { user_id: 1, status: "idle" });
    expect(membersStore.getState().members.get(1)?.status).toBe("idle");
  });

  it("carries a custom status on presence, and leaves it alone when omitted", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(1, { id: 1, username: "alex", avatar: null, role: "admin", status: "online" as const });
      return { ...prev, members: m };
    });

    mock.dispatch("presence", { user_id: 1, status: "idle", custom_status: "afk" });
    expect(membersStore.getState().members.get(1)?.customStatus).toBe("afk");

    // A bare status flip (what the auto-idle timer sends) must not blank it.
    mock.dispatch("presence", { user_id: 1, status: "online" });
    expect(membersStore.getState().members.get(1)?.customStatus).toBe("afk");

    // An explicit null clears it.
    mock.dispatch("presence", { user_id: 1, status: "online", custom_status: null });
    expect(membersStore.getState().members.get(1)?.customStatus).toBeNull();
  });

  describe("presence_batch", () => {
    const seed = (): void => {
      membersStore.setState((prev) => {
        const m = new Map(prev.members);
        m.set(1, {
          id: 1,
          username: "alex",
          avatar: null,
          role: "admin",
          status: "offline" as const,
        });
        m.set(2, {
          id: 2,
          username: "bea",
          avatar: null,
          role: "member",
          status: "online" as const,
          customStatus: "coding",
        });
        m.set(3, { id: 3, username: "cy", avatar: null, role: "member", status: "idle" as const });
        return { ...prev, members: m };
      });
    };

    it("applies every entry of a window batch, custom status included", () => {
      seed();
      mock.dispatch("presence_batch", {
        updates: [
          { user_id: 1, status: "online", custom_status: "back" },
          { user_id: 2, status: "dnd", custom_status: null },
          { user_id: 999, status: "online", custom_status: null },
        ],
      });
      const members = membersStore.getState().members;
      expect(members.get(1)?.status).toBe("online");
      expect(members.get(1)?.customStatus).toBe("back");
      expect(members.get(2)?.status).toBe("dnd");
      expect(members.get(2)?.customStatus).toBeNull();
      expect(members.get(3)?.status).toBe("idle");
      // An entry for someone the list lacks, with no member data, is ignored.
      expect(members.has(999)).toBe(false);
    });

    it("applies a full snapshot: anyone it leaves out is offline, listed text is replaced", () => {
      seed();
      mock.dispatch("presence_batch", {
        full: true,
        updates: [
          { user_id: 1, status: "online", custom_status: null },
          { user_id: 2, status: "online", custom_status: "lunch" },
        ],
      });
      const members = membersStore.getState().members;
      expect(members.get(1)?.status).toBe("online");
      expect(members.get(2)?.status).toBe("online");
      expect(members.get(2)?.customStatus).toBe("lunch");
      expect(members.get(3)?.status).toBe("offline");
      expect(members.get(3)?.customStatus).toBeNull();
    });
  });

  describe("game activity", () => {
    const factorio = { name: "Factorio", started_at: 1_761_206_400_000 };
    const seed = (): void => {
      membersStore.setState((prev) => {
        const m = new Map(prev.members);
        for (const [id, username] of [
          [1, "alex"],
          [2, "bea"],
          [3, "cy"],
        ] as const) {
          m.set(id, { id, username, avatar: null, role: "member", status: "online" as const });
        }
        return { ...prev, members: m };
      });
    };
    const activityOf = (id: number) => membersStore.getState().members.get(id)?.activity;

    it("applies a presence frame's game and clears it on null", () => {
      seed();
      mock.dispatch("presence", { user_id: 1, status: "online", activity: factorio });
      expect(activityOf(1)).toEqual({ name: "Factorio", startedAt: 1_761_206_400_000 });
      mock.dispatch("presence", { user_id: 1, status: "online", activity: null });
      expect(activityOf(1)).toBeNull();
    });

    it("leaves the shown game alone when a presence frame carries no activity key", () => {
      seed();
      mock.dispatch("presence", { user_id: 1, status: "online", activity: factorio });
      mock.dispatch("presence", { user_id: 1, status: "idle" });
      expect(activityOf(1)?.name).toBe("Factorio");
    });

    it("applies a window batch's games", () => {
      seed();
      mock.dispatch("presence_batch", {
        updates: [
          { user_id: 1, status: "online", custom_status: null, activity: factorio },
          { user_id: 2, status: "online", custom_status: null, activity: null },
        ],
      });
      expect(activityOf(1)?.name).toBe("Factorio");
      expect(activityOf(2)).toBeNull();
      expect(activityOf(3)).toBeUndefined();
    });

    it("a full snapshot replaces listed games and clears anyone it leaves out", () => {
      seed();
      mock.dispatch("presence", { user_id: 3, status: "online", activity: factorio });
      mock.dispatch("presence", { user_id: 2, status: "online", activity: factorio });
      mock.dispatch("presence_batch", {
        full: true,
        updates: [
          {
            user_id: 1,
            status: "online",
            custom_status: null,
            activity: { name: "Satisfactory", started_at: 1_761_206_500_000 },
          },
          { user_id: 2, status: "online", custom_status: null, activity: null },
        ],
      });
      expect(activityOf(1)?.name).toBe("Satisfactory");
      expect(activityOf(2)).toBeNull();
      // Offline now, so playing nothing.
      expect(activityOf(3)).toBeNull();
    });

    it("applies ready.activities to the roster and clears everyone else", () => {
      mock.dispatch("ready", {
        channels: [],
        members: [
          { id: 1, username: "alex", avatar: null, role: "admin", status: "online" },
          { id: 2, username: "bea", avatar: null, role: "member", status: "online" },
        ],
        activities: [{ user_id: 2, ...factorio }],
        voice_states: [],
        roles: [],
      });
      expect(activityOf(1)).toBeNull();
      expect(activityOf(2)).toEqual({ name: "Factorio", startedAt: 1_761_206_400_000 });

      // The next full ready restates the set: bea stopped playing meanwhile.
      mock.dispatch("ready", {
        channels: [],
        members: [
          { id: 1, username: "alex", avatar: null, role: "admin", status: "online" },
          { id: 2, username: "bea", avatar: null, role: "member", status: "online" },
        ],
        activities: [],
        voice_states: [],
        roles: [],
      });
      expect(activityOf(2)).toBeNull();
    });

    it("a ready from a server without the key shows no games", () => {
      seed();
      mock.dispatch("presence", { user_id: 1, status: "online", activity: factorio });
      mock.dispatch("ready", {
        channels: [],
        members: [{ id: 1, username: "alex", avatar: null, role: "admin", status: "online" }],
        voice_states: [],
        roles: [],
      });
      expect(activityOf(1)).toBeNull();
    });

    it("copies a DM partner's game into the DM list from presence, batch and ready", () => {
      const partner = { id: 10, username: "bob", avatar: "", status: "online" };
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: partner,
            participants: [partner],
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
      const shown = () => dmStore.getState().channels[0]?.recipient.activity;

      mock.dispatch("presence", { user_id: 10, status: "online", activity: factorio });
      expect(shown()?.name).toBe("Factorio");
      // A frame without the key keeps it.
      mock.dispatch("presence", { user_id: 10, status: "idle" });
      expect(shown()?.name).toBe("Factorio");
      mock.dispatch("presence_batch", {
        updates: [{ user_id: 10, status: "online", custom_status: null, activity: null }],
      });
      expect(shown()).toBeNull();
      mock.dispatch("presence", { user_id: 10, status: "online", activity: factorio });
      mock.dispatch("presence_batch", { full: true, updates: [] });
      expect(shown()).toBeNull();
      mock.dispatch("ready", {
        channels: [],
        members: [],
        dm_channels: [
          {
            channel_id: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            last_message_id: null,
            last_message: "",
            last_message_at: "",
            unread_count: 0,
            mention_count: 0,
          },
        ],
        activities: [{ user_id: 10, ...factorio }],
        voice_states: [],
        roles: [],
      });
      expect(shown()?.name).toBe("Factorio");
    });

    it("a DM opened after ready shows the game its partner is already playing", () => {
      dmStore.setState(() => ({ channels: [] }));
      mock.dispatch("ready", {
        channels: [],
        members: [{ id: 10, username: "bob", avatar: null, role: "member", status: "online" }],
        activities: [{ user_id: 10, ...factorio }],
        voice_states: [],
        roles: [],
      });
      mock.dispatch("dm_channel_open", {
        channel_id: 51,
        recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        last_message_id: null,
        last_message: "",
        last_message_at: "",
        unread_count: 0,
      });
      expect(dmStore.getState().channels[0]?.recipient.activity?.name).toBe("Factorio");
    });

    describe("the per-server switch", () => {
      const user = { id: 1, username: "alex", avatar: null, role: "admin" };
      const partner = { id: 10, username: "bob", avatar: "", status: "online" };
      afterEach(() => resetServerCapabilities());

      it("game_activity_policy false clears every shown game and turns the capability off", () => {
        seed();
        mock.dispatch("ready", {
          channels: [],
          members: [{ id: 1, username: "alex", avatar: null, role: "admin", status: "online" }],
          capabilities: { game_activity: true },
          activities: [{ user_id: 1, ...factorio }],
          voice_states: [],
          roles: [],
        });
        dmStore.setState(() => ({
          channels: [
            {
              channelId: 50,
              recipient: partner,
              participants: [partner],
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
        mock.dispatch("presence", { user_id: 10, status: "online", activity: factorio });
        expect(activityOf(1)?.name).toBe("Factorio");
        expect(serverSupportsGameActivity()).toBe(true);

        mock.dispatch("game_activity_policy", { enabled: false });
        expect(activityOf(1)).toBeNull();
        expect(dmStore.getState().channels[0]?.recipient.activity).toBeNull();
        expect(serverSupportsGameActivity()).toBe(false);

        // On again: the capability returns, the games come back with presence.
        mock.dispatch("game_activity_policy", { enabled: true });
        expect(serverSupportsGameActivity()).toBe(true);
        expect(activityOf(1)).toBeNull();
      });

      it("auth_ok's game_activity_policy applies on a full connect and on a resume", () => {
        seed();
        mock.dispatch("ready", {
          channels: [],
          members: [{ id: 1, username: "alex", avatar: null, role: "admin", status: "online" }],
          capabilities: { game_activity: true },
          activities: [{ user_id: 1, ...factorio }],
          voice_states: [],
          roles: [],
        });
        // A resume gets no ready: the policy a missed frame carried arrives here.
        mock.dispatch("auth_ok", {
          user,
          server_name: "S",
          motd: "",
          replay_source: "buffer",
          game_activity_policy: { enabled: false },
        });
        expect(serverSupportsGameActivity()).toBe(false);
        expect(activityOf(1)).toBeNull();

        mock.dispatch("auth_ok", {
          user,
          server_name: "S",
          motd: "",
          replay_source: "none",
          game_activity_policy: { enabled: true },
        });
        expect(serverSupportsGameActivity()).toBe(true);
      });

      it("ignores a game on a presence frame or batch that outran the off frame", () => {
        seed();
        mock.dispatch("ready", {
          channels: [],
          members: [{ id: 1, username: "alex", avatar: null, role: "admin", status: "online" }],
          capabilities: { game_activity: true },
          voice_states: [],
          roles: [],
        });
        mock.dispatch("game_activity_policy", { enabled: false });
        mock.dispatch("presence", { user_id: 1, status: "online", activity: factorio });
        expect(activityOf(1) ?? null).toBeNull();
        mock.dispatch("presence_batch", {
          updates: [{ user_id: 1, status: "online", custom_status: null, activity: factorio }],
        });
        expect(activityOf(1) ?? null).toBeNull();

        // On again: games show.
        mock.dispatch("game_activity_policy", { enabled: true });
        mock.dispatch("presence", { user_id: 1, status: "online", activity: factorio });
        expect(activityOf(1)?.name).toBe("Factorio");
      });

      it("still shows games from a ready and presence before any policy is stated", () => {
        mock.dispatch("ready", {
          channels: [],
          members: [{ id: 1, username: "alex", avatar: null, role: "admin", status: "online" }],
          capabilities: { game_activity: true },
          activities: [{ user_id: 1, ...factorio }],
          voice_states: [],
          roles: [],
        });
        expect(activityOf(1)?.name).toBe("Factorio");
      });

      it("a GAME_ACTIVITY_DISABLED refusal never overrides the policy the server stated", () => {
        seed();
        mock.dispatch("ready", {
          channels: [],
          members: [{ id: 1, username: "alex", avatar: null, role: "admin", status: "online" }],
          capabilities: { game_activity: true },
          activities: [{ user_id: 1, ...factorio }],
          voice_states: [],
          roles: [],
        });
        // auth_ok said on; a refusal sent before a later on frame arrives after it.
        mock.dispatch("auth_ok", {
          user,
          server_name: "S",
          motd: "",
          replay_source: "none",
          game_activity_policy: { enabled: true },
        });
        expect(serverSupportsGameActivity()).toBe(true);

        // The running loop claims its own refused frame (no toast).
        setActivityRefusalHandler(() => true);
        onTestFinished(() => setActivityRefusalHandler(null));
        mock.dispatch("error", { code: "GAME_ACTIVITY_DISABLED", message: "off" }, "act-1");
        expectConsole("error", /\[dispatcher\] Server error/);
        expect(serverSupportsGameActivity()).toBe(true);
        expect(activityOf(1)?.name).toBe("Factorio");
      });

      it("an auth_ok without the key (an older server) leaves the capability to ready", () => {
        mock.dispatch("auth_ok", { user, server_name: "S", motd: "", replay_source: "none" });
        mock.dispatch("ready", {
          channels: [],
          members: [],
          capabilities: { game_activity: true },
          voice_states: [],
          roles: [],
        });
        expect(serverSupportsGameActivity()).toBe(true);
      });
    });
  });

  describe("listening activity", () => {
    const song = {
      title: "Blue in Green",
      artist: "Miles Davis",
      player: "Spotify",
      started_at: 1_761_206_400_000,
      duration_ms: 337_000,
    };
    const shownSong = {
      title: "Blue in Green",
      artist: "Miles Davis",
      player: "Spotify",
      startedAt: 1_761_206_400_000,
      durationMs: 337_000,
    };
    const seed = (): void => {
      membersStore.setState((prev) => {
        const m = new Map(prev.members);
        for (const [id, username] of [
          [1, "alex"],
          [2, "bea"],
          [3, "cy"],
        ] as const) {
          m.set(id, { id, username, avatar: null, role: "member", status: "online" as const });
        }
        return { ...prev, members: m };
      });
    };
    const listeningOf = (id: number) => membersStore.getState().members.get(id)?.listening;
    const partner = { id: 10, username: "bob", avatar: "", status: "online" };
    const seedDm = (): void => {
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: partner,
            participants: [partner],
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
    };
    afterEach(() => resetServerCapabilities());

    it("applies a presence frame's song and clears it on null", () => {
      seed();
      mock.dispatch("presence", { user_id: 1, status: "online", listening: song });
      expect(listeningOf(1)).toEqual(shownSong);
      mock.dispatch("presence", { user_id: 1, status: "online", listening: null });
      expect(listeningOf(1)).toBeNull();
    });

    it("leaves the shown song alone when a presence frame carries no listening key", () => {
      seed();
      mock.dispatch("presence", { user_id: 1, status: "online", listening: song });
      mock.dispatch("presence", { user_id: 1, status: "idle" });
      expect(listeningOf(1)?.title).toBe("Blue in Green");
    });

    it("keeps the game and the song apart", () => {
      seed();
      mock.dispatch("presence", {
        user_id: 1,
        status: "online",
        activity: { name: "Factorio", started_at: 1 },
        listening: song,
      });
      mock.dispatch("presence", {
        user_id: 1,
        status: "online",
        activity: null,
        listening: song,
      });
      const member = membersStore.getState().members.get(1);
      expect(member?.activity).toBeNull();
      expect(member?.listening?.player).toBe("Spotify");
    });

    it("applies a presence_batch and lets a full snapshot clear the members it leaves out", () => {
      seed();
      mock.dispatch("presence_batch", {
        updates: [
          { user_id: 1, status: "online", custom_status: null, listening: song },
          { user_id: 2, status: "online", custom_status: null, listening: null },
        ],
      });
      expect(listeningOf(1)?.title).toBe("Blue in Green");
      expect(listeningOf(2)).toBeNull();
      expect(listeningOf(3)).toBeUndefined();

      mock.dispatch("presence", { user_id: 3, status: "online", listening: song });
      mock.dispatch("presence_batch", {
        full: true,
        updates: [{ user_id: 1, status: "online", custom_status: null, listening: song }],
      });
      expect(listeningOf(1)?.title).toBe("Blue in Green");
      expect(listeningOf(3)).toBeNull();
    });

    it("applies ready.listening to the roster and clears everyone else", () => {
      const members = [
        { id: 1, username: "alex", avatar: null, role: "admin", status: "online" },
        { id: 2, username: "bea", avatar: null, role: "member", status: "online" },
      ];
      mock.dispatch("ready", {
        channels: [],
        members,
        listening: [{ user_id: 2, ...song }],
        voice_states: [],
        roles: [],
      });
      expect(listeningOf(1)).toBeNull();
      expect(listeningOf(2)).toEqual(shownSong);

      // The next full ready restates the set: bea stopped meanwhile.
      mock.dispatch("ready", {
        channels: [],
        members,
        listening: [],
        voice_states: [],
        roles: [],
      });
      expect(listeningOf(2)).toBeNull();
    });

    it("keeps an unknown length as 0 and drops a blank title or player", () => {
      seed();
      mock.dispatch("presence", {
        user_id: 1,
        status: "online",
        listening: { ...song, duration_ms: 0 },
      });
      expect(listeningOf(1)?.durationMs).toBe(0);
      mock.dispatch("presence", {
        user_id: 1,
        status: "online",
        listening: { ...song, title: " " },
      });
      expect(listeningOf(1)).toBeNull();
      mock.dispatch("presence", { user_id: 1, status: "online", listening: song });
      mock.dispatch("presence", {
        user_id: 1,
        status: "online",
        listening: { ...song, player: "" },
      });
      expect(listeningOf(1)).toBeNull();
    });

    it("copies a DM partner's song into the DM list from presence, batch and ready", () => {
      seedDm();
      const shown = () => dmStore.getState().channels[0]?.recipient.listening;

      mock.dispatch("presence", { user_id: 10, status: "online", listening: song });
      expect(shown()?.title).toBe("Blue in Green");
      mock.dispatch("presence", { user_id: 10, status: "idle" });
      expect(shown()?.title).toBe("Blue in Green");
      mock.dispatch("presence_batch", {
        updates: [{ user_id: 10, status: "online", custom_status: null, listening: null }],
      });
      expect(shown()).toBeNull();
      mock.dispatch("presence", { user_id: 10, status: "online", listening: song });
      mock.dispatch("presence_batch", { full: true, updates: [] });
      expect(shown()).toBeNull();
      mock.dispatch("ready", {
        channels: [],
        members: [],
        dm_channels: [
          {
            channel_id: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            last_message_id: null,
            last_message: "",
            last_message_at: "",
            unread_count: 0,
            mention_count: 0,
          },
        ],
        listening: [{ user_id: 10, ...song }],
        voice_states: [],
        roles: [],
      });
      expect(shown()?.title).toBe("Blue in Green");
    });

    it("a DM opened after ready shows the song its partner is already playing", () => {
      dmStore.setState(() => ({ channels: [] }));
      mock.dispatch("ready", {
        channels: [],
        members: [{ id: 10, username: "bob", avatar: null, role: "member", status: "online" }],
        listening: [{ user_id: 10, ...song }],
        voice_states: [],
        roles: [],
      });
      mock.dispatch("dm_channel_open", {
        channel_id: 51,
        recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        last_message_id: null,
        last_message: "",
        last_message_at: "",
        unread_count: 0,
      });
      expect(dmStore.getState().channels[0]?.recipient.listening?.player).toBe("Spotify");
    });

    it("the per-server switch off clears every shown song and ignores a late one", () => {
      seed();
      mock.dispatch("ready", {
        channels: [],
        members: [{ id: 1, username: "alex", avatar: null, role: "admin", status: "online" }],
        capabilities: { game_activity: true, listening_activity: true },
        listening: [{ user_id: 1, ...song }],
        voice_states: [],
        roles: [],
      });
      seedDm();
      mock.dispatch("presence", { user_id: 10, status: "online", listening: song });
      expect(listeningOf(1)?.title).toBe("Blue in Green");
      expect(serverSupportsListeningActivity()).toBe(true);

      mock.dispatch("game_activity_policy", { enabled: false });
      expect(listeningOf(1)).toBeNull();
      expect(dmStore.getState().channels[0]?.recipient.listening).toBeNull();
      expect(serverSupportsListeningActivity()).toBe(false);

      // A frame that outran the off frame shows nothing.
      mock.dispatch("presence", { user_id: 1, status: "online", listening: song });
      expect(listeningOf(1) ?? null).toBeNull();
      mock.dispatch("presence_batch", {
        updates: [{ user_id: 1, status: "online", custom_status: null, listening: song }],
      });
      expect(listeningOf(1) ?? null).toBeNull();

      mock.dispatch("game_activity_policy", { enabled: true });
      mock.dispatch("presence", { user_id: 1, status: "online", listening: song });
      expect(listeningOf(1)?.title).toBe("Blue in Green");
      expect(serverSupportsListeningActivity()).toBe(true);
    });

    it("an older server (no listening_activity flag) never supports music, even with a policy", () => {
      mock.dispatch("ready", {
        channels: [],
        members: [],
        capabilities: { game_activity: true },
        voice_states: [],
        roles: [],
      });
      mock.dispatch("game_activity_policy", { enabled: true });
      expect(serverSupportsListeningActivity()).toBe(false);
    });
  });

  it("wires user_update display_name into the member store", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(1, { id: 1, username: "alex", avatar: null, role: "admin", status: "online" as const });
      return { ...prev, members: m };
    });

    mock.dispatch("user_update", {
      user_id: 1,
      username: "alex",
      avatar: "/api/v1/files/abc",
      display_name: "Alex A.",
      about: "hi",
    });
    const member = membersStore.getState().members.get(1);
    expect(member?.displayName).toBe("Alex A.");
    expect(member?.avatar).toBe("/api/v1/files/abc");
  });

  // OC-0009: voiceStore.voiceUsers keeps its own frozen copy of each
  // participant's username, written only by setVoiceStates (ready) and
  // updateVoiceState (voice_state). USER_UPDATE fans a profile change out to
  // membersStore and dmStore, which hold the same kind of frozen copy, but
  // not to voiceStore — so a rename leaves the voice roster showing the old
  // username for the rest of the call.
  it("updates the voice roster username on user_update", () => {
    voiceStore.setState((prev) => {
      const userMap = new Map([
        [
          10,
          {
            userId: 10,
            username: "bob",
            muted: false,
            deafened: false,
            speaking: false,
            camera: false,
            screenshare: false,
          },
        ],
      ]);
      const voiceUsers = new Map(prev.voiceUsers);
      voiceUsers.set(5, userMap);
      return { ...prev, voiceUsers };
    });

    mock.dispatch("user_update", {
      user_id: 10,
      username: "bobby",
      avatar: "new.png",
      display_name: null,
    });

    const voiceUser = voiceStore.getState().voiceUsers.get(5)?.get(10);
    expect(voiceUser?.username).toBe("bobby");
  });

  describe("presence and user_update sync dmStore", () => {
    const dmChannel = {
      channelId: 50,
      recipient: { id: 10, username: "bob", avatar: "old.png", status: "online" as const },
      participants: [{ id: 10, username: "bob", avatar: "old.png", status: "online" as const }],
      name: "",
      isGroup: false,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    };

    beforeEach(() => {
      dmStore.setState(() => ({
        channels: [{ ...dmChannel, participants: [...dmChannel.participants] }],
      }));
    });

    it("updates the DM partner's status on presence, in recipient and participants", () => {
      mock.dispatch("presence", { user_id: 10, status: "dnd" });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.status).toBe("dnd");
      expect(dm?.participants[0]?.status).toBe("dnd");
    });

    it("updates the DM partner's status from a presence_batch", () => {
      mock.dispatch("presence_batch", {
        updates: [{ user_id: 10, status: "idle", custom_status: null }],
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.status).toBe("idle");
      expect(dm?.participants[0]?.status).toBe("idle");
    });

    it("marks a DM partner a full snapshot leaves out as offline", () => {
      mock.dispatch("presence_batch", {
        full: true,
        updates: [{ user_id: 1, status: "online", custom_status: null }],
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.status).toBe("offline");
      expect(dm?.participants[0]?.status).toBe("offline");
    });

    it("leaves an unrelated DM partner's status alone", () => {
      mock.dispatch("presence", { user_id: 999, status: "dnd" });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.status).toBe("online");
    });

    it("updates the DM partner's username/avatar/displayName on user_update", () => {
      mock.dispatch("user_update", {
        user_id: 10,
        username: "bobby",
        avatar: "new.png",
        display_name: "Bobby",
        about: "",
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.username).toBe("bobby");
      expect(dm?.recipient.avatar).toBe("new.png");
      expect(dm?.recipient.displayName).toBe("Bobby");
      expect(dm?.participants[0]?.username).toBe("bobby");
    });

    it("clears the DM partner's nickname when user_update reports it cleared", () => {
      dmStore.setState((prev) => ({
        channels: prev.channels.map((c) => ({
          ...c,
          recipient: { ...c.recipient, displayName: "Bobby" },
          participants: c.participants.map((p) => ({ ...p, displayName: "Bobby" })),
        })),
      }));

      mock.dispatch("user_update", {
        user_id: 10,
        username: "bob",
        avatar: "old.png",
        display_name: null,
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.displayName).toBe("");
    });

    // An older or partial server omits display_name entirely; that means
    // "unchanged", not "cleared" — membersStore already guards it this way.
    it("leaves the DM partner's nickname alone when user_update omits display_name", () => {
      dmStore.setState((prev) => ({
        channels: prev.channels.map((c) => ({
          ...c,
          recipient: { ...c.recipient, displayName: "Bobby" },
          participants: c.participants.map((p) => ({ ...p, displayName: "Bobby" })),
        })),
      }));

      mock.dispatch("user_update", { user_id: 10, username: "bobby", avatar: "new.png" });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.username).toBe("bobby");
      expect(dm?.recipient.displayName).toBe("Bobby");
      expect(dm?.participants[0]?.displayName).toBe("Bobby");
    });
  });
});
