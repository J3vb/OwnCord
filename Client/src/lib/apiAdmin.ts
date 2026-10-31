// REST calls for moderation: channel and category management, members and the moderation queue.

import type {
  ChannelType,
  ChannelResponse,
  ForumSettingsBody,
  ChannelCategory,
  AdminUser,
} from "./types";
import type { BanMemberResponse } from "./apiShared";
import type { ApiTransport } from "./apiShared";

/** The moderation calls of the REST client. */
export function createAdminApi(t: ApiTransport) {
  return {
    // ── Admin: Channels ──────────────────────────────────────
    // These ride /api/v1/moderation/channels, not /admin/api, for the same
    // reason as the member calls below (admin.NewChannelAPI).

    adminCreateChannel(
      data: {
        name: string;
        type: ChannelType;
        /**
         * The category's id, 0 for none. It wins over `category`
         * when both are sent; a server without channel categories ignores it.
         */
        category_id?: number;
        /** The category name (legacy): matched ignoring case, created when new, "" = none. */
        category?: string;
        topic?: string;
        position?: number;
      },
      signal?: AbortSignal,
    ): Promise<ChannelResponse> {
      return t.channelRequest<ChannelResponse>("POST", "", data, signal);
    },

    adminUpdateChannel(
      id: number,
      data: {
        name?: string;
        topic?: string;
        // Moving a channel between categories is an edit; an omitted field
        // keeps the channel's current category server-side. `category_id` (0 =
        // none) wins over the legacy `category` name when both are sent.
        category_id?: number;
        category?: string;
        slow_mode?: number;
        position?: number;
        archived?: boolean;
        /**
         * Age-restriction label. The server withholds a labelled channel's
         * content from anyone who has not acknowledged it; clearing
         * the label drops every acknowledgement.
         */
        nsfw?: boolean;
        /**
         * Voice capacity limits (0 = unlimited), enforced by the server on
         * join. Omit them on a text channel rather than sending 0 — every
         * field the body leaves out keeps its stored value.
         */
        voice_max_users?: number;
        voice_max_video?: number;
        /**
         * A voice channel's join password: omitted keeps it, "" removes it,
         * anything else (1 to 64 characters) sets or changes it. Never read
         * back: responses carry only `password_protected`.
         */
        password?: string;
      },
      signal?: AbortSignal,
    ): Promise<ChannelResponse> {
      return t.channelRequest<ChannelResponse>("PATCH", `/${id}`, data, signal);
    },

    /**
     * Replace a forum's tags and settings: the whole list, tags with
     * their ids so a rename keeps a tag on its posts. The server answers with
     * the channel and broadcasts `channel_update`, which is how the app learns.
     */
    adminUpdateForumSettings(
      id: number,
      data: ForumSettingsBody,
      signal?: AbortSignal,
    ): Promise<ChannelResponse> {
      return t.channelRequest<ChannelResponse>("PUT", `/${id}/forum`, data, signal);
    },

    adminDeleteChannel(id: number, signal?: AbortSignal): Promise<void> {
      return t.channelRequest<void>("DELETE", `/${id}`, undefined, signal);
    },

    // ── Admin: Channel categories ──────────────────
    // The list itself arrives over the socket (ready.categories and the
    // channel_categories event), so there is no GET here.

    /** Create a category, appended last. 409 CATEGORY_NAME_TAKEN on a duplicate name. */
    adminCreateCategory(name: string, signal?: AbortSignal): Promise<ChannelCategory> {
      return t.channelRequest<ChannelCategory>("POST", "/categories", { name }, signal);
    },

    /** Rename a category: every channel in it follows. 409 CATEGORY_NAME_TAKEN, 404 when gone. */
    adminRenameCategory(id: number, name: string, signal?: AbortSignal): Promise<ChannelCategory> {
      return t.channelRequest<ChannelCategory>("PATCH", `/categories/${id}`, { name }, signal);
    },

    /** Delete a category. Its channels are not deleted: they become uncategorized. */
    adminDeleteCategory(id: number, signal?: AbortSignal): Promise<void> {
      return t.channelRequest<void>("DELETE", `/categories/${id}`, undefined, signal);
    },

    /**
     * Put the categories in `ids` order. `ids` must be exactly the server's
     * current set: anything else is refused with 409 CATEGORY_LIST_STALE and
     * nothing is written.
     */
    adminReorderCategories(
      ids: readonly number[],
      signal?: AbortSignal,
    ): Promise<readonly ChannelCategory[]> {
      return t.channelRequest<readonly ChannelCategory[]>(
        "PUT",
        "/categories/order",
        { ids },
        signal,
      );
    },

    // ── Members (moderation) ────────────────────────────────
    // These ride /api/v1/moderation/members, not /admin/api: a reverse proxy in
    // front of a server may answer /admin with a web page. The server runs the
    // same handlers and rank checks on both (admin.NewMemberAPI).

    adminKickMember(userId: number, signal?: AbortSignal): Promise<void> {
      return t.memberRequest<void>("DELETE", `/${userId}/sessions`, undefined, signal);
    },

    /**
     * Ban a member. `deleteMessageSeconds` (0-604800) also deletes their recent
     * messages and is sent only above 0. The result carries `purge` only when a
     * server that supports the field acted on it; an older server ignores the
     * field and answers without one. A role change is never combined with it.
     */
    adminBanMember(
      userId: number,
      reason?: string,
      durationHours?: number,
      signal?: AbortSignal,
      deleteMessageSeconds?: number,
    ): Promise<BanMemberResponse> {
      return t.memberRequest<BanMemberResponse>(
        "PATCH",
        `/${userId}`,
        {
          banned: true,
          ban_reason: reason ?? "",
          // Omitted/0 = permanent; otherwise the ban expires after this many hours.
          ...(durationHours !== undefined && durationHours > 0
            ? { ban_duration_hours: durationHours }
            : {}),
          ...(deleteMessageSeconds ? { delete_message_seconds: deleteMessageSeconds } : {}),
        },
        signal,
      );
    },

    adminChangeRole(userId: number, roleId: number, signal?: AbortSignal): Promise<void> {
      return t.memberRequest<void>(
        "PATCH",
        `/${userId}`,
        {
          role_id: roleId,
        },
        signal,
      );
    },

    /**
     * Give a member one more role (a server that advertises
     * `multi_role`). Same checks as `adminChangeRole`: MANAGE_ROLES, the actor's
     * top role outranks the member's, and the role sits below the actor's.
     * Answers 204; the roster changes on the `member_update` echo.
     */
    adminAddMemberRole(userId: number, roleId: number, signal?: AbortSignal): Promise<void> {
      return t.memberRequest<void>("PUT", `/${userId}/roles/${roleId}`, undefined, signal);
    },

    /**
     * Take one role away. Removing the member's last role is refused with 409
     * `LAST_ROLE`; otherwise the same checks and echo as `adminAddMemberRole`.
     */
    adminRemoveMemberRole(userId: number, roleId: number, signal?: AbortSignal): Promise<void> {
      return t.memberRequest<void>("DELETE", `/${userId}/roles/${roleId}`, undefined, signal);
    },

    /**
     * Lift a ban. The mirror of `adminBanMember`: the server broadcasts a
     * `member_join` for the unbanned user, which every client turns back into a
     * roster entry, so the roster needs no refreshing locally.
     */
    adminUnbanMember(userId: number, signal?: AbortSignal): Promise<void> {
      return t.memberRequest<void>("PATCH", `/${userId}`, { banned: false }, signal);
    },

    /**
     * The admin user page, which carries the ban state the roster cannot: a
     * banned member is removed from the roster entirely (MEMBER_BAN), so this
     * is the only way back to them. The server pages it (limit caps at 500,
     * ordered by ascending id), so this walks every page: one page alone would
     * hide a ban on any account past the first 500.
     */
    async adminListUsers(signal?: AbortSignal): Promise<AdminUser[]> {
      const pageSize = 500;
      const users: AdminUser[] = [];
      // ponytail: 200 pages (100k accounts) is a stop for a server that never
      // returns a short page, not a product limit; a banned-only server query
      // is the upgrade if the walk ever gets slow.
      for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
        const params = new URLSearchParams({
          limit: String(pageSize),
          offset: String(pageIndex * pageSize),
        });
        // oxlint-disable-next-line no-await-in-loop -- sequential paging: whether a next page exists depends on this one
        const page = await t.memberRequest<AdminUser[]>(
          "GET",
          `?${params.toString()}`,
          undefined,
          signal,
        );
        users.push(...page);
        if (page.length < pageSize) break;
      }
      return users;
    },
  };
}
