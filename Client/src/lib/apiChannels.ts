// REST calls for channel content: messages, search, GIFs, uploads, invites, custom emoji and stickers.

import type {
  MessagesResponse,
  MessagesAroundResponse,
  PurgeResponse,
  ReactionUsersResponse,
  ThreadListResponse,
  ChannelMediaQuery,
  ChannelMediaPage,
  ChannelMediaMonthsResponse,
  UserStorage,
  UserUploadsQuery,
  UserUploadsPage,
  SearchResponse,
  GifSearchResponse,
  GifFavoritesResponse,
  GifFavorite,
  VoiceUploadMeta,
  UploadResponse,
  InviteResponse,
  EmojiResponse,
  StickerResponse,
} from "./types";
import { channelMediaParams, userUploadsParams } from "./apiShared";
import type { ApiTransport } from "./apiShared";

/** The channel content calls of the REST client. */
export function createChannelsApi(t: ApiTransport) {
  return {
    // ── Channels ──────────────────────────────────────────

    getMessages(
      channelId: number,
      options?: { before?: number; after?: number; limit?: number },
      signal?: AbortSignal,
    ): Promise<MessagesResponse> {
      const params = new URLSearchParams();
      if (options?.before !== undefined) params.set("before", String(options.before));
      // `after` pages the other way (oldest-first) and the server rejects it
      // combined with `before`.
      if (options?.after !== undefined) params.set("after", String(options.after));
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      return t.channelContent(channelId, () =>
        t.request<MessagesResponse>(
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
      return t.channelContent(channelId, () =>
        t.request<MessagesAroundResponse>(
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
      return t.request<PurgeResponse>(
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
      return t.channelContent(channelId, () =>
        t.request<ReactionUsersResponse>(
          "GET",
          `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/users`,
          undefined,
          signal,
        ),
      );
    },

    getPins(channelId: number, signal?: AbortSignal): Promise<MessagesResponse> {
      return t.channelContent(channelId, () =>
        t.request<MessagesResponse>("GET", `/channels/${channelId}/pins`, undefined, signal),
      );
    },

    /**
     * A text channel's threads: `query` is the list route's query
     * string (`archived`, `before`, `limit`), which the Threads popover builds.
     */
    listThreads(
      channelId: number,
      query: string,
      signal?: AbortSignal,
    ): Promise<ThreadListResponse> {
      return t.channelContent(channelId, () =>
        t.request<ThreadListResponse>(
          "GET",
          `/channels/${channelId}/threads?${query}`,
          undefined,
          signal,
        ),
      );
    },

    /** One page of a channel's media gallery (`channel_media` capability). */
    listChannelMedia(
      channelId: number,
      query: ChannelMediaQuery,
      signal?: AbortSignal,
    ): Promise<ChannelMediaPage> {
      return t.channelContent(channelId, () =>
        t.request<ChannelMediaPage>(
          "GET",
          `/channels/${channelId}/media?${channelMediaParams(query).toString()}`,
          undefined,
          signal,
        ),
      );
    },

    /** How many gallery items each month holds, for the month list. */
    getChannelMediaMonths(
      channelId: number,
      query: ChannelMediaQuery,
      signal?: AbortSignal,
    ): Promise<ChannelMediaMonthsResponse> {
      const params = channelMediaParams({
        kind: query.kind,
        ...(query.q !== undefined ? { q: query.q } : {}),
        ...(query.from !== undefined ? { from: query.from } : {}),
        ...(query.tz !== undefined ? { tz: query.tz } : {}),
      });
      return t.channelContent(channelId, () =>
        t.request<ChannelMediaMonthsResponse>(
          "GET",
          `/channels/${channelId}/media/months?${params.toString()}`,
          undefined,
          signal,
        ),
      );
    },

    /** How much of the upload quota the caller has used. */
    getUserStorage(signal?: AbortSignal): Promise<UserStorage> {
      return t.request<UserStorage>("GET", "/users/me/storage", undefined, signal);
    },

    /** One page of the caller's uploaded files, in every state. */
    listUserUploads(query: UserUploadsQuery, signal?: AbortSignal): Promise<UserUploadsPage> {
      const qs = userUploadsParams(query).toString();
      return t.request<UserUploadsPage>(
        "GET",
        `/users/me/uploads${qs === "" ? "" : `?${qs}`}`,
        undefined,
        signal,
      );
    },

    /** Remove one of the caller's own files; 404 when gone, 409 when in use. */
    removeUserUpload(attachmentId: string, signal?: AbortSignal): Promise<void> {
      return t.request<void>(
        "DELETE",
        `/users/me/uploads/${encodeURIComponent(attachmentId)}`,
        undefined,
        signal,
      );
    },

    pinMessage(channelId: number, messageId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>("POST", `/channels/${channelId}/pins/${messageId}`, undefined, signal);
    },

    unpinMessage(channelId: number, messageId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>(
        "DELETE",
        `/channels/${channelId}/pins/${messageId}`,
        undefined,
        signal,
      );
    },

    // ── Search ────────────────────────────────────────────

    search(
      query: string,
      options?: {
        channelId?: number;
        limit?: number;
        sort?: "relevance" | "recent";
        before?: number;
      },
      signal?: AbortSignal,
    ): Promise<SearchResponse> {
      const params = new URLSearchParams({ q: query });
      if (options?.channelId !== undefined) params.set("channel_id", String(options.channelId));
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      if (options?.sort !== undefined) params.set("sort", options.sort);
      // A `before` cursor only walks a newest-first list, so it implies the
      // sort rather than letting the caller submit an invalid pairing.
      if (options?.before !== undefined) {
        params.set("sort", "recent");
        params.set("before", String(options.before));
      }
      const send = (): Promise<SearchResponse> =>
        t.request<SearchResponse>("GET", `/search?${params.toString()}`, undefined, signal);
      // A server-wide search already omits channels the caller has not
      // acknowledged; a single-channel one is a content read like any other.
      return options?.channelId === undefined ? send() : t.channelContent(options.channelId, send);
    },

    /** Acknowledge a labelled channel for this account, on every device. */
    acknowledgeNsfw(channelId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>(
        "PUT",
        `/channels/${channelId}/nsfw-acknowledgement`,
        undefined,
        signal,
      );
    },

    /** Withdraw this account's acknowledgement of a labelled channel. */
    revokeNsfw(channelId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>(
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

    gifSearch(
      query: string,
      limit: number,
      pos?: string,
      signal?: AbortSignal,
    ): Promise<GifSearchResponse> {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (pos) params.set("pos", pos);
      return t.request<GifSearchResponse>(
        "GET",
        `/gif/search?${params.toString()}`,
        undefined,
        signal,
      );
    },

    gifTrending(limit: number, pos?: string, signal?: AbortSignal): Promise<GifSearchResponse> {
      const params = new URLSearchParams({ limit: String(limit) });
      if (pos) params.set("pos", pos);
      return t.request<GifSearchResponse>(
        "GET",
        `/gif/trending?${params.toString()}`,
        undefined,
        signal,
      );
    },

    gifFavorites(signal?: AbortSignal): Promise<GifFavoritesResponse> {
      return t.request<GifFavoritesResponse>("GET", "/gif/favorites", undefined, signal);
    },

    addGifFavorite(fav: GifFavorite, signal?: AbortSignal): Promise<void> {
      return t.request<void>("PUT", "/gif/favorites", fav, signal);
    },

    removeGifFavorite(url: string, signal?: AbortSignal): Promise<void> {
      const params = new URLSearchParams({ url });
      return t.request<void>("DELETE", `/gif/favorites?${params.toString()}`, undefined, signal);
    },

    // ── File Uploads ──────────────────────────────────────

    /**
     * Upload one file. `onProgress` receives a 0–1 fraction for this upload
     * only, correlated by an id the client generates; the callback is not
     * called at all when the native transport reports none (e.g. a browser
     * adapter with no progress channel).
     */
    uploadFile(
      file: File,
      signal?: AbortSignal,
      onProgress?: (fraction: number) => void,
      voice?: VoiceUploadMeta,
    ): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", file);
      // A voice message declares its length and waveform in the query:
      // both or neither, which one optional object guarantees.
      const query =
        voice === undefined
          ? ""
          : `?voice_duration_ms=${Math.round(voice.durationMs)}&voice_waveform=${encodeURIComponent(voice.waveform)}`;

      return t.request<UploadResponse>("POST", `/uploads${query}`, formData, signal, {
        multipart: true,
        onUploadProgress: onProgress,
      });
    },

    /** Withdraw an upload that was never sent, freeing its quota now. */
    discardUpload(id: string, signal?: AbortSignal): Promise<void> {
      return t.request<void>("DELETE", `/uploads/${encodeURIComponent(id)}`, undefined, signal);
    },

    // ── Invites ───────────────────────────────────────────

    getInvites(signal?: AbortSignal): Promise<InviteResponse[]> {
      return t.request<InviteResponse[]>("GET", "/invites", undefined, signal);
    },

    createInvite(
      data: { max_uses?: number; expires_in_hours?: number },
      signal?: AbortSignal,
    ): Promise<InviteResponse> {
      return t.request<InviteResponse>("POST", "/invites", data, signal);
    },

    revokeInvite(code: string, signal?: AbortSignal): Promise<void> {
      return t.request<void>("DELETE", `/invites/${code}`, undefined, signal);
    },

    // ── Custom emoji ──────────────────────────────────────
    //
    // Reading is open to any member; upload and delete require MANAGE_SERVER
    // and are refused server-side with 403 regardless of what the UI offers.

    /** The server's whole custom-emoji set. */
    listEmoji(signal?: AbortSignal): Promise<EmojiResponse[]> {
      return t.request<EmojiResponse[]>("GET", "/emoji", undefined, signal);
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

      return t.request<EmojiResponse>("POST", "/emoji", formData, signal, { multipart: true });
    },

    deleteEmoji(emojiId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>("DELETE", `/emoji/${emojiId}`, undefined, signal);
    },

    // ── Custom stickers ──────────────────────────
    //
    // Reading is open to any member. Upload, rename and delete are the admin
    // panel's (Server/admin/static/js/stickers.js), which calls them itself.

    /** The server's whole custom-sticker set. */
    listStickers(signal?: AbortSignal): Promise<StickerResponse[]> {
      return t.request<StickerResponse[]>("GET", "/stickers", undefined, signal);
    },
  };
}
