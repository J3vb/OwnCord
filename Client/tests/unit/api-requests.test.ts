// REST client: what each call puts on the wire (method, path, query, body,
// headers) and how failures map to typed errors and display copy.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

const { mockFetch, proxy, progressHandlers } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  progressHandlers: new Set<(e: { payload: unknown }) => void>(),
  proxy: {
    impl: (host: string): PromiseLike<string> => Promise.resolve(`https://${host}`),
  },
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_event: string, handler: (e: { payload: unknown }) => void) => {
    progressHandlers.add(handler);
    return Promise.resolve(() => progressHandlers.delete(handler));
  },
}));
vi.mock("../../src/lib/net/httpProxy", () => ({
  ensureHttpProxy: (host: string) => proxy.impl(host),
  stopHttpProxy: () => Promise.resolve(),
}));

import {
  ApiClientError,
  TransportError,
  createApiClient,
  errorText,
  httpError,
  serverErrorCopy,
  serverErrorText,
  type OnUnauthorized,
} from "../../src/lib/api";
import { connectText } from "../../src/i18n/connect";
import { messageStatusText } from "../../src/i18n/messageStatus";
import { expectConsole } from "../helpers/console";

type Api = ReturnType<typeof createApiClient>;

function okResponse(data: unknown = {}, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

function failResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: false,
    status,
    statusText: "Status Text",
    json: () => Promise.resolve(body),
    headers: new Headers(headers),
  } as unknown as Response;
}

const BASE = "https://host.test:8443/api/v1";

describe("REST client requests", () => {
  let api: Api;
  let onUnauthorized: Mock<OnUnauthorized>;

  const callUrl = (n = 0): string => mockFetch.mock.calls[n]?.[0] as string;
  const callInit = (n = 0): RequestInit => mockFetch.mock.calls[n]?.[1] as RequestInit;
  const callHeaders = (n = 0): Record<string, string> =>
    callInit(n).headers as Record<string, string>;
  const callBody = (n = 0): unknown => JSON.parse(callInit(n).body as string);

  beforeEach(() => {
    mockFetch.mockReset();
    proxy.impl = (host) => Promise.resolve(`https://${host}`);
    progressHandlers.clear();
    mockFetch.mockImplementation(() => Promise.resolve(okResponse({})));
    onUnauthorized = vi.fn<OnUnauthorized>();
    api = createApiClient({ host: "host.test:8443", token: "tok-1" }, onUnauthorized);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface Row {
    readonly name: string;
    readonly call: (a: Api) => Promise<unknown>;
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  }

  const rows: readonly Row[] = [
    {
      name: "login",
      call: (a) => a.login("ann", "pw"),
      method: "POST",
      path: "/auth/login",
      body: { username: "ann", password: "pw" },
    },
    {
      name: "register",
      call: (a) => a.register("ann", "pw", "inv"),
      method: "POST",
      path: "/auth/register",
      body: { username: "ann", password: "pw", invite_code: "inv" },
    },
    { name: "logout", call: (a) => a.logout(), method: "POST", path: "/auth/logout" },
    {
      name: "recoverAccount",
      call: (a) => a.recoverAccount("ann", "kit", "newpw"),
      method: "POST",
      path: "/auth/recover",
      body: { username: "ann", kit_secret: "kit", new_password: "newpw" },
    },
    {
      name: "deleteAccount",
      call: (a) => a.deleteAccount("pw"),
      method: "DELETE",
      path: "/auth/account",
      body: { password: "pw" },
    },
    { name: "getMe", call: (a) => a.getMe(), method: "GET", path: "/auth/me" },
    {
      name: "updateProfile",
      call: (a) => a.updateProfile({ display_name: "Ann", about: "hi" }),
      method: "PATCH",
      path: "/users/me",
      body: { display_name: "Ann", about: "hi" },
    },
    {
      name: "removeBanner",
      call: (a) => a.removeBanner(),
      method: "DELETE",
      path: "/users/me/banner",
    },
    {
      name: "changePassword",
      call: (a) => a.changePassword("old", "new"),
      method: "PUT",
      path: "/users/me/password",
      body: { old_password: "old", new_password: "new" },
    },
    {
      name: "enableTotp",
      call: (a) => a.enableTotp("pw"),
      method: "POST",
      path: "/users/me/totp/enable",
      body: { password: "pw" },
    },
    {
      name: "confirmTotp",
      call: (a) => a.confirmTotp("pw", "123456"),
      method: "POST",
      path: "/users/me/totp/confirm",
      body: { password: "pw", code: "123456" },
    },
    {
      name: "disableTotp",
      call: (a) => a.disableTotp("pw"),
      method: "DELETE",
      path: "/users/me/totp",
      body: { password: "pw" },
    },
    {
      name: "regenerateRecoveryCodes",
      call: (a) => a.regenerateRecoveryCodes("pw"),
      method: "POST",
      path: "/users/me/totp/recovery-codes",
      body: { password: "pw" },
    },
    {
      name: "enrolRecoveryKit",
      call: (a) => a.enrolRecoveryKit("pw"),
      method: "POST",
      path: "/users/me/recovery-kit",
      body: { password: "pw" },
    },
    {
      name: "getRecoveryKitStatus",
      call: (a) => a.getRecoveryKitStatus(),
      method: "GET",
      path: "/users/me/recovery-kit",
    },
    {
      name: "getUserNote",
      call: (a) => a.getUserNote(7),
      method: "GET",
      path: "/users/me/notes/7",
    },
    {
      name: "putUserNote",
      call: (a) => a.putUserNote(7, "remember"),
      method: "PUT",
      path: "/users/me/notes/7",
      body: { note: "remember" },
    },
    {
      name: "getDmPrivacy",
      call: (a) => a.getDmPrivacy(),
      method: "GET",
      path: "/users/me/privacy",
    },
    {
      name: "putDmPrivacy",
      call: (a) => a.putDmPrivacy({ allow_member_dms: false, message_requests: true }),
      method: "PUT",
      path: "/users/me/privacy",
      body: { allow_member_dms: false, message_requests: true },
    },
    {
      name: "getOwnModeration",
      call: (a) => a.getOwnModeration(),
      method: "GET",
      path: "/users/me/moderation",
    },
    {
      name: "fileReport",
      call: (a) =>
        a.fileReport({ target_type: "message", target_id: "9", reason: "spam", detail: "d" }),
      method: "POST",
      path: "/reports",
      body: { target_type: "message", target_id: "9", reason: "spam", detail: "d" },
    },
    { name: "getMyReports", call: (a) => a.getMyReports(), method: "GET", path: "/reports/mine" },
    {
      name: "getModerationQueue (all open and assigned)",
      call: (a) => a.getModerationQueue(""),
      method: "GET",
      path: "/moderation/queue",
    },
    {
      name: "getModerationQueue (filtered)",
      call: (a) => a.getModerationQueue("closed"),
      method: "GET",
      path: "/moderation/queue?state=closed",
    },
    {
      name: "getModerationReport",
      call: (a) => a.getModerationReport("r/1 x"),
      method: "GET",
      path: "/moderation/queue/r%2F1%20x",
    },
    {
      name: "assignModerationReport",
      call: (a) => a.assignModerationReport("r1"),
      method: "POST",
      path: "/moderation/queue/r1/assign",
    },
    {
      name: "addModerationNote",
      call: (a) => a.addModerationNote("r1", "note text"),
      method: "POST",
      path: "/moderation/queue/r1/notes",
      body: { body: "note text" },
    },
    {
      name: "closeModerationReport",
      call: (a) => a.closeModerationReport("r1", "duplicate"),
      method: "POST",
      path: "/moderation/queue/r1/close",
      body: { outcome: "duplicate" },
    },
    {
      name: "actOnModerationReport",
      call: (a) => a.actOnModerationReport("r1", { kind: "warning", reason: "be nice" }),
      method: "POST",
      path: "/moderation/queue/r1/act",
      body: { kind: "warning", reason: "be nice" },
    },
    {
      name: "timeoutMember",
      call: (a) => a.timeoutMember(7, 300, "why"),
      method: "POST",
      path: "/moderation/users/7/timeout",
      body: { reason: "why", duration_seconds: 300 },
    },
    {
      name: "setMemberNickname",
      call: (a) => a.setMemberNickname(7, null),
      method: "PUT",
      path: "/moderation/users/7/nickname",
      body: { display_name: null },
    },
    {
      name: "liftTimeout",
      call: (a) => a.liftTimeout(7),
      method: "POST",
      path: "/moderation/users/7/untimeout",
    },
    {
      name: "getModerationAppeals (all open and assigned)",
      call: (a) => a.getModerationAppeals(""),
      method: "GET",
      path: "/moderation/appeals",
    },
    {
      name: "getModerationAppeals (filtered)",
      call: (a) => a.getModerationAppeals("decided"),
      method: "GET",
      path: "/moderation/appeals?state=decided",
    },
    {
      name: "getModerationAppeal",
      call: (a) => a.getModerationAppeal("a/1"),
      method: "GET",
      path: "/moderation/appeals/a%2F1",
    },
    {
      name: "assignModerationAppeal",
      call: (a) => a.assignModerationAppeal("a1"),
      method: "POST",
      path: "/moderation/appeals/a1/assign",
    },
    {
      name: "decideModerationAppeal",
      call: (a) => a.decideModerationAppeal("a1", "upheld", "because"),
      method: "POST",
      path: "/moderation/appeals/a1/decide",
      body: { outcome: "upheld", note: "because" },
    },
    {
      name: "acknowledgeNotice",
      call: (a) => a.acknowledgeNotice(5),
      method: "POST",
      path: "/users/me/notices/5/ack",
    },
    {
      name: "fileAppeal",
      call: (a) => a.fileAppeal(5, "unfair"),
      method: "POST",
      path: "/appeals/",
      body: { action_id: 5, body: "unfair" },
    },
    { name: "getMyAppeals", call: (a) => a.getMyAppeals(), method: "GET", path: "/appeals/mine" },
    {
      name: "withdrawAppeal",
      call: (a) => a.withdrawAppeal("a/1"),
      method: "POST",
      path: "/appeals/a%2F1/withdraw",
    },
    {
      name: "revokeSession",
      call: (a) => a.revokeSession(3),
      method: "DELETE",
      path: "/users/me/sessions/3",
    },
    {
      name: "revokeAllSessions",
      call: (a) => a.revokeAllSessions(),
      method: "DELETE",
      path: "/users/me/sessions",
    },
    {
      name: "getMessages (no options)",
      call: (a) => a.getMessages(5),
      method: "GET",
      path: "/channels/5/messages",
    },
    {
      name: "getMessages (before and limit)",
      call: (a) => a.getMessages(5, { before: 90, limit: 25 }),
      method: "GET",
      path: "/channels/5/messages?before=90&limit=25",
    },
    {
      name: "getMessages (after)",
      call: (a) => a.getMessages(5, { after: 10 }),
      method: "GET",
      path: "/channels/5/messages?after=10",
    },
    {
      name: "getMessagesAround (no options)",
      call: (a) => a.getMessagesAround(5, 77),
      method: "GET",
      path: "/channels/5/messages/around/77",
    },
    {
      name: "getMessagesAround (limit)",
      call: (a) => a.getMessagesAround(5, 77, { limit: 20 }),
      method: "GET",
      path: "/channels/5/messages/around/77?limit=20",
    },
    {
      name: "purgeMessages (newest)",
      call: (a) => a.purgeMessages(5, 30),
      method: "POST",
      path: "/channels/5/messages/purge",
      body: { limit: 30 },
    },
    {
      name: "purgeMessages (before a message)",
      call: (a) => a.purgeMessages(5, 30, { before: 44 }),
      method: "POST",
      path: "/channels/5/messages/purge",
      body: { limit: 30, before: 44 },
    },
    {
      name: "getReactionUsers",
      call: (a) => a.getReactionUsers(5, 6, "👍 x"),
      method: "GET",
      path: `/channels/5/messages/6/reactions/${encodeURIComponent("👍 x")}/users`,
    },
    { name: "getPins", call: (a) => a.getPins(5), method: "GET", path: "/channels/5/pins" },
    {
      name: "listThreads",
      call: (a) => a.listThreads(5, "archived=1&limit=10"),
      method: "GET",
      path: "/channels/5/threads?archived=1&limit=10",
    },
    {
      name: "pinMessage",
      call: (a) => a.pinMessage(5, 6),
      method: "POST",
      path: "/channels/5/pins/6",
    },
    {
      name: "unpinMessage",
      call: (a) => a.unpinMessage(5, 6),
      method: "DELETE",
      path: "/channels/5/pins/6",
    },
    {
      name: "search (query only)",
      call: (a) => a.search("a b&c"),
      method: "GET",
      path: "/search?q=a+b%26c",
    },
    {
      name: "search (all filters)",
      call: (a) => a.search("hi", { channelId: 5, limit: 10, sort: "relevance" }),
      method: "GET",
      path: "/search?q=hi&channel_id=5&limit=10&sort=relevance",
    },
    {
      name: "search (a cursor forces recent order)",
      call: (a) => a.search("hi", { sort: "relevance", before: 99 }),
      method: "GET",
      path: "/search?q=hi&sort=recent&before=99",
    },
    {
      name: "acknowledgeNsfw",
      call: (a) => a.acknowledgeNsfw(5),
      method: "PUT",
      path: "/channels/5/nsfw-acknowledgement",
    },
    {
      name: "revokeNsfw",
      call: (a) => a.revokeNsfw(5),
      method: "DELETE",
      path: "/channels/5/nsfw-acknowledgement",
    },
    {
      name: "gifSearch",
      call: (a) => a.gifSearch("cat dance", 12),
      method: "GET",
      path: "/gif/search?q=cat+dance&limit=12",
    },
    {
      name: "gifSearch (next page)",
      call: (a) => a.gifSearch("cat", 12, "CURSOR"),
      method: "GET",
      path: "/gif/search?q=cat&limit=12&pos=CURSOR",
    },
    {
      name: "gifTrending",
      call: (a) => a.gifTrending(8),
      method: "GET",
      path: "/gif/trending?limit=8",
    },
    {
      name: "gifTrending (next page)",
      call: (a) => a.gifTrending(8, "CURSOR"),
      method: "GET",
      path: "/gif/trending?limit=8&pos=CURSOR",
    },
    { name: "gifFavorites", call: (a) => a.gifFavorites(), method: "GET", path: "/gif/favorites" },
    {
      name: "addGifFavorite",
      call: (a) => a.addGifFavorite({ url: "https://g/1", preview_url: "https://g/p", title: "t" }),
      method: "PUT",
      path: "/gif/favorites",
      body: { url: "https://g/1", preview_url: "https://g/p", title: "t" },
    },
    {
      name: "removeGifFavorite",
      call: (a) => a.removeGifFavorite("https://g/1?a=b"),
      method: "DELETE",
      path: "/gif/favorites?url=https%3A%2F%2Fg%2F1%3Fa%3Db",
    },
    {
      name: "discardUpload",
      call: (a) => a.discardUpload("u/1"),
      method: "DELETE",
      path: "/uploads/u%2F1",
    },
    { name: "getInvites", call: (a) => a.getInvites(), method: "GET", path: "/invites" },
    {
      name: "createInvite",
      call: (a) => a.createInvite({ max_uses: 3, expires_in_hours: 24 }),
      method: "POST",
      path: "/invites",
      body: { max_uses: 3, expires_in_hours: 24 },
    },
    {
      name: "revokeInvite",
      call: (a) => a.revokeInvite("abc123"),
      method: "DELETE",
      path: "/invites/abc123",
    },
    { name: "listEmoji", call: (a) => a.listEmoji(), method: "GET", path: "/emoji" },
    { name: "deleteEmoji", call: (a) => a.deleteEmoji(4), method: "DELETE", path: "/emoji/4" },
    { name: "listStickers", call: (a) => a.listStickers(), method: "GET", path: "/stickers" },
    { name: "getDmChannels", call: (a) => a.getDmChannels(), method: "GET", path: "/dms" },
    {
      name: "createDm",
      call: (a) => a.createDm(8),
      method: "POST",
      path: "/dms",
      body: { recipient_id: 8 },
    },
    {
      name: "createGroupDm (named)",
      call: (a) => a.createGroupDm([2, 3], "crew"),
      method: "POST",
      path: "/dms/group",
      body: { recipient_ids: [2, 3], name: "crew" },
    },
    {
      name: "createGroupDm (unnamed)",
      call: (a) => a.createGroupDm([2, 3]),
      method: "POST",
      path: "/dms/group",
      body: { recipient_ids: [2, 3], name: "" },
    },
    {
      name: "renameGroupDm",
      call: (a) => a.renameGroupDm(9, "new"),
      method: "PATCH",
      path: "/dms/9",
      body: { name: "new" },
    },
    {
      name: "addGroupDmMembers",
      call: (a) => a.addGroupDmMembers(9, [4, 5]),
      method: "POST",
      path: "/dms/9/members",
      body: { user_ids: [4, 5] },
    },
    {
      name: "removeGroupDmIcon",
      call: (a) => a.removeGroupDmIcon(9),
      method: "DELETE",
      path: "/dms/9/icon",
    },
    {
      name: "removeGroupDmMember",
      call: (a) => a.removeGroupDmMember(9, 4),
      method: "DELETE",
      path: "/dms/9/members/4",
    },
    {
      name: "setGroupDmOwner",
      call: (a) => a.setGroupDmOwner(9, 4),
      method: "PUT",
      path: "/dms/9/owner",
      body: { user_id: 4 },
    },
    { name: "closeDm", call: (a) => a.closeDm(9), method: "DELETE", path: "/dms/9" },
    { name: "listBlocks", call: (a) => a.listBlocks(), method: "GET", path: "/blocks" },
    {
      name: "listDmRequests",
      call: (a) => a.listDmRequests(),
      method: "GET",
      path: "/dm-requests",
    },
    {
      name: "decideDmRequest",
      call: (a) => a.decideDmRequest(3, "ignore"),
      method: "POST",
      path: "/dm-requests/3/ignore",
    },
    { name: "blockUser", call: (a) => a.blockUser(6), method: "PUT", path: "/blocks/6" },
    { name: "unblockUser", call: (a) => a.unblockUser(6), method: "DELETE", path: "/blocks/6" },
    {
      name: "getVoiceCredentials",
      call: (a) => a.getVoiceCredentials(),
      method: "GET",
      path: "/voice/credentials",
    },
    {
      name: "adminCreateChannel",
      call: (a) => a.adminCreateChannel({ name: "general", type: "text", category_id: 2 }),
      method: "POST",
      path: "/moderation/channels",
      body: { name: "general", type: "text", category_id: 2 },
    },
    {
      name: "adminUpdateChannel",
      call: (a) => a.adminUpdateChannel(4, { topic: "t", nsfw: true }),
      method: "PATCH",
      path: "/moderation/channels/4",
      body: { topic: "t", nsfw: true },
    },
    {
      name: "adminUpdateForumSettings",
      call: (a) =>
        a.adminUpdateForumSettings(4, {
          tags: [{ name: "bug" }],
          require_tag: true,
          default_auto_archive_minutes: 1440,
        }),
      method: "PUT",
      path: "/moderation/channels/4/forum",
      body: {
        tags: [{ name: "bug" }],
        require_tag: true,
        default_auto_archive_minutes: 1440,
      },
    },
    {
      name: "adminDeleteChannel",
      call: (a) => a.adminDeleteChannel(4),
      method: "DELETE",
      path: "/moderation/channels/4",
    },
    {
      name: "adminCreateCategory",
      call: (a) => a.adminCreateCategory("Voice"),
      method: "POST",
      path: "/moderation/channels/categories",
      body: { name: "Voice" },
    },
    {
      name: "adminRenameCategory",
      call: (a) => a.adminRenameCategory(2, "Talk"),
      method: "PATCH",
      path: "/moderation/channels/categories/2",
      body: { name: "Talk" },
    },
    {
      name: "adminDeleteCategory",
      call: (a) => a.adminDeleteCategory(2),
      method: "DELETE",
      path: "/moderation/channels/categories/2",
    },
    {
      name: "adminReorderCategories",
      call: (a) => a.adminReorderCategories([3, 1, 2]),
      method: "PUT",
      path: "/moderation/channels/categories/order",
      body: { ids: [3, 1, 2] },
    },
    {
      name: "adminKickMember",
      call: (a) => a.adminKickMember(9),
      method: "DELETE",
      path: "/moderation/members/9/sessions",
    },
    {
      name: "adminChangeRole",
      call: (a) => a.adminChangeRole(9, 3),
      method: "PATCH",
      path: "/moderation/members/9",
      body: { role_id: 3 },
    },
    {
      name: "adminAddMemberRole",
      call: (a) => a.adminAddMemberRole(9, 3),
      method: "PUT",
      path: "/moderation/members/9/roles/3",
    },
    {
      name: "adminRemoveMemberRole",
      call: (a) => a.adminRemoveMemberRole(9, 3),
      method: "DELETE",
      path: "/moderation/members/9/roles/3",
    },
    {
      name: "adminUnbanMember",
      call: (a) => a.adminUnbanMember(9),
      method: "PATCH",
      path: "/moderation/members/9",
      body: { banned: false },
    },
    {
      name: "adminBanMember (permanent, no reason)",
      call: (a) => a.adminBanMember(9),
      method: "PATCH",
      path: "/moderation/members/9",
      body: { banned: true, ban_reason: "" },
    },
    {
      name: "adminBanMember (timed, with message purge)",
      call: (a) => a.adminBanMember(9, "spam", 12, undefined, 3600),
      method: "PATCH",
      path: "/moderation/members/9",
      body: {
        banned: true,
        ban_reason: "spam",
        ban_duration_hours: 12,
        delete_message_seconds: 3600,
      },
    },
    {
      name: "adminBanMember (zero duration and zero purge are omitted)",
      call: (a) => a.adminBanMember(9, "spam", 0, undefined, 0),
      method: "PATCH",
      path: "/moderation/members/9",
      body: { banned: true, ban_reason: "spam" },
    },
  ];

  it.each(rows)("$name sends $method $path", async (row) => {
    await row.call(api);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(callUrl()).toBe(`${BASE}${row.path}`);
    expect(callInit().method).toBe(row.method);
    if (row.body === undefined) expect(callInit().body).toBeUndefined();
    else expect(callBody()).toEqual(row.body);
    expect(callHeaders()["Content-Type"]).toBe("application/json");
    expect(callHeaders()["Authorization"]).toBe("Bearer tok-1");
  });

  it("returns the parsed body of a successful call", async () => {
    mockFetch.mockResolvedValue(okResponse({ id: 1, username: "ann" }));
    await expect(api.getMe()).resolves.toEqual({ id: 1, username: "ann" });
  });

  it("returns undefined for a 204 without reading a body", async () => {
    const res = okResponse(undefined, 204);
    const json = vi.fn(res.json);
    (res as { json: unknown }).json = json;
    mockFetch.mockResolvedValue(res);
    await expect(api.closeDm(9)).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  describe("headers", () => {
    it("sends no Authorization header without a token", async () => {
      const anon = createApiClient({ host: "host.test:8443" });
      await anon.login("a", "b");
      expect(callHeaders()["Authorization"]).toBeUndefined();
      expect(callHeaders()["Content-Type"]).toBe("application/json");
    });

    it("lets a per-call token replace the session token", async () => {
      await api.verifyTotp("123456", "partial-token");
      expect(callUrl()).toBe(`${BASE}/auth/verify-totp`);
      expect(callInit().method).toBe("POST");
      expect(callBody()).toEqual({ code: "123456" });
      expect(callHeaders()["Authorization"]).toBe("Bearer partial-token");
    });

    it("leaves the Content-Type to the transport for a multipart upload", async () => {
      await api.uploadFile(new File(["x"], "a.png", { type: "image/png" }));
      expect(callHeaders()["Content-Type"]).toBeUndefined();
      expect(callHeaders()["Authorization"]).toBe("Bearer tok-1");
    });
  });

  describe("multipart uploads", () => {
    const file = new File(["hello"], "pic.png", { type: "image/png" });

    async function sentForm(): Promise<FormData> {
      const body = callInit().body;
      expect(body).toBeInstanceOf(FormData);
      return body as FormData;
    }

    it.each([
      ["uploadAvatar", (a: Api) => a.uploadAvatar(file), "/users/me/avatar"],
      ["uploadBanner", (a: Api) => a.uploadBanner(file), "/users/me/banner"],
      ["uploadFile", (a: Api) => a.uploadFile(file), "/uploads"],
      ["uploadGroupDmIcon", (a: Api) => a.uploadGroupDmIcon(9, file), "/dms/9/icon"],
    ] as const)("%s posts the file as form data", async (_name, call, path) => {
      await call(api);
      expect(callUrl()).toBe(`${BASE}${path}`);
      expect(callInit().method).toBe("POST");
      const form = await sentForm();
      const sent = form.get("file") as File;
      expect(sent.name).toBe("pic.png");
      expect(sent.size).toBe(5);
      expect(callHeaders()["Content-Type"]).toBeUndefined();
    });

    it("uploadEmoji sends the shortcode and the image", async () => {
      await api.uploadEmoji("party", file);
      expect(callUrl()).toBe(`${BASE}/emoji`);
      expect(callInit().method).toBe("POST");
      const form = await sentForm();
      expect(form.get("shortcode")).toBe("party");
      expect((form.get("file") as File).name).toBe("pic.png");
      expect(callHeaders()["Content-Type"]).toBeUndefined();
    });

    it("uploadFile declares a voice message's length and waveform in the query", async () => {
      await api.uploadFile(file, undefined, undefined, {
        durationMs: 1234.6,
        waveform: "AB_-cd",
      });
      expect(callUrl()).toBe(`${BASE}/uploads?voice_duration_ms=1235&voice_waveform=AB_-cd`);
    });

    it("uploadFile percent-encodes the waveform", async () => {
      await api.uploadFile(file, undefined, undefined, { durationMs: 10, waveform: "a b&c" });
      expect(callUrl()).toBe(`${BASE}/uploads?voice_duration_ms=10&voice_waveform=a%20b%26c`);
    });
  });

  describe("removeAvatar", () => {
    it("deletes the avatar", async () => {
      mockFetch.mockResolvedValue(okResponse({ id: 1 }));
      await expect(api.removeAvatar("ann")).resolves.toEqual({ id: 1 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(callUrl()).toBe(`${BASE}/users/me/avatar`);
      expect(callInit().method).toBe("DELETE");
    });

    it("falls back to a profile PATCH when the server answers 405", async () => {
      mockFetch
        .mockResolvedValueOnce(failResponse(405, { error: "METHOD_NOT_ALLOWED", message: "no" }))
        .mockResolvedValueOnce(okResponse({ id: 1, avatar: "" }));
      await expect(api.removeAvatar("ann")).resolves.toEqual({ id: 1, avatar: "" });
      expectConsole("warn", /API error/);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(callUrl(1)).toBe(`${BASE}/users/me`);
      expect(callInit(1).method).toBe("PATCH");
      expect(callBody(1)).toEqual({ username: "ann", avatar: "" });
    });

    it.each([404, 500])("rethrows a %i without retrying", async (status) => {
      mockFetch.mockResolvedValue(failResponse(status, { error: "X", message: "no" }));
      await expect(api.removeAvatar("ann")).rejects.toMatchObject({ status });
      expectConsole("warn", /API error/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("rethrows a transport failure without retrying", async () => {
      mockFetch.mockRejectedValue(new Error("offline"));
      await expect(api.removeAvatar("ann")).rejects.toBeInstanceOf(TransportError);
      expectConsole(
        "error",
        /fetch failed.*"method":"DELETE".*"path":"\/users\/me\/avatar".*"error":"Error: offline"/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("sessions", () => {
    it("getSessions reads GET /users/me/sessions and unwraps the list", async () => {
      const sessions = [{ id: 1, device: "d", ip: "i", is_current: true }];
      mockFetch.mockResolvedValue(okResponse({ sessions }));
      await expect(api.getSessions()).resolves.toEqual(sessions);
      expect(callUrl()).toBe(`${BASE}/users/me/sessions`);
      expect(callInit().method).toBe("GET");
    });

    it("getSessions rejects when the session ended while the call was in flight", async () => {
      let release: (r: Response) => void = () => {};
      mockFetch.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
      const pending = api.getSessions();
      const settled = pending.catch((e: unknown) => e);
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      api.endSession();
      release(okResponse({ sessions: [] }));
      await expect(settled).resolves.toMatchObject({ name: "AbortError" });
    });
  });

  describe("adminListUsers", () => {
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: from + i }));

    it("fetches one page and stops on a short page", async () => {
      mockFetch.mockResolvedValue(okResponse(page(0, 3)));
      await expect(api.adminListUsers()).resolves.toHaveLength(3);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(callUrl()).toBe(`${BASE}/moderation/members?limit=500&offset=0`);
      expect(callInit().method).toBe("GET");
    });

    it("walks every page of 500 until a short one arrives", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(page(0, 500)))
        .mockResolvedValueOnce(okResponse(page(500, 500)))
        .mockResolvedValueOnce(okResponse(page(1000, 7)));
      const users = await api.adminListUsers();
      expect(users).toHaveLength(1007);
      expect(users[1006]).toEqual({ id: 1006 });
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(callUrl(1)).toBe(`${BASE}/moderation/members?limit=500&offset=500`);
      expect(callUrl(2)).toBe(`${BASE}/moderation/members?limit=500&offset=1000`);
    });

    it("stops after 200 pages when a server never sends a short one", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(okResponse(page(0, 500))));
      const users = await api.adminListUsers();
      expect(mockFetch).toHaveBeenCalledTimes(200);
      expect(users).toHaveLength(200 * 500);
      expect(callUrl(199)).toBe(`${BASE}/moderation/members?limit=500&offset=${199 * 500}`);
    });
  });

  describe("logout", () => {
    it("does not run the session-expiry callback on a 401", async () => {
      mockFetch.mockResolvedValue(failResponse(401, { error: "UNAUTHORIZED", message: "gone" }));
      await expect(api.logout()).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /API error/);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("survives the end of the session it was sent from", async () => {
      let release: (r: Response) => void = () => {};
      mockFetch.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
      const pending = api.logout();
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      api.endSession();
      expect((callInit().signal as AbortSignal).aborted).toBe(false);
      release(okResponse(undefined, 204));
      await expect(pending).resolves.toBeUndefined();
    });

    it("gives up on a server that never answers after ten seconds", async () => {
      vi.useFakeTimers();
      mockFetch.mockReturnValue(new Promise<Response>(() => {}));
      const pending = api.logout().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(9_900);
      expect((callInit().signal as AbortSignal).aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect((callInit().signal as AbortSignal).aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ name: "AbortError" });
    });
  });

  describe("confirmTotp", () => {
    it("does not sign the user out on a refused enrolment code", async () => {
      mockFetch.mockResolvedValue(failResponse(401, { error: "UNAUTHORIZED", message: "bad" }));
      await expect(api.confirmTotp("pw", "000000")).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /API error/);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("other calls do run the session-expiry callback on a 401", async () => {
      mockFetch.mockResolvedValue(failResponse(401, { error: "UNAUTHORIZED", message: "bad" }));
      await expect(api.disableTotp("pw")).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /API error/);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
  });

  describe("upload progress", () => {
    it("is not subscribed for a JSON call", async () => {
      await api.getMe();
      expect(callHeaders()["X-Upload-Id"]).toBeUndefined();
      expect(progressHandlers.size).toBe(0);
    });

    async function progressSeenFor(
      ticks: readonly { sent: number; total: number }[],
    ): Promise<number[]> {
      const seen: number[] = [];
      let finish: (r: Response) => void = () => {};
      mockFetch.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
      const upload = api.uploadFile(new File(["x"], "a.png"), undefined, (f) => seen.push(f));
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(progressHandlers.size).toBe(1));
      const id = callHeaders()["X-Upload-Id"];
      for (const tick of ticks) {
        for (const handler of progressHandlers) handler({ payload: { id, ...tick } });
      }
      finish(okResponse({ id: "srv" }));
      await upload;
      return seen;
    }

    it("reports the fraction sent", async () => {
      await expect(
        progressSeenFor([
          { sent: 0, total: 200 },
          { sent: 50, total: 200 },
          { sent: 200, total: 200 },
        ]),
      ).resolves.toEqual([0, 0.25, 1]);
    });

    it("never reports below 0 or above 1", async () => {
      await expect(
        progressSeenFor([
          { sent: -10, total: 100 },
          { sent: 250, total: 100 },
        ]),
      ).resolves.toEqual([0, 1]);
    });

    it("reports 0 while the total is unknown", async () => {
      await expect(
        progressSeenFor([
          { sent: 40, total: 0 },
          { sent: 40, total: -5 },
        ]),
      ).resolves.toEqual([0, 0]);
    });

    it("ignores another upload's ticks and stops listening once settled", async () => {
      const seen: number[] = [];
      mockFetch.mockResolvedValue(okResponse({ id: "srv" }));
      const upload = api.uploadFile(new File(["x"], "a.png"), undefined, (f) => seen.push(f));
      await upload;
      for (const handler of progressHandlers) handler({ payload: { id: "x", sent: 1, total: 2 } });
      expect(seen).toEqual([]);
      expect(progressHandlers.size).toBe(0);
    });
  });

  describe("health and server-info probes", () => {
    it("getHealth fetches /health for the signed-in server with a signal and no auth", async () => {
      mockFetch.mockResolvedValue(okResponse({ status: "ok" }));
      await expect(api.getHealth()).resolves.toEqual({ status: "ok" });
      expect(callUrl()).toBe(`${BASE}/health`);
      expect((callInit().signal as AbortSignal).aborted).toBe(false);
    });

    it("getHealth reaches an explicit host", async () => {
      await api.getHealth("other.test:9000");
      expect(callUrl()).toBe("https://other.test:9000/api/v1/health");
    });

    it("getHealth maps a refusal to a HEALTH_CHECK_FAILED error carrying the status", async () => {
      mockFetch.mockResolvedValue(failResponse(503, {}));
      const err = await api.getHealth().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiClientError);
      expect(err).toMatchObject({ status: 503, code: "HEALTH_CHECK_FAILED" });
    });

    it("getServerInfo fetches /server-info for the signed-in server", async () => {
      mockFetch.mockResolvedValue(okResponse({ name: "srv" }));
      await expect(api.getServerInfo()).resolves.toEqual({ name: "srv" });
      expect(callUrl()).toBe(`${BASE}/server-info`);
      expect((callInit().signal as AbortSignal).aborted).toBe(false);
    });

    it("getServerInfo reaches an explicit host", async () => {
      await api.getServerInfo("other.test:9000");
      expect(callUrl()).toBe("https://other.test:9000/api/v1/server-info");
    });

    it("getServerInfo maps a refusal to a SERVER_INFO_FAILED error carrying the status", async () => {
      mockFetch.mockResolvedValue(failResponse(404, {}));
      const err = await api.getServerInfo().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiClientError);
      expect(err).toMatchObject({ status: 404, code: "SERVER_INFO_FAILED" });
    });

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s on the signed-in server is cancelled when the session ends",
      async (name) => {
        mockFetch.mockReturnValue(new Promise<Response>(() => {}));
        const pending = api[name]().catch((e: unknown) => e);
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
        api.endSession();
        await expect(pending).resolves.toMatchObject({ name: "AbortError" });
        expect((callInit().signal as AbortSignal).aborted).toBe(true);
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s on an explicit host outlives the signed-in session",
      async (name) => {
        let release: (r: Response) => void = () => {};
        mockFetch.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
        const pending = api[name]("other.test:9000");
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
        api.endSession();
        expect((callInit().signal as AbortSignal).aborted).toBe(false);
        release(okResponse({ ok: true }));
        await expect(pending).resolves.toEqual({ ok: true });
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s on an explicit host is cancelled by the caller's signal",
      async (name) => {
        mockFetch.mockReturnValue(new Promise<Response>(() => {}));
        const ac = new AbortController();
        const pending = api[name]("other.test:9000", 3000, ac.signal).catch((e: unknown) => e);
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
        ac.abort();
        await expect(pending).resolves.toMatchObject({ name: "AbortError" });
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s times out after the given milliseconds and defaults to three seconds",
      async (name) => {
        vi.useFakeTimers();
        mockFetch.mockReturnValue(new Promise<Response>(() => {}));
        const first = api[name]().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(2_900);
        expect((callInit().signal as AbortSignal).aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        await expect(first).resolves.toMatchObject({ name: "AbortError" });

        mockFetch.mockClear();
        mockFetch.mockReturnValue(new Promise<Response>(() => {}));
        const second = api[name](undefined, 500).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(600);
        await expect(second).resolves.toMatchObject({ name: "AbortError" });
      },
    );
  });

  describe("a session that ends while a call is completing", () => {
    // `then` settles the awaited value and ends the session in the same turn,
    // before the awaiting code resumes, so the work finished while the session
    // was still current and is only found stale afterwards.
    function endsAfterSettling<T>(
      settle: "resolve" | "reject",
      value: T,
      end: () => void,
    ): PromiseLike<T> {
      return {
        then(onFulfilled: (v: T) => void, onRejected: (e: unknown) => void): void {
          if (settle === "resolve") onFulfilled(value);
          else onRejected(value);
          end();
        },
      } as unknown as PromiseLike<T>;
    }

    it("sends no request when the session ended as the proxy came up", async () => {
      proxy.impl = () =>
        endsAfterSettling("resolve", "https://host.test:8443", () => api.endSession());
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not read the body when the session ended as the response arrived", async () => {
      const json = vi.fn(() => Promise.resolve({ id: 1 }));
      mockFetch.mockReturnValue(
        endsAfterSettling("resolve", { ...okResponse(), json }, () => api.endSession()),
      );
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
      expect(json).not.toHaveBeenCalled();
    });

    it("does not return data that arrived as the session ended", async () => {
      const res = okResponse();
      (res as { json: unknown }).json = () =>
        endsAfterSettling("resolve", { id: 1 }, () => api.endSession());
      mockFetch.mockResolvedValue(res);
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
    });

    it("reports the cancellation, not a parse error, when the body failed as the session ended", async () => {
      const res = okResponse();
      (res as { json: unknown }).json = () =>
        endsAfterSettling("reject", new SyntaxError("Unexpected token <"), () => api.endSession());
      mockFetch.mockResolvedValue(res);
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
    });

    it("does not report a server error that arrived as the session ended", async () => {
      // The request releases its transport hook just after its error body is
      // read; ending the session at that point lands between the two steps.
      let armed = false;
      const res = failResponse(500, { error: "X", message: "m" });
      (res as { json: unknown }).json = () => {
        armed = true;
        return Promise.resolve({ error: "X", message: "m" });
      };
      mockFetch.mockResolvedValue(res);
      const realDelete = Set.prototype.delete;
      Set.prototype.delete = function (this: Set<unknown>, value: unknown): boolean {
        if (armed) {
          armed = false;
          api.endSession();
        }
        return realDelete.call(this, value);
      };
      try {
        await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        Set.prototype.delete = realDelete;
      }
    });

    it("does not hand back sessions listed as the session ended", async () => {
      mockFetch.mockResolvedValue(okResponse({ sessions: [{ id: 1 }] }));
      // The request's own cleanup is the last thing to run before its result
      // reaches getSessions, so ending the session there lands in between.
      const clear = globalThis.clearTimeout;
      const spy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
        spy.mockRestore();
        api.endSession();
        clear(id);
      });
      const outcome = await api.getSessions().then(
        (v) => ({ value: v }),
        (e: unknown) => ({ error: e }),
      );
      spy.mockRestore();
      expect(outcome).toMatchObject({ error: { name: "AbortError" } });
    });
  });

  describe("probes whose session ends while they complete", () => {
    function endsAfterSettling<T>(value: T, end: () => void): PromiseLike<T> {
      return {
        then(onFulfilled: (v: T) => void): void {
          onFulfilled(value);
          end();
        },
      } as unknown as PromiseLike<T>;
    }

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s sends no request when the session ended as the proxy came up",
      async (name) => {
        proxy.impl = () => endsAfterSettling("https://host.test:8443", () => api.endSession());
        await expect(api[name]()).rejects.toMatchObject({ name: "AbortError" });
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s does not read the body when the session ended as the response arrived",
      async (name) => {
        const json = vi.fn(() => Promise.resolve({}));
        mockFetch.mockReturnValue(
          endsAfterSettling({ ...okResponse(), json }, () => api.endSession()),
        );
        await expect(api[name]()).rejects.toMatchObject({ name: "AbortError" });
        expect(json).not.toHaveBeenCalled();
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s reports the cancellation, not a refusal, when the session ended as a refusal arrived",
      async (name) => {
        mockFetch.mockReturnValue(endsAfterSettling(failResponse(503, {}), () => api.endSession()));
        await expect(api[name]()).rejects.toMatchObject({ name: "AbortError" });
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s does not return data that arrived as the session ended",
      async (name) => {
        const res = okResponse();
        (res as { json: unknown }).json = () =>
          endsAfterSettling({ ok: true }, () => api.endSession());
        mockFetch.mockResolvedValue(res);
        await expect(api[name]()).rejects.toMatchObject({ name: "AbortError" });
      },
    );
  });

  describe("finished calls release what they held", () => {
    it("a request leaves no timer and detaches from the caller's signal", async () => {
      vi.useFakeTimers();
      const ac = new AbortController();
      const removed = vi.spyOn(ac.signal, "removeEventListener");
      mockFetch.mockResolvedValue(okResponse(undefined, 204));
      await api.logout(ac.signal);
      expect(vi.getTimerCount()).toBe(0);
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("a failed request leaves no timer either", async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValue(failResponse(500, { error: "X", message: "m" }));
      await expect(api.logout()).rejects.toMatchObject({ status: 500 });
      expectConsole("warn", /API error/);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s leaves no timer and detaches from the caller's signal",
      async (name) => {
        vi.useFakeTimers();
        const ac = new AbortController();
        const removed = vi.spyOn(ac.signal, "removeEventListener");
        await api[name]("other.test:9000", 3000, ac.signal);
        expect(vi.getTimerCount()).toBe(0);
        expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
      },
    );
  });

  describe("a session that is already over", () => {
    it("starts nothing for a request whose caller has already cancelled", async () => {
      const calls = vi.fn(proxy.impl);
      proxy.impl = calls;
      const ac = new AbortController();
      ac.abort();
      await expect(api.getMe(ac.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s starts nothing when the caller has already cancelled",
      async (name) => {
        const calls = vi.fn(proxy.impl);
        proxy.impl = calls;
        const ac = new AbortController();
        ac.abort();
        await expect(api[name](undefined, 3000, ac.signal)).rejects.toMatchObject({
          name: "AbortError",
        });
        expect(calls).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );
  });

  describe("starting the proxy fails", () => {
    it("types a bare string rejection as a transport error and keeps the raw text", async () => {
      proxy.impl = () => Promise.reject("bind refused");
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(err).toMatchObject({ message: "bind refused", cause: "bind refused" });
      expectConsole("error", /proxy start failed.*"error":"bind refused"/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("reports the cancellation when the session ended as the proxy failed", async () => {
      proxy.impl = () =>
        ({
          then(_ok: unknown, fail: (e: unknown) => void): void {
            fail("bind refused");
            api.endSession();
          },
        }) as unknown as PromiseLike<string>;
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
    });

    it("uses the message of an Error rejection", async () => {
      const cause = new Error("no port");
      proxy.impl = () => Promise.reject(cause);
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(err).toMatchObject({ message: "no port", cause });
      expectConsole("error", /proxy start failed/);
    });
  });

  describe("setConfig", () => {
    it("rejects a host that is not a valid address and keeps the current one", () => {
      expect(() => api.setConfig({ host: "bad host/path" })).toThrow("Invalid host format");
      expectConsole("error", /setConfig rejected invalid host.*bad host\/path/);
      expect(api.getConfig().host).toBe("host.test:8443");
    });
  });
});

describe("error mapping", () => {
  let api: Api;

  beforeEach(() => {
    mockFetch.mockReset();
    api = createApiClient({ host: "host.test:8443", token: "tok-1" });
  });

  describe("Retry-After", () => {
    it.each([
      ["7", 7000],
      [" 12 ", 12000],
      ["0", 0],
      ["007", 7000],
    ])("reads %j seconds as %i ms", async (value, ms) => {
      mockFetch.mockResolvedValue(
        failResponse(429, { error: "RATE_LIMITED", message: "slow" }, { "Retry-After": value }),
      );
      await expect(api.login("u", "p")).rejects.toMatchObject({ retryAfterMs: ms });
      expectConsole("warn", /API error/);
    });

    it.each(["", "7s", "-3", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", "abc7", "7abc", "1 2"])(
      "ignores %j, which is not a delta in seconds",
      async (value) => {
        mockFetch.mockResolvedValue(
          failResponse(429, { error: "RATE_LIMITED", message: "slow" }, { "Retry-After": value }),
        );
        const err = (await api.login("u", "p").catch((e: unknown) => e)) as ApiClientError;
        expect(err.retryAfterMs).toBeUndefined();
        expectConsole("warn", /API error/);
      },
    );
  });

  describe("error classes", () => {
    it("TransportError is named and keeps its cause", () => {
      const cause = new Error("raw");
      const err = new TransportError("offline", { cause });
      expect(err.name).toBe("TransportError");
      expect(err.message).toBe("offline");
      expect(err.cause).toBe(cause);
      expect(err).toBeInstanceOf(Error);
    });

    it("httpError makes a TransportError only for a code-less 502", () => {
      expect(httpError(502, "UNKNOWN", "bad gateway")).toBeInstanceOf(TransportError);
      expect(httpError(502, "BAD_GATEWAY", "x")).toBeInstanceOf(ApiClientError);
      expect(httpError(500, "UNKNOWN", "x")).toBeInstanceOf(ApiClientError);
      const err = httpError(429, "AUTH_BUSY", "busy", 3000) as ApiClientError;
      expect(err).toMatchObject({ status: 429, code: "AUTH_BUSY", message: "busy" });
      expect(err.retryAfterMs).toBe(3000);
    });
  });

  describe("a 2xx whose body does not parse", () => {
    function badBody(reject: unknown): Response {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.reject(reject),
        headers: new Headers({ "content-type": "text/html" }),
      } as unknown as Response;
    }

    it.each([
      ["a SyntaxError with unrelated text", new SyntaxError("bad")],
      ["an Error that says Unexpected token", new Error("Unexpected token < in input")],
      ["an Error that mentions JSON", new Error("not valid JSON")],
    ])("is a NOT_JSON error for %s", async (_name, thrown) => {
      mockFetch.mockResolvedValue(badBody(thrown));
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiClientError);
      expect(err).toMatchObject({
        status: 200,
        code: "NOT_JSON",
        message: connectText("error.notJson"),
      });
      expectConsole("warn", /response is not JSON/);
    });

    it.each([
      ["an unrelated Error", new Error("disk on fire")],
      ["a TypeError", new TypeError("x is not a function")],
      ["a string that mentions JSON", "JSON everywhere"],
    ])("rethrows %s unchanged", async (_name, thrown) => {
      mockFetch.mockResolvedValue(badBody(thrown));
      await expect(api.getMe()).rejects.toBe(thrown);
    });
  });

  describe("a server error body", () => {
    it("is read from error and message", async () => {
      mockFetch.mockResolvedValue(failResponse(409, { error: "CONFLICT", message: "taken" }));
      await expect(api.getMe()).rejects.toMatchObject({
        status: 409,
        code: "CONFLICT",
        message: "taken",
      });
      expectConsole("warn", /API error.*CONFLICT.*taken/);
    });

    it("logs the request id the server sent", async () => {
      mockFetch.mockResolvedValue(
        failResponse(500, { error: "X", message: "m" }, { "x-request-id": "req-77" }),
      );
      await expect(api.getMe()).rejects.toBeInstanceOf(ApiClientError);
      expectConsole("warn", /API error.*"status":500.*"reqId":"req-77"/);
    });

    it("runs the session-expiry callback after the error body is read, once", async () => {
      const calls: string[] = [];
      const cb = createApiClient({ host: "host.test:8443", token: "t" }, () => calls.push("cb"));
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => {
          calls.push("body");
          return Promise.resolve({ error: "UNAUTHORIZED", message: "expired" });
        },
        headers: new Headers(),
      });
      await expect(cb.getMe()).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /API error/);
      expect(calls).toEqual(["body", "cb"]);
    });
  });

  describe("serverErrorCopy", () => {
    it.each([
      ["TLS_CERT_UNVERIFIED", "x", "error.tlsFailed"],
      ["AUTH_BUSY", "x", "error.authBusy"],
      ["RATE_LIMITED", "something else", "error.rateLimited"],
      ["NOT_FOUND", "x", "error.notFound"],
      ["BANNED", "x", "error.banned"],
      ["SERVICE_UNAVAILABLE", "x", "error.unavailable"],
      ["BAD_GATEWAY", "x", "error.unavailable"],
      ["STORAGE_QUOTA_EXCEEDED", "x", "error.storageQuota"],
      ["STORAGE_LOW_DISK", "x", "error.storageLowDisk"],
      ["STORAGE_ERROR", "x", "error.storageError"],
      ["GIF_DISABLED", "x", "error.gifDisabled"],
      ["LAST_ROLE", "x", "error.lastRole"],
      ["PUSH_DISABLED", "x", "error.pushDisabled"],
    ] as const)("%s maps to %s copy", (code, message, key) => {
      expect(serverErrorCopy(code, message)).toBe(connectText(key));
    });

    it("maps the server's request timeout to the send-status copy", () => {
      expect(serverErrorCopy("REQUEST_TIMEOUT", "x")).toBe(
        messageStatusText("send.requestTimeout"),
      );
    });

    it("gives every plain code its own sentence", () => {
      const codes = [
        "TLS_CERT_UNVERIFIED",
        "AUTH_BUSY",
        "NOT_FOUND",
        "BANNED",
        "SERVICE_UNAVAILABLE",
        "STORAGE_QUOTA_EXCEEDED",
        "STORAGE_LOW_DISK",
        "STORAGE_ERROR",
        "GIF_DISABLED",
        "LAST_ROLE",
        "PUSH_DISABLED",
      ];
      const copies = codes.map((c) => serverErrorCopy(c, "x"));
      expect(copies.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
      expect(new Set(copies).size).toBe(codes.length);
    });

    it("has no copy for an unknown code", () => {
      expect(serverErrorCopy("SOMETHING_NEW", "x")).toBeNull();
      expect(serverErrorCopy("", "x")).toBeNull();
    });

    describe("UNAUTHORIZED", () => {
      it("maps a refused sign-in", () => {
        expect(serverErrorCopy("UNAUTHORIZED", "invalid credentials")).toBe(
          connectText("error.invalidCredentials"),
        );
      });

      it.each([
        "session has expired",
        "invalid or expired session",
        "missing or invalid authorization header",
        "not authenticated",
      ])("maps the expired-session message %j", (message) => {
        expect(serverErrorCopy("UNAUTHORIZED", message)).toBe(connectText("error.unauthorized"));
      });

      it("keeps the server's sentence for anything else", () => {
        expect(serverErrorCopy("UNAUTHORIZED", "invalid code")).toBeNull();
        expect(serverErrorCopy("UNAUTHORIZED", "")).toBeNull();
      });
    });

    describe("FORBIDDEN", () => {
      it("maps a suspension", () => {
        expect(serverErrorCopy("FORBIDDEN", "your account has been suspended")).toBe(
          connectText("error.banned"),
        );
      });

      it.each([
        "missing manage_roles permission",
        "Missing Permission",
        "insufficient permissions",
        "manage server permission required",
        "admin role required",
        "access denied",
        "Access Denied",
      ])("maps the permission refusal %j", (message) => {
        expect(serverErrorCopy("FORBIDDEN", message)).toBe(connectText("error.forbidden"));
      });

      it.each([
        "account is awaiting approval",
        "permission required for this, sorry",
        "role required here",
        "access denied for now",
        "the access denied page",
        "unmissing permissions",
        "no access denied",
      ])("keeps the server's sentence for %j", (message) => {
        expect(serverErrorCopy("FORBIDDEN", message)).toBeNull();
      });
    });

    describe("auth-slice sentences", () => {
      const slice: ReadonlyArray<readonly [string, string]> = [
        ["account temporarily locked due to too many failed attempts", "error.accountLocked"],
        ["recovery temporarily locked due to too many failed attempts", "error.recoveryLocked"],
        ["too many failed attempts, try again later", "error.tooManyAttempts"],
        ["registration queue is full, try again later", "error.registrationQueueFull"],
        [
          "too many registrations from this address, try again later",
          "error.registrationRateLimited",
        ],
        ["too many authentication attempts in progress, try again later", "error.authBusy"],
        ["too many recovery credentials issued; try again later", "error.recoveryCredentialBudget"],
        ["login temporarily unavailable", "error.loginUnavailable"],
        ["failed to load authentication policy", "error.couldNotComplete"],
        ["failed to process registration", "error.couldNotComplete"],
        ["failed to load registration policy", "error.registrationUnavailable"],
        ["registration failed — please try again", "error.registrationFailed"],
        ["failed to create session", "error.sessionFailed"],
        ["registration succeeded but user fetch failed", "error.registeredSignInFailed"],
        ["failed to start two-factor challenge", "error.totpUnavailable"],
        ["failed to verify two-factor code", "error.totpUnavailable"],
        ["two-factor verification temporarily unavailable", "error.totpUnavailable"],
        ["failed to logout", "error.logoutFailed"],
        ["failed to delete account", "error.deleteAccountFailed"],
        ["failed to generate two-factor secret", "error.totpEnableFailed"],
        ["failed to stage two-factor enrolment", "error.totpEnableFailed"],
        ["failed to enable two-factor authentication", "error.totpEnableFailed"],
        ["failed to disable two-factor authentication", "error.totpDisableFailed"],
        ["failed to issue recovery codes", "error.recoveryCodesFailed"],
        ["recovery failed — please try again", "error.recoveryFailed"],
        ["failed to issue the recovery kit", "error.recoveryKitFailed"],
        ["failed to issue the recovery credential", "error.recoveryCredentialFailed"],
      ];

      it.each(slice)("RATE_LIMITED %j", (message, key) => {
        expect(serverErrorCopy("RATE_LIMITED", message)).toBe(
          connectText(key as Parameters<typeof connectText>[0]),
        );
      });

      it.each(["INTERNAL", "INTERNAL_ERROR"])("%s carries the same sentences", (code) => {
        for (const [message, key] of slice) {
          expect(serverErrorCopy(code, message)).toBe(
            connectText(key as Parameters<typeof connectText>[0]),
          );
        }
      });

      it.each(["INTERNAL", "INTERNAL_ERROR"])("%s has no copy for other messages", (code) => {
        expect(serverErrorCopy(code, "disk exploded")).toBeNull();
      });

      it("gives every sentence its own copy", () => {
        const copies = new Set(slice.map(([m]) => serverErrorCopy("INTERNAL", m)));
        expect(copies.has(null)).toBe(false);
        expect(copies.size).toBe(new Set(slice.map(([, k]) => k)).size);
      });
    });
  });

  describe("serverErrorText", () => {
    it("prefers catalog copy over the server's message", () => {
      expect(serverErrorText("NOT_FOUND", "no such thing", "fb")).toBe(
        connectText("error.notFound"),
      );
    });

    it("capitalises only the first letter of an unmapped message", () => {
      expect(serverErrorText("CONFLICT", "name already exists", "fb")).toBe("Name already exists");
      expect(serverErrorText("CONFLICT", "iPhone case", "fb")).toBe("IPhone case");
      expect(serverErrorText("CONFLICT", "x", "fb")).toBe("X");
    });

    it("falls back when the unmapped message is empty", () => {
      expect(serverErrorText("CONFLICT", "", "fallback")).toBe("fallback");
    });

    it.each(["INTERNAL", "INTERNAL_ERROR"])(
      "%s with an unmapped message shows the caller's fallback",
      (code) => {
        expect(serverErrorText(code, "stack trace here", "fallback")).toBe("fallback");
      },
    );
  });

  describe("errorText", () => {
    it("shows the connect-timeout copy for a transport failure", () => {
      expect(errorText(new TransportError("raw"), "fb")).toBe(
        connectText("session.connectTimeout"),
      );
    });

    it("maps an ApiClientError through its code", () => {
      expect(errorText(new ApiClientError(404, "NOT_FOUND", "gone"), "fb")).toBe(
        connectText("error.notFound"),
      );
      expect(errorText(new ApiClientError(409, "CONFLICT", "name taken"), "fb")).toBe("Name taken");
      expect(errorText(new ApiClientError(500, "INTERNAL", "boom"), "fb")).toBe("fb");
    });

    it("uses the message of any other Error, and the fallback otherwise", () => {
      expect(errorText(new Error("plain"), "fb")).toBe("plain");
      expect(errorText("not an error", "fb")).toBe("fb");
      expect(errorText(undefined, "fb")).toBe("fb");
    });
  });
});
