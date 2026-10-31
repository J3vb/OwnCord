import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/apiRequestsMocks";
import { createApiClient } from "../../../src/lib/api";
import {
  Api,
  okResponse,
  BASE,
  useRequestsClient,
  requestReaders,
} from "../../helpers/apiRequestsHarness";

vi.mock("@tauri-apps/plugin-http", () => mocks.pluginHttpMock());
vi.mock("@tauri-apps/api/event", () => mocks.apiEventMock());
vi.mock("../../../src/lib/net/httpProxy", () => mocks.netHttpProxyMock());

const { mockFetch } = mocks;

describe("REST client requests", () => {
  let api: Api;

  const { callUrl, callInit, callHeaders, callBody } = requestReaders(mockFetch);

  useRequestsClient(
    mocks,
    () => {
      vi.useRealTimers();
    },
    (client) => {
      api = client;
    },
  );

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
});
