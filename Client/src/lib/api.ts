// Step 2.13 — REST API Client
// Uses Tauri's HTTP plugin fetch to bypass self-signed cert rejection in webview.

import { desktop } from "../platform/desktop";
import { createLogger } from "./logger";
import { ensureHttpProxy } from "./httpProxy";
import { isValidHost } from "./hostValidation";
import { SessionScope } from "./sessionScope";
import {
  NSFW_ACKNOWLEDGEMENT_REQUIRED,
  nsfwContentBlocked,
} from "../features/content-consent/nsfw";
import { setNsfwAcknowledged } from "../stores/channels.store";
import type {
  AuthResponse,
  AdminUser,
  RegisterResponse,
  HealthResponse,
  ServerInfoResponse,
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
  DmRequestListResponse,
  GifSearchResponse,
  PartialSuccessResponse,
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
  /** A sign-in no other device has acknowledged yet. Listing the sessions
   *  acknowledges every row but the caller's own, so this is visible in
   *  exactly one listing per device. */
  readonly unseen: boolean;
}

/** DELETE /users/me/sessions: every session is revoked, the caller's included. */
export interface RevokeAllSessionsResponse {
  readonly sessions_revoked: number;
  readonly current_session_revoked: boolean;
}

/** POST /users/me/recovery-kit: `kit_secret` is present only when the server
 *  generated it, and it is shown exactly once. */
export interface RecoveryKitIssue {
  readonly kit_secret?: string;
  readonly created_at: string;
}

/** GET /users/me/recovery-kit: whether the account holds an unspent kit. */
export interface RecoveryKitStatus {
  readonly enrolled: boolean;
  readonly created_at?: string;
  readonly used_at: string | null;
}

/** One row of GET /users/me/moderation: the caller's own warning, timeout,
 *  removal or (lapsed) ban, read from the server's ledger, so it survives a
 *  restart. `id` is the `action_id` an appeal takes. Mirrors
 *  Server/api/moderation_handler.go's ownModerationActionResponse. */
export interface OwnModerationAction {
  readonly id: number;
  readonly kind: "warning" | "timeout" | "removal" | "ban";
  readonly reason: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly lifted_at: string | null;
  readonly acknowledged_at: string | null;
  /** An appealable kind with no appeal filed against it yet. */
  readonly appealable: boolean;
  /** The appeal filed against this row: its opaque public id and state. */
  readonly appeal: { readonly id: string; readonly state: AppealState } | null;
}

export type AppealState = "open" | "assigned" | "upheld" | "overturned" | "withdrawn";

/** One row of GET /appeals/mine: never the assignee or who decided it.
 *  Mirrors Server/api/appeal_handler.go's appealMineResponse. */
export interface MyAppeal {
  /** The opaque public id withdraw takes. */
  readonly id: string;
  /** The appealed action's kind, reason and time; all "" once that action is erased. */
  readonly action_kind: OwnModerationAction["kind"] | "";
  readonly action_reason: string;
  readonly action_created_at: string;
  readonly state: AppealState;
  /** Set only once the appeal is decided (upheld or overturned). */
  readonly decision_note: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}

interface SessionsListResponse {
  readonly sessions: SessionInfo[];
}

const log = createLogger("api");

/** Create the REST API client. */
export function createApiClient(initialConfig: ApiClientConfig, onUnauthorized?: OnUnauthorized) {
  let config: Readonly<ApiClientConfig> = Object.freeze({ ...initialConfig });
  let generation = 0;
  let session = new SessionScope({ host: config.host, generation });

  function replaceSession(nextConfig: ApiClientConfig): void {
    const previous = session;
    config = Object.freeze({ ...nextConfig });
    session = new SessionScope({ host: config.host, generation: ++generation });
    previous.dispose();
  }

  // Snapshot both destination and credentials BEFORE starting the native proxy.
  // Every path (including multipart, admin and TOTP) uses the same ownership
  // checks through response-body consumption. Native cancellation is best-effort;
  // SessionScope also rejects completions that arrive after a session switch.
  async function doFetch<T>(
    label: string,
    prefix: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    opts?: { skipUnauthorized?: boolean; token?: string; multipart?: boolean; detached?: boolean },
  ): Promise<T> {
    const snapshot = config;
    // A detached request is owned by its caller's signal alone, so ending the
    // session it was sent from does not cancel it.
    const owner = opts?.detached
      ? new SessionScope({ host: snapshot.host, generation }, signal ? [signal] : [])
      : session.fork(signal);
    // Tauri keeps abort listeners after a response body has been consumed.
    // Detach transport cancellation when that work settles, while still
    // disposing the logical request scope and all of its parent listeners.
    const transport = new AbortController();
    const releaseTransport = owner.addCleanup(() => transport.abort());
    try {
      owner.assertCurrent();
      const headers: Record<string, string> = {};
      if (!opts?.multipart) headers["Content-Type"] = "application/json";
      const token = opts?.token ?? snapshot.token;
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const init: RequestInit = { method, headers, signal: transport.signal };
      if (body !== undefined)
        init.body = opts?.multipart ? (body as FormData) : JSON.stringify(body);
      const origin = await owner.run(ensureHttpProxy(snapshot.host));
      owner.assertCurrent();
      log.debug(`${label} →`, { method, path });
      let res: Response;
      try {
        res = await owner.run(desktop.http.fetch(`${origin}${prefix}${path}`, init));
      } catch (fetchErr) {
        owner.assertCurrent();
        log.error(`${label} fetch failed`, { method, path, error: String(fetchErr) });
        if (fetchErr instanceof Error) throw fetchErr;
        throw new Error(String(fetchErr), { cause: fetchErr });
      }
      owner.assertCurrent();
      log.debug(`${label} ←`, { method, path, status: res.status });
      if (!res.ok) {
        const err = await owner.run(parseError(res)).finally(releaseTransport);
        owner.assertCurrent();
        if (res.status === 401 && !opts?.skipUnauthorized) {
          // Parse first: the session can change while the error body is arriving.
          // This callback is allowed to synchronously dispose the current session.
          onUnauthorized?.();
        }
        log.warn(`${label} error`, {
          method,
          path,
          status: res.status,
          code: err.error,
          message: err.message,
          reqId: res.headers.get("x-request-id") ?? undefined,
        });
        throw new ApiClientError(res.status, err.error, err.message);
      }
      if (res.status === 204) {
        releaseTransport();
        return undefined as T;
      }
      const data = await owner.run(res.json() as Promise<T>).finally(releaseTransport);
      owner.assertCurrent();
      return data;
    } finally {
      owner.dispose();
    }
  }

  function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    opts?: { skipUnauthorized?: boolean; token?: string; multipart?: boolean; detached?: boolean },
  ): Promise<T> {
    return doFetch<T>("API", "/api/v1", method, path, body, signal, opts);
  }

  /**
   * A content read from one channel, admitted only with NSFW consent (B9-7):
   * refused locally, with the server's own error, before any request while
   * the channel is gated, and discarded if consent was withdrawn while it was
   * in flight — so nothing from a labelled channel is fetched or delivered
   * pre-consent, whichever feature asked.
   */
  async function channelContent<T>(channelId: number, load: () => Promise<T>): Promise<T> {
    const refusal = (): ApiClientError =>
      new ApiClientError(403, NSFW_ACKNOWLEDGEMENT_REQUIRED, NSFW_ACKNOWLEDGEMENT_REQUIRED);
    if (nsfwContentBlocked(channelId)) throw refusal();
    let result: T;
    try {
      result = await load();
    } catch (err) {
      // The server's refusal outranks a stale local "consented". A resume
      // that missed an nsfw_ack already gets a full ready (the revoke bumps
      // the server's visibility watermark), so this is defence in depth.
      if (err instanceof ApiClientError && err.code === NSFW_ACKNOWLEDGEMENT_REQUIRED) {
        setNsfwAcknowledged(channelId, false);
      }
      throw err;
    }
    if (nsfwContentBlocked(channelId)) throw refusal();
    return result;
  }

  function adminRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return doFetch<T>("Admin API", "/admin/api", method, path, body, signal);
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
      // Switching to a different host without an accompanying new token must
      // not carry the previous host's bearer token forward — otherwise the
      // login/register request to the new host rides a still-live session
      // token for the old one. Callers that only rotate the token (post-auth)
      // never pass `host`, so this never touches a same-host token refresh.
      const nextConfig = {
        ...config,
        ...newConfig,
        ...(newConfig.host !== undefined &&
        newConfig.host !== config.host &&
        newConfig.token === undefined
          ? { token: undefined }
          : {}),
      };
      if (nextConfig.host !== config.host || nextConfig.token !== config.token) {
        replaceSession(nextConfig);
      }
    },

    /** Capture before async work; public ownership metadata never exposes tokens. */
    getSession(): SessionScope {
      return session;
    },

    /** End even a same-host, pre-auth attempt and invalidate all its resources. */
    endSession(): void {
      replaceSession({ host: config.host });
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

    /** Revokes this session's token. It runs outside the session's scope, so the
     *  session teardown that follows a logout cannot cancel it, and a 401 (the
     *  token is already gone) does not start a second logout. */
    logout(signal?: AbortSignal): Promise<void> {
      return request<void>("POST", "/auth/logout", undefined, signal, {
        detached: true,
        skipUnauthorized: true,
      });
    },

    verifyTotp(code: string, partialToken: string, signal?: AbortSignal): Promise<AuthResponse> {
      return request<AuthResponse>("POST", "/auth/verify-totp", { code }, signal, {
        token: partialToken,
      });
    },

    /** POST /auth/recover. `secret` is a recovery kit secret or an
     *  owner-issued recovery credential; the server tells them apart by
     *  shape, so both travel in `kit_secret`. Answers the login shape. */
    recoverAccount(
      username: string,
      secret: string,
      newPassword: string,
      signal?: AbortSignal,
    ): Promise<AuthResponse> {
      return request<AuthResponse>(
        "POST",
        "/auth/recover",
        { username, kit_secret: secret, new_password: newPassword },
        signal,
      );
    },

    deleteAccount(password: string, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", "/auth/account", { password }, signal);
    },

    // ── Users ─────────────────────────────────────────────

    getMe(signal?: AbortSignal): Promise<MemberResponse> {
      return request<MemberResponse>("GET", "/auth/me", undefined, signal);
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
    uploadAvatar(file: File, signal?: AbortSignal): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", file);

      return request<UploadResponse>("POST", "/users/me/avatar", formData, signal, {
        multipart: true,
      });
    },

    changePassword(
      currentPassword: string,
      newPassword: string,
      signal?: AbortSignal,
    ): Promise<PartialSuccessResponse | undefined> {
      // 204 on full success; 200 with a warning body when the password
      // changed but the other sessions could not be revoked (OC-0314).
      return request<PartialSuccessResponse | undefined>(
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

    confirmTotp(
      password: string,
      code: string,
      signal?: AbortSignal,
    ): Promise<PartialSuccessResponse | undefined> {
      // Unlike every other endpoint on this client, a wrong answer here
      // (an invalid enrollment code) is reported as 401 UNAUTHORIZED rather
      // than 400/403 — see doFetch's `skipUnauthorized`. Without this the
      // global session-expiry sink would fire on a mistyped code, signing
      // the user out and deleting their stored credential for a session
      // that was never actually invalid.
      return request<PartialSuccessResponse | undefined>(
        "POST",
        "/users/me/totp/confirm",
        { password, code },
        signal,
        {
          skipUnauthorized: true,
        },
      );
    },

    disableTotp(
      password: string,
      signal?: AbortSignal,
    ): Promise<PartialSuccessResponse | undefined> {
      return request<PartialSuccessResponse | undefined>(
        "DELETE",
        "/users/me/totp",
        { password },
        signal,
      );
    },

    /** Replace the emergency recovery codes; the new set is returned once. */
    regenerateRecoveryCodes(
      password: string,
      signal?: AbortSignal,
    ): Promise<{ backup_codes: string[] }> {
      return request("POST", "/users/me/totp/recovery-codes", { password }, signal);
    },

    /** Issue (or replace) the recovery kit; the server generates the secret. */
    enrolRecoveryKit(password: string, signal?: AbortSignal): Promise<RecoveryKitIssue> {
      return request<RecoveryKitIssue>("POST", "/users/me/recovery-kit", { password }, signal);
    },

    getRecoveryKitStatus(signal?: AbortSignal): Promise<RecoveryKitStatus> {
      return request<RecoveryKitStatus>("GET", "/users/me/recovery-kit", undefined, signal);
    },

    getOwnModeration(signal?: AbortSignal): Promise<OwnModerationAction[]> {
      return request<OwnModerationAction[]>("GET", "/users/me/moderation", undefined, signal);
    },

    /** Records that the caller read their own warning. 404 when it is already
     *  acknowledged (or not theirs). */
    acknowledgeNotice(actionId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", `/users/me/notices/${actionId}/ack`, undefined, signal);
    },

    /** Files an appeal against the caller's own moderation action (its ledger id).
     *  409 ALREADY_APPEALED, 429 RATE_LIMITED, 404 when not theirs or gone. */
    fileAppeal(actionId: number, body: string, signal?: AbortSignal): Promise<{ id: string }> {
      return request<{ id: string }>("POST", "/appeals/", { action_id: actionId, body }, signal);
    },

    getMyAppeals(signal?: AbortSignal): Promise<MyAppeal[]> {
      return request<MyAppeal[]>("GET", "/appeals/mine", undefined, signal);
    },

    /** Open or assigned appeals only: 409 once decided or withdrawn, 404 when not the caller's. */
    withdrawAppeal(publicId: string, signal?: AbortSignal): Promise<void> {
      return request<void>(
        "POST",
        `/appeals/${encodeURIComponent(publicId)}/withdraw`,
        undefined,
        signal,
      );
    },

    getSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
      const owner = session;
      return request<SessionsListResponse>("GET", "/users/me/sessions", undefined, signal).then(
        (r) => {
          owner.assertCurrent();
          return r.sessions;
        },
      );
    },

    revokeSession(sessionId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/users/me/sessions/${sessionId}`, undefined, signal);
    },

    revokeAllSessions(signal?: AbortSignal): Promise<RevokeAllSessionsResponse> {
      return request<RevokeAllSessionsResponse>("DELETE", "/users/me/sessions", undefined, signal);
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
      return channelContent(channelId, () =>
        request<MessagesResponse>(
          "GET",
          `/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
          undefined,
          signal,
        ),
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
      return channelContent(channelId, () =>
        request<MessagesAroundResponse>(
          "GET",
          `/channels/${channelId}/messages/around/${messageId}${qs ? `?${qs}` : ""}`,
          undefined,
          signal,
        ),
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
      return channelContent(channelId, () =>
        request<ReactionUsersResponse>(
          "GET",
          `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/users`,
          undefined,
          signal,
        ),
      );
    },

    getPins(channelId: number, signal?: AbortSignal): Promise<MessagesResponse> {
      return channelContent(channelId, () =>
        request<MessagesResponse>("GET", `/channels/${channelId}/pins`, undefined, signal),
      );
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
      const send = (): Promise<SearchResponse> =>
        request<SearchResponse>("GET", `/search?${params.toString()}`, undefined, signal);
      // A server-wide search already omits channels the caller has not
      // acknowledged; a single-channel one is a content read like any other.
      return options?.channelId === undefined ? send() : channelContent(options.channelId, send);
    },

    /** Acknowledge a labelled channel for this account, on every device (B5-7). */
    acknowledgeNsfw(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("PUT", `/channels/${channelId}/nsfw-acknowledgement`, undefined, signal);
    },

    /** Withdraw this account's acknowledgement of a labelled channel (B5-7). */
    revokeNsfw(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>(
        "DELETE",
        `/channels/${channelId}/nsfw-acknowledgement`,
        undefined,
        signal,
      );
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

    uploadFile(file: File, signal?: AbortSignal): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", file);

      return request<UploadResponse>("POST", "/uploads", formData, signal, { multipart: true });
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
    uploadEmoji(shortcode: string, file: File, signal?: AbortSignal): Promise<EmojiResponse> {
      const formData = new FormData();
      formData.append("shortcode", shortcode);
      formData.append("file", file);

      return request<EmojiResponse>("POST", "/emoji", formData, signal, { multipart: true });
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

    /** The pending Message Requests inbox (B5-6). */
    listDmRequests(signal?: AbortSignal): Promise<DmRequestListResponse> {
      return request<DmRequestListResponse>("GET", "/dm-requests", undefined, signal);
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

    async getHealth(
      host?: string,
      timeoutMs = 3000,
      signal?: AbortSignal,
    ): Promise<HealthResponse> {
      // Explicit-host checks belong to the server picker, independently of the
      // signed-in server. Its page supplies cancellation; current-server checks
      // additionally belong to the authenticated session.
      const targetHost = host ?? config.host;
      const owner =
        host === undefined
          ? session.fork(signal)
          : new SessionScope({ host: targetHost, generation }, signal ? [signal] : []);
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
      // saved profile independently of the signed-in server. B7-15 reads
      // through this method rather than inventing a second transport.
      const targetHost = host ?? config.host;
      const owner =
        host === undefined
          ? session.fork(signal)
          : new SessionScope({ host: targetHost, generation }, signal ? [signal] : []);
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
         * Age-restriction label. The server withholds a labelled channel's
         * content from anyone who has not acknowledged it (B5-7); clearing
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

    /**
     * Lift a ban. The mirror of `adminBanMember`: the server broadcasts a
     * `member_join` for the unbanned user, which every client turns back into a
     * roster entry, so the roster needs no refreshing locally.
     */
    adminUnbanMember(userId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("PATCH", `/users/${userId}`, { banned: false }, signal);
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
        const page = await adminRequest<AdminUser[]>(
          "GET",
          `/users?${params.toString()}`,
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

export type ApiClient = ReturnType<typeof createApiClient>;
