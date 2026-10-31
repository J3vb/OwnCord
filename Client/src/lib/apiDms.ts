// REST calls for direct messages, voice and server health.

import type {
  DmChannelsResponse,
  CreateDmResponse,
  GroupDmResponse,
  BlockedUsersResponse,
  DmRequestListResponse,
  VoiceCredentialsResponse,
  HealthResponse,
  ServerInfoResponse,
} from "./types";
import { type DmRequestDecision, type DmRequestDecisionResult, ApiClientError } from "./apiShared";
import { SessionScope } from "./net/sessionScope";
import { ensureHttpProxy } from "./net/httpProxy";
import { desktop } from "../platform/desktop";
import type { ApiTransport } from "./apiShared";

/** The DM, voice and health calls of the REST client. */
export function createDmsApi(t: ApiTransport) {
  return {
    // ── Direct Messages ─────────────────────────────────────

    /** List user's open DM channels. */
    getDmChannels(signal?: AbortSignal): Promise<DmChannelsResponse> {
      return t.request<DmChannelsResponse>("GET", "/dms", undefined, signal);
    },

    /** Create or get a DM channel with a user. */
    createDm(recipientId: number, signal?: AbortSignal): Promise<CreateDmResponse> {
      return t.request<CreateDmResponse>("POST", "/dms", { recipient_id: recipientId }, signal);
    },

    /** Create a group DM with 2..8 other users (3..10 total). */
    createGroupDm(
      recipientIds: readonly number[],
      name?: string,
      signal?: AbortSignal,
    ): Promise<GroupDmResponse> {
      return t.request<GroupDmResponse>(
        "POST",
        "/dms/group",
        { recipient_ids: [...recipientIds], name: name ?? "" },
        signal,
      );
    },

    /** Set or clear a group DM's name. Any participant may; 1:1 DMs refuse. */
    renameGroupDm(channelId: number, name: string, signal?: AbortSignal): Promise<GroupDmResponse> {
      return t.request<GroupDmResponse>("PATCH", `/dms/${channelId}`, { name }, signal);
    },

    /**
     * Add people to a group DM. Any member may; the group holds at
     * most 10. 200 carries the summary; 204 means the summary read failed after
     * the commit, and the dm_channel_open that follows carries the state.
     */
    addGroupDmMembers(
      channelId: number,
      userIds: readonly number[],
      signal?: AbortSignal,
    ): Promise<GroupDmResponse | undefined> {
      return t.request<GroupDmResponse | undefined>(
        "POST",
        `/dms/${channelId}/members`,
        { user_ids: [...userIds] },
        signal,
      );
    },

    /**
     * Set a group DM's icon: multipart `file`, PNG/JPEG/WebP, max
     * 1 MB and 1024x1024, any member. 200 carries the summary; 204 means the
     * summary read failed after the commit and the dm_channel_open that follows
     * carries the state.
     */
    uploadGroupDmIcon(
      channelId: number,
      file: File,
      signal?: AbortSignal,
    ): Promise<GroupDmResponse | undefined> {
      const formData = new FormData();
      formData.append("file", file);
      return t.request<GroupDmResponse | undefined>(
        "POST",
        `/dms/${channelId}/icon`,
        formData,
        signal,
        { multipart: true },
      );
    },

    /** Remove a group DM's icon. Any member; a no-op when none is set. 200 carries the summary, 204 none. */
    removeGroupDmIcon(
      channelId: number,
      signal?: AbortSignal,
    ): Promise<GroupDmResponse | undefined> {
      return t.request<GroupDmResponse | undefined>(
        "DELETE",
        `/dms/${channelId}/icon`,
        undefined,
        signal,
      );
    },

    /** Remove another member from a group DM. Owner only; removing yourself is a leave (closeDm). */
    removeGroupDmMember(channelId: number, userId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>("DELETE", `/dms/${channelId}/members/${userId}`, undefined, signal);
    },

    /** Hand a group DM to another member. Owner only. 200 carries the summary, 204 none. */
    setGroupDmOwner(
      channelId: number,
      userId: number,
      signal?: AbortSignal,
    ): Promise<GroupDmResponse | undefined> {
      return t.request<GroupDmResponse | undefined>(
        "PUT",
        `/dms/${channelId}/owner`,
        { user_id: userId },
        signal,
      );
    },

    /**
     * Remove a DM from the sidebar. For a 1:1 this only hides it — the next
     * message from either side brings it back. For a group it is a *leave*:
     * the caller comes out of the participant list and cannot return unaided.
     */
    closeDm(channelId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>("DELETE", `/dms/${channelId}`, undefined, signal);
    },

    /** List recipient user IDs the current user has blocked. */
    listBlocks(signal?: AbortSignal): Promise<BlockedUsersResponse> {
      return t.request<BlockedUsersResponse>("GET", "/blocks", undefined, signal);
    },

    /** The pending Message Requests inbox. */
    listDmRequests(signal?: AbortSignal): Promise<DmRequestListResponse> {
      return t.request<DmRequestListResponse>("GET", "/dm-requests", undefined, signal);
    },

    /** Decide a pending Message Request. 409: no longer pending; 404: not the caller's. */
    decideDmRequest(
      id: number,
      decision: DmRequestDecision,
      signal?: AbortSignal,
    ): Promise<DmRequestDecisionResult> {
      return t.request<DmRequestDecisionResult>(
        "POST",
        `/dm-requests/${id}/${decision}`,
        undefined,
        signal,
      );
    },

    /** Block a user (prevents DMs in both directions). */
    blockUser(userId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>("PUT", `/blocks/${userId}`, undefined, signal);
    },

    /** Unblock a previously blocked user. */
    unblockUser(userId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>("DELETE", `/blocks/${userId}`, undefined, signal);
    },

    // ── Voice ─────────────────────────────────────────────

    getVoiceCredentials(signal?: AbortSignal): Promise<VoiceCredentialsResponse> {
      return t.request<VoiceCredentialsResponse>("GET", "/voice/credentials", undefined, signal);
    },

    // ── Health ────────────────────────────────────────────

    async getHealth(
      host?: string,
      timeoutMs = 3000,
      signal?: AbortSignal,
    ): Promise<HealthResponse> {
      // Explicit-host checks belong to the server picker, independently of the
      // signed-in server. Its page supplies cancellation; current-server checks
      // additionally belong to the authenticated session.
      const targetHost = host ?? t.config.host;
      const owner =
        host === undefined
          ? t.session.fork(signal)
          : new SessionScope(
              { host: targetHost, generation: t.generation },
              signal ? [signal] : [],
            );
      const transport = new AbortController();
      const releaseTransport = owner.addCleanup(() => transport.abort());
      const timer = setTimeout(() => owner.dispose(), timeoutMs);
      try {
        owner.assertCurrent();
        const origin = await owner.run(ensureHttpProxy(targetHost));
        owner.assertCurrent();
        const res = await owner.run(
          desktop.http.fetch(`${origin}/api/v1/health`, { signal: transport.signal }),
        );
        owner.assertCurrent();
        if (!res.ok) {
          // i18n-exempt: internal ApiClientError diagnostic; the connect page shows a fixed status, not this message
          throw new ApiClientError(res.status, "HEALTH_CHECK_FAILED", "Health check failed");
        }
        const data = await owner
          .run(res.json() as Promise<HealthResponse>)
          .finally(releaseTransport);
        owner.assertCurrent();
        return data;
      } finally {
        clearTimeout(timer);
        owner.dispose();
      }
    },

    async getServerInfo(
      host?: string,
      timeoutMs = 3000,
      signal?: AbortSignal,
    ): Promise<ServerInfoResponse> {
      // Same explicit-host shape as getHealth: the connect page probes every
      // saved profile independently of the signed-in server. Registration
      // checks read through this method rather than inventing a second transport.
      const targetHost = host ?? t.config.host;
      const owner =
        host === undefined
          ? t.session.fork(signal)
          : new SessionScope(
              { host: targetHost, generation: t.generation },
              signal ? [signal] : [],
            );
      const transport = new AbortController();
      const releaseTransport = owner.addCleanup(() => transport.abort());
      const timer = setTimeout(() => owner.dispose(), timeoutMs);
      try {
        owner.assertCurrent();
        const origin = await owner.run(ensureHttpProxy(targetHost));
        owner.assertCurrent();
        const res = await owner.run(
          desktop.http.fetch(`${origin}/api/v1/server-info`, { signal: transport.signal }),
        );
        owner.assertCurrent();
        if (!res.ok) {
          // i18n-exempt: internal ApiClientError diagnostic; the connect page shows a fixed status, not this message
          throw new ApiClientError(res.status, "SERVER_INFO_FAILED", "Server info check failed");
        }
        const data = await owner
          .run(res.json() as Promise<ServerInfoResponse>)
          .finally(releaseTransport);
        owner.assertCurrent();
        return data;
      } finally {
        clearTimeout(timer);
        owner.dispose();
      }
    },
  };
}
