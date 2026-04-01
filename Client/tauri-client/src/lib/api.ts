// Step 2.13 — REST API Client
// Uses Tauri's HTTP plugin fetch to bypass self-signed cert rejection in webview.

import { fetch } from "@tauri-apps/plugin-http";
import { createLogger } from "./logger";
import type {
  AuthResponse,
  RegisterResponse,
  HealthResponse,
  MessagesResponse,
  SearchResponse,
  ApiError,
  ChannelType,
  ChannelResponse,
  EmojiResponse,
  SoundResponse,
  InviteResponse,
  SessionResponse,
  UploadResponse,
  VoiceCredentialsResponse,
  MemberResponse,
  DmChannelsResponse,
  CreateDmResponse,
} from "./types";

/** Configuration for the API client. */
export interface ApiClientConfig {
  readonly host: string;
  readonly token?: string;
  /** Accept self-signed TLS certificates (for local/dev OwnCord servers). */
  readonly allowSelfSigned?: boolean;
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

const log = createLogger("api");

/** Create the REST API client. */
export function createApiClient(initialConfig: ApiClientConfig, onUnauthorized?: OnUnauthorized) {
  // eslint-disable-next-line consistent-function-scoping -- co-located with createApiClient for encapsulation
  function isValidHost(host: string): boolean {
    return /^[\w.-]+(:\d+)?$/.test(host) && host.length <= 253;
  }

  let config = { ...initialConfig };

  function baseUrl(): string {
    return `https://${config.host}/api/v1`;
  }

  function adminBaseUrl(): string {
    return `https://${config.host}/admin/api`;
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
    const init: RequestInit & {
      danger?: { acceptInvalidCerts: boolean; acceptInvalidHostnames: boolean };
    } = {
      method,
      headers: headers(),
      signal,
      ...(config.allowSelfSigned === true
        ? { danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false } }
        : {}),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    log.debug(`${label} →`, { method, path });

    let res: Response;
    try {
      res = await fetch(url, init as RequestInit);
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
      });
      throw new ApiClientError(res.status, err.error, err.message);
    }

    // 204 No Content
    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return doFetch<T>("API", baseUrl(), method, path, body, signal);
  }

  function adminRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return doFetch<T>("Admin API", adminBaseUrl(), method, path, body, signal);
  }

  // eslint-disable-next-line consistent-function-scoping -- co-located with doFetch for encapsulation
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
      const url = `${baseUrl()}/auth/verify-totp`;
      const init: RequestInit & {
        danger?: { acceptInvalidCerts: boolean; acceptInvalidHostnames: boolean };
      } = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${partialToken}`,
        },
        body: JSON.stringify({ code }),
        signal,
        ...(config.allowSelfSigned === true
          ? { danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false } }
          : {}),
      };

      let res: Response;
      try {
        res = await fetch(url, init as RequestInit);
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
      data: { username?: string; avatar?: string },
      signal?: AbortSignal,
    ): Promise<MemberResponse> {
      return request<MemberResponse>("PATCH", "/users/me", data, signal);
    },

    changePassword(
      currentPassword: string,
      newPassword: string,
      signal?: AbortSignal,
    ): Promise<void> {
      return request<void>(
        "PUT",
        "/users/me/password",
        { current_password: currentPassword, new_password: newPassword },
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

    getSessions(signal?: AbortSignal): Promise<SessionResponse[]> {
      return request<SessionResponse[]>("GET", "/users/me/sessions", undefined, signal);
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

    // ── File Uploads ──────────────────────────────────────

    async uploadFile(file: File, signal?: AbortSignal): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", file);

      const url = `${baseUrl()}/uploads`;
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
        ...(config.allowSelfSigned === true
          ? { danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false } }
          : {}),
      } as RequestInit);

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

    revokeInvite(inviteId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/invites/${inviteId}`, undefined, signal);
    },

    // ── Emoji ─────────────────────────────────────────────

    getEmoji(signal?: AbortSignal): Promise<EmojiResponse[]> {
      return request<EmojiResponse[]>("GET", "/emoji", undefined, signal);
    },

    deleteEmoji(emojiId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/emoji/${emojiId}`, undefined, signal);
    },

    // ── Sounds ────────────────────────────────────────────

    getSounds(signal?: AbortSignal): Promise<SoundResponse[]> {
      return request<SoundResponse[]>("GET", "/sounds", undefined, signal);
    },

    deleteSound(soundId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/sounds/${soundId}`, undefined, signal);
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

    /** Close a DM (hide from sidebar). */
    closeDm(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/dms/${channelId}`, undefined, signal);
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
        const res = await fetch(`https://${targetHost}/api/v1/health`, {
          signal: controller.signal,
          ...(config.allowSelfSigned === true
            ? { danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false } }
            : {}),
        } as RequestInit);
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
        slow_mode?: number;
        position?: number;
        archived?: boolean;
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

    adminBanMember(userId: number, reason?: string, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>(
        "PATCH",
        `/users/${userId}`,
        {
          banned: true,
          ban_reason: reason ?? "",
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
