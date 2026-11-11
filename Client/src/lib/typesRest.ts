// REST response and request shapes for search, invites, uploads, GIFs, direct
// messages, reports and the account's security calls. Type-only; re-exported
// from types.ts.

import type { RestErrorCodeValue } from "./protocolTypes";
import type { MessageUser } from "./wireCommon";
import type { DmChannelPayload, DmRecipient, ImportedAuthor } from "./wireServer";
import type { DmRequestListItem } from "./wireVoiceDm";
/** Search result item. */
export interface SearchResultItem {
  readonly message_id: number;
  readonly channel_id: number;
  readonly channel_name: string;
  readonly user: MessageUser;
  readonly content: string;
  readonly timestamp: string;
  /** Present on an imported message; `user` is then the hidden import account. */
  readonly imported_author?: ImportedAuthor;
}

/** GET /api/search response. */
export interface SearchResponse {
  readonly results: readonly SearchResultItem[];
  /**
   * Cursor for the next page of a newest-first (`sort=recent`) search, or null
   * or absent when there is none. Only `recent` paging sets it.
   */
  readonly next_before?: number | null;
}

/** REST API error response body. */
export interface ApiError {
  /** UNKNOWN: the client's own fallback for a reply with no JSON error body. */
  readonly error: RestErrorCodeValue | "UNKNOWN";
  readonly message: string;
}

/** Single invite object from GET/POST /api/invites. */
export interface InviteResponse {
  readonly id: number;
  readonly code: string;
  /** Never sent by the server; kept for callers that still pass one. */
  readonly url?: string;
  readonly max_uses: number | null;
  /** How many times the code was redeemed (the server's `uses`). */
  readonly uses?: number;
  readonly use_count?: number;
  readonly expires_at: string | null;
  readonly revoked?: boolean;
  readonly created_at?: string;
  readonly creator_username?: string;
}

/** Upload response from POST /api/uploads. */
export interface UploadResponse {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
  readonly duration_ms?: number;
  readonly waveform?: string;
}

/**
 * GET /api/v1/gif/{search,trending} response.
 *
 * The GIF provider key lives on the server; the client only ever talks to its
 * own server here. The media URLs still point at Klipy's CDN and are validated
 * against the CDN allowlist in gifProvider before being rendered.
 */
export interface GifApiResult {
  readonly id: string;
  readonly title: string;
  readonly media_formats: {
    readonly tinygif?: { readonly url: string };
    readonly gif?: { readonly url: string };
  };
}

/** One saved GIF (GET /api/v1/gif/favorites). */
export interface GifFavorite {
  readonly url: string;
  readonly preview_url: string;
  readonly title: string;
}

export interface GifFavoritesResponse {
  readonly favorites: readonly GifFavorite[];
}

/** Envelope for both GIF endpoints. */
export interface GifSearchResponse {
  readonly results: readonly GifApiResult[];
  /** Opaque cursor for the next page (send back as `pos`); "" or absent when there is none. */
  readonly next?: string;
}

/** GET /api/v1/dms response. */
export interface DmChannelsResponse {
  readonly dm_channels: readonly DmChannelPayload[];
}

/** POST /api/v1/dms response. */
export interface CreateDmResponse {
  readonly channel_id: number;
  readonly recipient: DmRecipient;
  readonly created: boolean;
}

/** POST /api/v1/dms/group and PATCH /api/v1/dms/{id} both answer with the
 *  same DM summary shape the list and the ready payload use. */
export type GroupDmResponse = DmChannelPayload;

/** GET /api/v1/dm-requests response: the caller's pending inbox, newest first. */
export interface DmRequestListResponse {
  readonly requests: readonly DmRequestListItem[];
}

/** GET /api/v1/blocks response. */
export interface BlockedUsersResponse {
  readonly blocked_user_ids: readonly number[];
}

/** The public id of a record the caller just filed (a report or an appeal). */
export interface PublicIdResponse {
  readonly id: string;
}

/** POST /users/me/totp/enable: the otpauth URI to scan and the first recovery codes. */
export interface TotpEnrolmentResponse {
  readonly qr_uri: string;
  readonly backup_codes: string[];
}

/** POST /users/me/totp/recovery-codes: the replacement recovery codes. */
export interface RecoveryCodesResponse {
  readonly backup_codes: string[];
}

/** A timeout's answer: its voice half, "applied" or "skipped". */
export interface TimeoutResult {
  readonly id: number;
  readonly voice: "applied" | "skipped";
}

/** A report-linked action's answer; `voice` is set for a timeout only. */
export interface ReportActResult {
  readonly voice?: string;
}

/** A member nickname change's answer; `display_name` is null once cleared. */
export interface NicknameResult {
  readonly user_id: number;
  readonly display_name: string | null;
}
