import { describe, it, expect, vi } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { wireDispatcher } from "../../../src/lib/dispatcher";
import { expectConsole } from "../../helpers/console";
import { authStore } from "../../../src/stores/auth.store";
import { channelsStore, setRoles, getRoleIdByName } from "../../../src/stores/channels.store";
import { messagesStore } from "../../../src/stores/messages.store";
import { membersStore } from "../../../src/stores/members.store";
import { blocksStore, setUserBlockedByMe } from "../../../src/stores/blocks.store";
import { uiStore, setUpdateRequiredHost } from "../../../src/stores/ui.store";
import { PROTOCOL_EPOCH } from "../../../src/lib/protocolTypes";
import { useDispatcherHarness, type DispatcherMock } from "../../helpers/dispatcherHarness";
import { resetAuthState } from "../../helpers/storeSeeds";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

const { mockShowToast } = dispatcherMocks;

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

  it("wires auth_ok to auth store", () => {
    mock.dispatch("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "TestServer",
      motd: "Welcome!",
    });

    const state = authStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user?.username).toBe("alex");
    expect(state.serverName).toBe("TestServer");
  });

  it("stores auth_ok's upload_policy, and null from an older server that omits it", () => {
    const user = { id: 1, username: "alex", avatar: null, role: "admin" };
    const upload_policy = { max_upload_bytes: 10485760 };
    mock.dispatch("auth_ok", { user, server_name: "S", motd: "", upload_policy });
    expect(authStore.getState().uploadPolicy).toEqual(upload_policy);

    mock.dispatch("auth_ok", { user, server_name: "S", motd: "" });
    expect(authStore.getState().uploadPolicy).toBeNull();
  });

  it("re-sends channel_focus for the active channel on auth_ok", () => {
    // The resume path can land with no ChannelTopic subscription (server
    // restart / proxy close observed before the client's reconnect) — a
    // channel already active on the client must be re-focused so the
    // channel message stream doesn't silently die.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 42 }));

    mock.dispatch("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "TestServer",
      motd: "Welcome!",
    });

    expect(mock.ws.send).toHaveBeenCalledWith({
      type: "channel_focus",
      payload: { channel_id: 42 },
    });
  });

  it("sends no channel_focus on auth_ok when no channel is active", () => {
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: null }));

    mock.dispatch("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "TestServer",
      motd: "Welcome!",
    });

    expect(mock.ws.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "channel_focus" }),
    );
  });

  it("wires auth_error to a full sign-out and the login-screen banner", () => {
    // Start from an authenticated session — asserting "not authenticated"
    // against the beforeEach's already-signed-out store would pass even if
    // the handler did nothing at all.
    mock.dispatch("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "TestServer",
      motd: "",
    });
    expect(authStore.getState().isAuthenticated).toBe(true);

    setUpdateRequiredHost(null);
    mock.dispatch("auth_error", { message: "Invalid token" });

    expectConsole("error", /\[dispatcher\] Auth failed/);

    const state = authStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    // The refusal reason is only ever surfaced through ui.store — ConnectPage's
    // banner is its single reader.
    expect(uiStore.getState().transientError).toBe("Invalid token");
  });

  it("marks the server host as needing a client update when auth_error refuses this client's epoch as too old", () => {
    cleanup();
    setUpdateRequiredHost(null);
    const getConfig = vi.fn(() => ({ host: "chat.example:8443", token: "t" }));
    cleanup = wireDispatcher(mock.ws, { listBlocks: vi.fn().mockResolvedValue([]), getConfig });

    mock.dispatch("auth_error", {
      message: "update the client",
      code: "protocol_epoch_unsupported",
      client_epoch: PROTOCOL_EPOCH,
      server_epoch: PROTOCOL_EPOCH + 1,
      min_epoch: PROTOCOL_EPOCH + 1,
    });

    expectConsole("error", /\[dispatcher\] Auth failed/);

    expect(uiStore.getState().updateRequiredHost).toEqual({
      host: "chat.example:8443",
      serverEpoch: PROTOCOL_EPOCH + 1,
      clientEpoch: PROTOCOL_EPOCH,
    });
    expect(uiStore.getState().transientError).toBe("update the client");
    expect(authStore.getState().isAuthenticated).toBe(false);
    // The token is still valid — main.ts keeps the stored credential on this
    // reason so the update relaunches straight into auto-login (Codex P2).
    expect(authStore.getState().logoutReason).toBe("protocol_epoch");
  });

  it("marks the host with the server-older epochs when the SERVER is the older side, but not on an ordinary auth_error", () => {
    cleanup();
    setUpdateRequiredHost(null);
    const getConfig = vi.fn(() => ({ host: "chat.example:8443", token: "t" }));
    cleanup = wireDispatcher(mock.ws, { listBlocks: vi.fn().mockResolvedValue([]), getConfig });

    mock.dispatch("auth_error", {
      message: "update the server",
      code: "protocol_epoch_unsupported",
      client_epoch: PROTOCOL_EPOCH,
      server_epoch: PROTOCOL_EPOCH - 1,
      min_epoch: PROTOCOL_EPOCH - 1,
    });
    expectConsole("error", /\[dispatcher\] Auth failed .*update the server/);
    expect(uiStore.getState().updateRequiredHost).toEqual({
      host: "chat.example:8443",
      serverEpoch: PROTOCOL_EPOCH - 1,
      clientEpoch: PROTOCOL_EPOCH,
    });

    // Server older than the client: still a protocol refusal, still a valid
    // token — the credential must survive this one too.
    expect(authStore.getState().logoutReason).toBe("protocol_epoch");

    setUpdateRequiredHost(null);
    mock.dispatch("auth_error", { message: "Invalid token" });
    expectConsole("error", /\[dispatcher\] Auth failed .*Invalid token/);
    expect(uiStore.getState().updateRequiredHost).toBeNull();
    expect(authStore.getState().logoutReason).toBe("user");
  });

  it("wires typing to members store", () => {
    mock.dispatch("typing", { channel_id: 1, user_id: 42, username: "bob" });
    const typing = membersStore.getState().typingUsers.get(1);
    expect(typing?.has(42)).toBe(true);
  });

  it("wires channel_create to channels store", () => {
    mock.dispatch("channel_create", {
      id: 10,
      name: "new-channel",
      type: "text",
      category: "General",
      position: 5,
    });

    expect(channelsStore.getState().channels.has(10)).toBe(true);
  });

  it("wires channel_delete to channels store", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "doomed",
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
      return { ...prev, channels: ch };
    });

    mock.dispatch("channel_delete", { id: 10 });
    expect(channelsStore.getState().channels.has(10)).toBe(false);
  });

  it("wires nsfw_ack to the channel's consent state", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(11, {
        id: 11,
        name: "spicy",
        type: "text" as const,
        category: null,
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: true,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
      return { ...prev, channels: ch };
    });

    mock.dispatch("nsfw_ack", { channel_id: 11, acknowledged: true });
    expect(channelsStore.getState().channels.get(11)?.nsfwAcknowledged).toBe(true);
    mock.dispatch("nsfw_ack", { channel_id: 11, acknowledged: false });
    expect(channelsStore.getState().channels.get(11)?.nsfwAcknowledged).toBe(false);
  });

  it("wires member_join to members store, using the payload's status", () => {
    mock.dispatch("member_join", {
      user: { id: 99, username: "newuser", avatar: null, role: "member" },
      status: "online",
    });
    expect(membersStore.getState().members.get(99)).toMatchObject({ status: "online" });
  });

  it("renders an invisible member_join as offline, not online", () => {
    // The server broadcasts an invisible connector's join as "offline" (the
    // viewer-safe collapse) — the client must render exactly that, not
    // assume a join always means online.
    mock.dispatch("member_join", {
      user: { id: 100, username: "ghost", avatar: null, role: "member" },
      status: "offline",
    });
    expect(membersStore.getState().members.get(100)).toMatchObject({ status: "offline" });
  });

  it("defaults a member_join with no status field to offline, not online", () => {
    // An older server that has not shipped the status field yet must fail
    // safe — omission must never be read as "online".
    mock.dispatch("member_join", {
      user: { id: 101, username: "legacy-server-user", avatar: null, role: "member" },
    });
    expect(membersStore.getState().members.get(101)).toMatchObject({ status: "offline" });
  });

  it("wires member_ban to remove member from members store", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(77, {
        id: 77,
        username: "banned-user",
        avatar: null,
        role: "member",
        status: "online" as const,
      });
      return { ...prev, members: m };
    });

    mock.dispatch("member_ban", { user_id: 77 });
    expect(membersStore.getState().members.has(77)).toBe(false);
  });

  it("wires channel_update to channels store", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "old-name",
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
      return { ...prev, channels: ch };
    });

    mock.dispatch("channel_update", {
      id: 10,
      name: "new-name",
      type: "text",
      category: "General",
      position: 3,
    });

    const ch = channelsStore.getState().channels.get(10);
    expect(ch?.name).toBe("new-name");
  });

  it("wires channel_categories to the channels store, replacing the list wholesale", () => {
    mock.dispatch("channel_categories", {
      categories: [
        { id: 7, name: "Later", position: 1 },
        { id: 3, name: "Sooner", position: 0 },
      ],
    });
    // Kept in the server's (position, id) order.
    expect(channelsStore.getState().categories.map((c) => c.id)).toEqual([3, 7]);

    mock.dispatch("channel_categories", { categories: [{ id: 7, name: "Later", position: 0 }] });
    expect(channelsStore.getState().categories).toEqual([{ id: 7, name: "Later", position: 0 }]);
  });

  it("carries the category fields of channel_update into the channel", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map(prev.channels).set(31, {
        id: 31,
        name: "moved",
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
      }),
    }));
    mock.dispatch("channel_update", {
      id: 31,
      category: "Games",
      category_id: 6,
      category_position: 2,
    });
    expect(channelsStore.getState().channels.get(31)).toMatchObject({
      category: "Games",
      categoryId: 6,
      categoryPosition: 2,
    });
  });

  it("wires channel_delete and redirects to first text channel when active is deleted", () => {
    mockShowToast.mockClear();
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "active-ch",
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
      ch.set(20, {
        id: 20,
        name: "fallback",
        type: "text" as const,
        category: null,
        position: 1,
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
      return { ...prev, channels: ch, activeChannelId: 10 };
    });

    mock.dispatch("channel_delete", { id: 10 });

    expect(channelsStore.getState().channels.has(10)).toBe(false);
    expect(channelsStore.getState().activeChannelId).toBe(20);
    // The redirect must say why it happened (ux/channels-members-dms §1.2).
    expect(mockShowToast).toHaveBeenCalledWith(
      "You no longer have access to this channel, or it was deleted",
      "info",
    );
  });

  it("wires channel_delete without a toast when a non-active channel is deleted", () => {
    mockShowToast.mockClear();
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "active-ch",
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
      ch.set(20, {
        id: 20,
        name: "background",
        type: "text" as const,
        category: null,
        position: 1,
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
      return { ...prev, channels: ch, activeChannelId: 10 };
    });

    mock.dispatch("channel_delete", { id: 20 });

    expect(channelsStore.getState().channels.has(20)).toBe(false);
    expect(channelsStore.getState().activeChannelId).toBe(10);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("wires channel_delete sets active to null when no text channels remain", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "only-ch",
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
      return { ...prev, channels: ch, activeChannelId: 10 };
    });

    mock.dispatch("channel_delete", { id: 10 });

    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("wires channel_delete and redirects to an announcement channel when no text channels remain", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "active-ch",
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
      ch.set(30, {
        id: 30,
        name: "news",
        type: "announcement" as const,
        category: null,
        position: 1,
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
      return { ...prev, channels: ch, activeChannelId: 10 };
    });

    mock.dispatch("channel_delete", { id: 10 });

    // The only remaining channel is an announcement channel — a readable,
    // full message channel — not a blank pane.
    expect(channelsStore.getState().activeChannelId).toBe(30);
  });

  it("wires member_update to update role", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(42, {
        id: 42,
        username: "alice",
        avatar: null,
        role: "member",
        status: "online" as const,
      });
      return { ...prev, members: m };
    });

    mock.dispatch("member_update", { user_id: 42, role: "admin" });
    expect(membersStore.getState().members.get(42)?.role).toBe("admin");
  });

  it("syncs authStore.user.role when the member_update is about the signed-in user", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 42, username: "alice", avatar: null, role: "member" },
    }));
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(42, {
        id: 42,
        username: "alice",
        avatar: null,
        role: "member",
        status: "online" as const,
      });
      return { ...prev, members: m };
    });

    mock.dispatch("member_update", { user_id: 42, role: "admin" });

    expect(membersStore.getState().members.get(42)?.role).toBe("admin");
    expect(authStore.getState().user?.role).toBe("admin");
  });

  it("tracks role_ids for the signed-in user and drops them when the echo has none", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 42, username: "alice", avatar: null, role: "member", role_ids: [3] },
    }));
    mock.dispatch("member_update", { user_id: 42, role: "vip", role_ids: [6, 3] });
    expect(authStore.getState().user?.role_ids).toEqual([6, 3]);
    mock.dispatch("member_update", { user_id: 42, role: "vip" });
    expect(authStore.getState().user?.role_ids).toBeUndefined();
  });

  it("leaves authStore.user.role untouched for a member_update about someone else", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));

    mock.dispatch("member_update", { user_id: 42, role: "admin" });

    expect(authStore.getState().user?.role).toBe("member");
  });

  it("wires roles_update to replace the role list", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      roles: [
        { id: 1, name: "Owner", color: "#E74C3C", permissions: 0x40000000, position: 100 },
        { id: 9, name: "Contractor", color: "#123456", permissions: 0x3, position: 30 },
      ],
    }));

    // A role was deleted and another recolored server-side. Replacing rather
    // than merging is the point: the deleted role must not survive.
    mock.dispatch("roles_update", {
      roles: [
        { id: 1, name: "Owner", color: "#FF0000", permissions: 0x40000000, position: 100 },
        { id: 4, name: "Member", color: null, permissions: 0x3, position: 40, is_default: true },
      ],
    });

    const roles = channelsStore.getState().roles;
    expect(roles.map((r) => r.id)).toEqual([1, 4]);
    expect(roles[0]?.color).toBe("#FF0000");
    expect(roles.some((r) => r.name === "Contractor")).toBe(false);
  });

  it("makes a role created by roles_update immediately assignable", () => {
    // The Change Role menu resolves a role by name, so a role created in the
    // admin panel has to be resolvable from the broadcast alone — without this
    // assigning a freshly created role needed a reconnect.
    setRoles([{ id: 4, name: "Member", color: null, permissions: 0x3, position: 40 }]);
    expect(getRoleIdByName("contractor")).toBeUndefined();

    mock.dispatch("roles_update", {
      roles: [
        { id: 4, name: "Member", color: null, permissions: 0x3, position: 40, is_default: true },
        { id: 9, name: "Contractor", color: "#123456", permissions: 0x3, position: 30 },
      ],
    });

    expect(getRoleIdByName("contractor")).toBe(9);
  });

  it("treats a roles_update with no roles field as an empty list", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      roles: [{ id: 1, name: "Owner", color: null, permissions: 0 }],
    }));

    mock.dispatch("roles_update", {} as { roles: [] });

    expect(channelsStore.getState().roles).toEqual([]);
  });

  it("wires upload_policy to replace the file-type lists and keep the rest of the policy", () => {
    authStore.setState((prev) => ({
      ...prev,
      uploadPolicy: {
        max_upload_bytes: 10 << 20,
        blocked_extensions: ["bat", "html"],
        allowed_extensions: ["png"],
        thumbnails: true,
      },
    }));

    mock.dispatch("upload_policy", { blocked_extensions: [], allowed_extensions: [] });

    expect(authStore.getState().uploadPolicy).toEqual({
      max_upload_bytes: 10 << 20,
      blocked_extensions: [],
      allowed_extensions: [],
      thumbnails: true,
    });
  });

  it("treats an upload_policy with missing lists as empty lists", () => {
    authStore.setState((prev) => ({
      ...prev,
      uploadPolicy: { max_upload_bytes: 10 << 20, blocked_extensions: ["bat"] },
    }));

    mock.dispatch("upload_policy", {} as { blocked_extensions: []; allowed_extensions: [] });

    expect(authStore.getState().uploadPolicy).toEqual({
      max_upload_bytes: 10 << 20,
      blocked_extensions: [],
      allowed_extensions: [],
    });
  });

  it("on ready clears being-blocked state and refreshes blocked-by-me via api", async () => {
    cleanup(); // tear down the no-api dispatcher wired in beforeEach
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [11, 22] });
    cleanup = wireDispatcher(mock.ws, { listBlocks });

    // Pre-seed a stale being-blocked entry that a fresh ready must clear.
    blocksStore.setState(() => ({ blockedByMe: new Set(), blockedByThem: new Set([5]) }));

    mock.dispatch("ready", { channels: [], members: [], voice_states: [], roles: [] });

    expect(blocksStore.getState().blockedByThem.size).toBe(0);
    expect(listBlocks).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect([...blocksStore.getState().blockedByMe]).toEqual([11, 22]);
  });

  // OC-0218: the ready-time GET /blocks and a user-initiated block/unblock
  // (memberPanel's onToggleBlock -> setUserBlockedByMe, after its
  // own await api.blockUser/unblockUser) can race. The GET is issued first
  // but its reply can land after the user's own fresher action — applying it
  // unconditionally reverts what the user just did.
  it("does not let a slow-to-resolve ready-time listBlocks revert a fresher local unblock", async () => {
    cleanup(); // tear down the no-api dispatcher wired in beforeEach
    let resolveListBlocks!: (v: { blocked_user_ids: number[] }) => void;
    const listBlocks = vi.fn(
      () =>
        new Promise<{ blocked_user_ids: number[] }>((resolve) => {
          resolveListBlocks = resolve;
        }),
    );
    cleanup = wireDispatcher(mock.ws, { listBlocks });

    // Local user 42 is blocked from a previous session.
    blocksStore.setState(() => ({ blockedByMe: new Set([42]), blockedByThem: new Set() }));

    // Reconnect: ready fires the GET, which does not resolve yet.
    mock.dispatch("ready", { channels: [], members: [], voice_states: [], roles: [] });
    expect(listBlocks).toHaveBeenCalled();

    // While it's in flight, the user clicks "Unblock" on 42 — the same
    // sequence memberPanel's onToggleBlock performs once its own
    // await api.unblockUser resolves.
    setUserBlockedByMe(42, false);
    expect([...blocksStore.getState().blockedByMe]).toEqual([]);

    // The GET finally resolves with the stale pre-unblock snapshot.
    resolveListBlocks({ blocked_user_ids: [42] });
    await Promise.resolve();
    await Promise.resolve();

    // The user's unblock must win — 42 must not be silently re-added.
    expect([...blocksStore.getState().blockedByMe]).toEqual([]);
  });

  it("auth_ok with null token uses empty string fallback", () => {
    resetAuthState();

    mock.dispatch("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "TestServer",
      motd: "Welcome!",
    });

    expect(authStore.getState().isAuthenticated).toBe(true);
  });

  it("ready with undefined roles uses empty array fallback", () => {
    mock.dispatch("ready", {
      channels: [],
      members: [],
      voice_states: [],
      // roles is intentionally undefined
    });

    // Should not crash, roles should be empty
    expect(channelsStore.getState().roles).toEqual([]);
  });

  it("unknown event type does not throw", () => {
    expect(() => {
      mock.dispatch("totally_unknown_server_event", { some: "data" });
    }).not.toThrow();
  });

  it("cleanup removes all listeners", () => {
    cleanup();

    // After cleanup, dispatching should not affect stores
    mock.dispatch("chat_message", {
      id: 999,
      channel_id: 1,
      user: { id: 1, username: "ghost", avatar: null },
      content: "should not appear",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T12:00:00Z",
    });

    expect(messagesStore.getState().messagesByChannel.get(1)).toBeUndefined();
  });
});
