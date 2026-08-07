// Step 2.13 — REST API Client
// Uses Tauri's HTTP plugin fetch to bypass self-signed cert rejection in webview.

import { fetch } from "@tauri-apps/plugin-http";
import { createLogger } from "./logger";
import { ensureHttpProxy } from "./httpProxy";
import type {
  AuthResponse,
  RegisterResponse,
  HealthResponse,
  MessagesResponse,
  MessagesAroundResponse,
  ReactionUsersResponse,
  PurgeResponse,
  SearchResponse,
  ApiError,
  ChannelType,
  ChannelResponse,
  EmojiResponse,
  InviteResponse,
  UploadResponse,
  VoiceCredentialsResponse,
  MemberResponse,
  DmChannelsResponse,
  CreateDmResponse,
  GroupDmResponse,
  BlockedUsersResponse,
  GifSearchResponse,
} from "./types";

/** Configuration for the API client. */
export interface ApiClientConfig {
  readonly host: string;
  readonly token?: string;
}

/** API client error with parsed error body. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

export type OnUnauthorized = () => void;

/**
 * Single session object from GET /users/me/sessions, matching the server's
 * wire shape (Server/api/profile_handler.go's sessionResponse, wrapped in a
 * `{sessions: [...]}` envelope — docs/api.md). Defined here, next to its only
 * consumer, rather than in `./types`: the declaration that used to live there
 * had drifted from the actual contract (it declared `ip_address`/`expires_at`,
 * which the server never sends, and omitted `ip`/`is_current`, which it always
 * does), and nothing else needs this shape.
 */
export interface SessionInfo {
  readonly id: number;
  /** Never null: the server's fields are plain Go strings, so an unknown
   *  device or address arrives as "" rather than being omitted. */
  readonly device: string;
  readonly ip: string;
  readonly created_at: string;
  readonly last_used: string;
  readonly is_current: boolean;
}

interface SessionsListResponse {
  readonly sessions: SessionInfo[];
}

const log = createLogger("api");

/** Create the REST API client. */
export function createApiClient(initialConfig: ApiClientConfig, onUnauthorized?: OnUnauthorized) {
  // oxlint-disable-next-line consistent-function-scoping -- co-located with createApiClient for encapsulation
  function isValidHost(host: string): boolean {
    return /^[\w.-]+(:\d+)?$/.test(host) && host.length <= 253;
  }

  let config = { ...initialConfig };

  // REST traffic is tunneled through the Rust HTTP TOFU proxy: instead of
  // hitting https://{host} directly (which used to require accepting invalid
  // certs), we hit http://127.0.0.1:{port} where the proxy pins the server
  // certificate to the same trust-on-first-use fingerprint as the WS proxy.
  async function baseUrl(): Promise<string> {
    return `${await ensureHttpProxy(config.host)}/api/v1`;
  }

  async function adminBaseUrl(): Promise<string> {
    return `${await ensureHttpProxy(config.host)}/admin/api`;
  }

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.token) {
      h["Authorization"] = `Bearer ${config.token}`;
    }
    return h;
  }

  async function doFetch<T>(
    label: string,
    urlBase: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${urlBase}${path}`;
    const init: RequestInit = {
      method,
      headers: headers(),
      signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    log.debug(`${label} →`, { method, path });

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (fetchErr) {
      log.error(`${label} fetch failed`, { method, path, error: String(fetchErr) });
      if (fetchErr instanceof Error) {
        throw fetchErr;
      }
      throw new Error(typeof fetchErr === "string" ? fetchErr : String(fetchErr), {
        cause: fetchErr,
      });
    }

    log.debug(`${label} ←`, { method, path, status: res.status });

    if (res.status === 401) {
      onUnauthorized?.();
      const err = await parseError(res);
      throw new ApiClientError(401, err.error, err.message);
    }

    if (!res.ok) {
      const err = await parseError(res);
      log.warn(`${label} error`, {
        method,
        path,
        status: res.status,
        code: err.error,
        message: err.message,
        // Server echoes its request ID in this header — logging it lets a
        // client-side failure be matched to the server's log line for it.
        reqId: res.headers.get("x-request-id") ?? undefined,
      });
      throw new ApiClientError(res.status, err.error, err.message);
    }

    // 204 No Content
    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return doFetch<T>("API", await baseUrl(), method, path, body, signal);
  }

  async function adminRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return doFetch<T>("Admin API", await adminBaseUrl(), method, path, body, signal);
  }

  // oxlint-disable-next-line consistent-function-scoping -- co-located with doFetch for encapsulation
  async function parseError(res: Response): Promise<ApiError> {
    try {
      const body = await res.json();
      return {
        error: body.error ?? "UNKNOWN",
        message: body.message ?? res.statusText,
      };
    } catch {
      return {
        error: "UNKNOWN",
        message: res.statusText,
      };
    }
  }

  return {
    /** Update the client config (e.g., after login). */
    setConfig(newConfig: Partial<ApiClientConfig>): void {
      if (newConfig.host !== undefined && !isValidHost(newConfig.host)) {
        log.error("setConfig rejected invalid host", { host: newConfig.host });
        throw new Error("Invalid host format");
      }
      config = { ...config, ...newConfig };
    },

    /** Get current config (for debugging). Token is redacted. */
    getConfig(): Readonly<ApiClientConfig> {
      return { ...config, token: config.token ? "[redacted]" : undefined };
    },

    // ── Auth ──────────────────────────────────────────────

    login(username: string, password: string, signal?: AbortSignal): Promise<AuthResponse> {
      return request<AuthResponse>("POST", "/auth/login", { username, password }, signal);
    },

    register(
      username: string,
      password: string,
      inviteCode: string,
      signal?: AbortSignal,
    ): Promise<RegisterResponse> {
      return request<RegisterResponse>(
        "POST",
        "/auth/register",
        { username, password, invite_code: inviteCode },
        signal,
      );
    },

    logout(signal?: AbortSignal): Promise<void> {
      return request<void>("POST", "/auth/logout", undefined, signal);
    },

    async verifyTotp(
      code: string,
      partialToken: string,
      signal?: AbortSignal,
    ): Promise<AuthResponse> {
      // Don't mutate shared config — make direct fetch with the partial token
      const url = `${await baseUrl()}/auth/verify-totp`;
      const init: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${partialToken}`,
        },
        body: JSON.stringify({ code }),
        signal,
      };

      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (fetchErr) {
        log.error("API fetch failed", {
          method: "POST",
          path: "/auth/verify-totp",
          error: String(fetchErr),
        });
        if (fetchErr instanceof Error) {
          throw fetchErr;
        }
        throw new Error(typeof fetchErr === "string" ? fetchErr : String(fetchErr), {
          cause: fetchErr,
        });
      }

      if (res.status === 401) {
        onUnauthorized?.();
        const err = await parseError(res);
        throw new ApiClientError(401, err.error, err.message);
      }

      if (!res.ok) {
        const err = await parseError(res);
        throw new ApiClientError(res.status, err.error, err.message);
      }

      return res.json() as Promise<AuthResponse>;
    },

    deleteAccount(password: string, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", "/auth/account", { password }, signal);
    },

    // ── Users ─────────────────────────────────────────────

    getMe(signal?: AbortSignal): Promise<MemberResponse> {
      return request<MemberResponse>("GET", "/users/me", undefined, signal);
    },

    updateProfile(
      data: {
        username?: string;
        avatar?: string;
        identity_public_key?: string;
        /** Omit to leave unchanged; "" clears the field. */
        display_name?: string;
        about?: string;
      },
      signal?: AbortSignal,
    ): Promise<MemberResponse> {
      return request<MemberResponse>("PATCH", "/users/me", data, signal);
    },

    /**
     * Upload an avatar image (PNG/JPEG/WebP, max 1 MB, max 1024x1024).
     *
     * Multipart rather than JSON for the same reason attachments are, and it
     * shares uploadFile's shape: no Content-Type header (the browser has to
     * set the multipart boundary) and the bearer token attached by hand.
     * On success the server has already pointed the user's avatar at the
     * served file and broadcast a user_update.
     */
    async uploadAvatar(file: File, signal?: AbortSignal): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", file);

      const url = `${await baseUrl()}/users/me/avatar`;
      const h: Record<string, string> = {};
      if (config.token) {
        h["Authorization"] = `Bearer ${config.token}`;
      }

      const res = await fetch(url, { method: "POST", headers: h, body: formData, signal });

      if (res.status === 401) {
        onUnauthorized?.();
        const err = await parseError(res);
        throw new ApiClientError(401, err.error, err.message);
      }
      if (!res.ok) {
        const err = await parseError(res);
        throw new ApiClientError(res.status, err.error, err.message);
      }
      return res.json() as Promise<UploadResponse>;
    },

    changePassword(
      currentPassword: string,
      newPassword: string,
      signal?: AbortSignal,
    ): Promise<void> {
      return request<void>(
        "PUT",
        "/users/me/password",
        { old_password: currentPassword, new_password: newPassword },
        signal,
      );
    },

    enableTotp(
      password: string,
      signal?: AbortSignal,
    ): Promise<{ qr_uri: string; backup_codes: string[] }> {
      return request("POST", "/users/me/totp/enable", { password }, signal);
    },

    confirmTotp(password: string, code: string, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", "/users/me/totp/confirm", { password, code }, signal);
    },

    disableTotp(password: string, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", "/users/me/totp", { password }, signal);
    },

    getSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
      return request<SessionsListResponse>("GET", "/users/me/sessions", undefined, signal).then(
        (r) => r.sessions,
      );
    },

    revokeSession(sessionId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/users/me/sessions/${sessionId}`, undefined, signal);
    },

    // ── Channels ──────────────────────────────────────────

    getMessages(
      channelId: number,
      options?: { before?: number; limit?: number },
      signal?: AbortSignal,
    ): Promise<MessagesResponse> {
      const params = new URLSearchParams();
      if (options?.before !== undefined) params.set("before", String(options.before));
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      return request<MessagesResponse>(
        "GET",
        `/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
        undefined,
        signal,
      );
    },

    /**
     * The window of history centred on `messageId`, for jumping to a message
     * outside the loaded page. Messages come back oldest-first (already in
     * render order) — see MessagesAroundResponse. 404 when the message does
     * not live in this channel or has been deleted.
     */
    getMessagesAround(
      channelId: number,
      messageId: number,
      options?: { limit?: number },
      signal?: AbortSignal,
    ): Promise<MessagesAroundResponse> {
      const params = new URLSearchParams();
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      return request<MessagesAroundResponse>(
        "GET",
        `/channels/${channelId}/messages/around/${messageId}${qs ? `?${qs}` : ""}`,
        undefined,
        signal,
      );
    },

    /**
     * Bulk-delete the newest `limit` messages in a channel (1-100). Requires
     * MANAGE_MESSAGES; the server broadcasts one chat_bulk_deleted event, so
     * the local store is updated by the dispatcher rather than here.
     */
    purgeMessages(
      channelId: number,
      limit: number,
      options?: { before?: number },
      signal?: AbortSignal,
    ): Promise<PurgeResponse> {
      return request<PurgeResponse>(
        "POST",
        `/channels/${channelId}/messages/purge`,
        { limit, ...(options?.before !== undefined ? { before: options.before } : {}) },
        signal,
      );
    },

    /**
     * The users who reacted to a message with one emoji, for the who-reacted
     * tooltip. Oldest reaction first, capped at 100 server-side. The emoji is a
     * path segment, so it must be percent-encoded.
     */
    getReactionUsers(
      channelId: number,
      messageId: number,
      emoji: string,
      signal?: AbortSignal,
    ): Promise<ReactionUsersResponse> {
      return request<ReactionUsersResponse>(
        "GET",
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/users`,
        undefined,
        signal,
      );
    },

    getPins(channelId: number, signal?: AbortSignal): Promise<MessagesResponse> {
      return request<MessagesResponse>("GET", `/channels/${channelId}/pins`, undefined, signal);
    },

    pinMessage(channelId: number, messageId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", `/channels/${channelId}/pins/${messageId}`, undefined, signal);
    },

    unpinMessage(channelId: number, messageId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/channels/${channelId}/pins/${messageId}`, undefined, signal);
    },

    // ── Search ────────────────────────────────────────────

    search(
      query: string,
      options?: { channelId?: number; limit?: number },
      signal?: AbortSignal,
    ): Promise<SearchResponse> {
      const params = new URLSearchParams({ q: query });
      if (options?.channelId !== undefined) params.set("channel_id", String(options.channelId));
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      return request<SearchResponse>("GET", `/search?${params.toString()}`, undefined, signal);
    },

    // ── GIFs ──────────────────────────────────────────────
    //
    // Proxied by the user's own server so the GIF provider API key never
    // ships in this bundle. A 503 GIF_DISABLED means the operator has not
    // configured a key — callers must degrade, not retry.

    gifSearch(query: string, limit: number, signal?: AbortSignal): Promise<GifSearchResponse> {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      return request<GifSearchResponse>(
        "GET",
        `/gif/search?${params.toString()}`,
        undefined,
        signal,
      );
    },

    gifTrending(limit: number, signal?: AbortSignal): Promise<GifSearchResponse> {
      const params = new URLSearchParams({ limit: String(limit) });
      return request<GifSearchResponse>(
        "GET",
        `/gif/trending?${params.toString()}`,
        undefined,
        signal,
      );
    },

    // ── File Uploads ──────────────────────────────────────

    async uploadFile(file: File, signal?: AbortSignal): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", file);

      const url = `${await baseUrl()}/uploads`;
      const h: Record<string, string> = {};
      if (config.token) {
        h["Authorization"] = `Bearer ${config.token}`;
      }
      // Don't set Content-Type — browser sets multipart boundary

      const res = await fetch(url, {
        method: "POST",
        headers: h,
        body: formData,
        signal,
      });

      if (res.status === 401) {
        onUnauthorized?.();
        const err = await parseError(res);
        throw new ApiClientError(401, err.error, err.message);
      }

      if (!res.ok) {
        const err = await parseError(res);
        throw new ApiClientError(res.status, err.error, err.message);
      }

      return res.json() as Promise<UploadResponse>;
    },

    // ── Invites ───────────────────────────────────────────

    getInvites(signal?: AbortSignal): Promise<InviteResponse[]> {
      return request<InviteResponse[]>("GET", "/invites", undefined, signal);
    },

    createInvite(
      data: { max_uses?: number; expires_in_hours?: number },
      signal?: AbortSignal,
    ): Promise<InviteResponse> {
      return request<InviteResponse>("POST", "/invites", data, signal);
    },

    revokeInvite(code: string, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/invites/${code}`, undefined, signal);
    },

    // ── Custom emoji ──────────────────────────────────────
    //
    // Reading is open to any member; upload and delete require MANAGE_SERVER
    // and are refused server-side with 403 regardless of what the UI offers.

    /** The server's whole custom-emoji set. */
    listEmoji(signal?: AbortSignal): Promise<EmojiResponse[]> {
      return request<EmojiResponse[]>("GET", "/emoji", undefined, signal);
    },

    /**
     * Upload one custom emoji. The image is validated server-side (PNG/JPEG/
     * GIF/WebP, at most 512 KB and 128x128), so the only thing this promises
     * is to send it; a rejection arrives as an ApiClientError with the reason.
     */
    async uploadEmoji(shortcode: string, file: File, signal?: AbortSignal): Promise<EmojiResponse> {
      const formData = new FormData();
      formData.append("shortcode", shortcode);
      formData.append("file", file);

      const url = `${await baseUrl()}/emoji`;
      const h: Record<string, string> = {};
      if (config.token) {
        h["Authorization"] = `Bearer ${config.token}`;
      }
      // Don't set Content-Type — browser sets multipart boundary

      const res = await fetch(url, { method: "POST", headers: h, body: formData, signal });

      if (res.status === 401) {
        onUnauthorized?.();
        const err = await parseError(res);
        throw new ApiClientError(401, err.error, err.message);
      }
      if (!res.ok) {
        const err = await parseError(res);
        throw new ApiClientError(res.status, err.error, err.message);
      }
      return res.json() as Promise<EmojiResponse>;
    },

    deleteEmoji(emojiId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/emoji/${emojiId}`, undefined, signal);
    },

    // ── Direct Messages ─────────────────────────────────────

    /** List user's open DM channels. */
    getDmChannels(signal?: AbortSignal): Promise<DmChannelsResponse> {
      return request<DmChannelsResponse>("GET", "/dms", undefined, signal);
    },

    /** Create or get a DM channel with a user. */
    createDm(recipientId: number, signal?: AbortSignal): Promise<CreateDmResponse> {
      return request<CreateDmResponse>("POST", "/dms", { recipient_id: recipientId }, signal);
    },

    /** Create a group DM with 2..8 other users (3..10 total). */
    createGroupDm(
      recipientIds: readonly number[],
      name?: string,
      signal?: AbortSignal,
    ): Promise<GroupDmResponse> {
      return request<GroupDmResponse>(
        "POST",
        "/dms/group",
        { recipient_ids: [...recipientIds], name: name ?? "" },
        signal,
      );
    },

    /** Set or clear a group DM's name. Any participant may; 1:1 DMs refuse. */
    renameGroupDm(channelId: number, name: string, signal?: AbortSignal): Promise<GroupDmResponse> {
      return request<GroupDmResponse>("PATCH", `/dms/${channelId}`, { name }, signal);
    },

    /**
     * Remove a DM from the sidebar. For a 1:1 this only hides it — the next
     * message from either side brings it back. For a group it is a *leave*:
     * the caller comes out of the participant list and cannot return unaided.
     */
    closeDm(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/dms/${channelId}`, undefined, signal);
    },

    /** List recipient user IDs the current user has blocked. */
    listBlocks(signal?: AbortSignal): Promise<BlockedUsersResponse> {
      return request<BlockedUsersResponse>("GET", "/blocks", undefined, signal);
    },

    /** Block a user (prevents DMs in both directions). */
    blockUser(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("PUT", `/blocks/${userId}`, undefined, signal);
    },

    /** Unblock a previously blocked user. */
    unblockUser(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/blocks/${userId}`, undefined, signal);
    },

    // ── Voice ─────────────────────────────────────────────

    getVoiceCredentials(signal?: AbortSignal): Promise<VoiceCredentialsResponse> {
      return request<VoiceCredentialsResponse>("GET", "/voice/credentials", undefined, signal);
    },

    // ── Health ────────────────────────────────────────────

    async getHealth(host?: string, timeoutMs = 3000): Promise<HealthResponse> {
      const targetHost = host ?? config.host;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const origin = await ensureHttpProxy(targetHost);
        const res = await fetch(`${origin}/api/v1/health`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new ApiClientError(res.status, "HEALTH_CHECK_FAILED", "Health check failed");
        }
        return res.json() as Promise<HealthResponse>;
      } finally {
        clearTimeout(timer);
      }
    },

    // ── Admin: Channels ──────────────────────────────────────

    adminCreateChannel(
      data: {
        name: string;
        type: ChannelType;
        category: string;
        topic?: string;
        position?: number;
      },
      signal?: AbortSignal,
    ): Promise<ChannelResponse> {
      return adminRequest<ChannelResponse>("POST", "/channels", data, signal);
    },

    adminUpdateChannel(
      id: number,
      data: {
        name?: string;
        topic?: string;
        // Moving a channel between categories is a rename of free text; an
        // omitted field keeps the channel's current category server-side.
        category?: string;
        slow_mode?: number;
        position?: number;
        archived?: boolean;
        /**
         * Age-restriction label. Stored, broadcast and audited by the server,
         * which applies no content behaviour of its own to a flagged channel.
         */
        nsfw?: boolean;
        /**
         * Voice capacity limits (0 = unlimited), enforced by the server on
         * join. Omit them on a text channel rather than sending 0 — every
         * field the body leaves out keeps its stored value.
         */
        voice_max_users?: number;
        voice_max_video?: number;
      },
      signal?: AbortSignal,
    ): Promise<ChannelResponse> {
      return adminRequest<ChannelResponse>("PATCH", `/channels/${id}`, data, signal);
    },

    adminDeleteChannel(id: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("DELETE", `/channels/${id}`, undefined, signal);
    },

    // ── Admin: Members ──────────────────────────────────────

    adminKickMember(userId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("DELETE", `/users/${userId}/sessions`, undefined, signal);
    },

    adminBanMember(
      userId: number,
      reason?: string,
      durationHours?: number,
      signal?: AbortSignal,
    ): Promise<void> {
      return adminRequest<void>(
        "PATCH",
        `/users/${userId}`,
        {
          banned: true,
          ban_reason: reason ?? "",
          // Omitted/0 = permanent; otherwise the ban expires after this many hours.
          ...(durationHours !== undefined && durationHours > 0
            ? { ban_duration_hours: durationHours }
            : {}),
        },
        signal,
      );
    },

    adminChangeRole(userId: number, roleId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>(
        "PATCH",
        `/users/${userId}`,
        {
          role_id: roleId,
        },
        signal,
      );
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
