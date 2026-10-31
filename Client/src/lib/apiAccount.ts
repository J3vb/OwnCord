// REST calls for sign-in and the signed-in account: auth, profile, sessions, recovery, privacy, notes, reports and appeals.

import type {
  AuthResponse,
  RegisterResponse,
  MemberResponse,
  UploadResponse,
  PartialSuccessResponse,
} from "./types";
import {
  LOGOUT_TIMEOUT_MS,
  ApiClientError,
  type RecoveryKitIssue,
  type RecoveryKitStatus,
  type UserNote,
  type DmPrivacy,
  type OwnModerationAction,
  type FileReportRequest,
  type OwnReportSummary,
  type ModerationQueueFilter,
  type ModerationQueueRow,
  type ModerationReportDetail,
  type ModerationOutcome,
  type ModerationActRequest,
  type ModerationAppealFilter,
  type ModerationAppealRow,
  type ModerationAppealDetail,
  type AppealDecision,
  type MyAppeal,
  type SessionInfo,
  type SessionsListResponse,
  type RevokeAllSessionsResponse,
} from "./apiShared";
import type { ApiTransport } from "./apiShared";

/** The auth and account calls of the REST client. */
export function createAccountApi(t: ApiTransport) {
  return {
    // ── Auth ──────────────────────────────────────────────

    login(username: string, password: string, signal?: AbortSignal): Promise<AuthResponse> {
      return t.request<AuthResponse>("POST", "/auth/login", { username, password }, signal);
    },

    register(
      username: string,
      password: string,
      inviteCode: string,
      signal?: AbortSignal,
    ): Promise<RegisterResponse> {
      return t.request<RegisterResponse>(
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
      return t.request<void>("POST", "/auth/logout", undefined, signal, {
        detached: true,
        skipUnauthorized: true,
        timeoutMs: LOGOUT_TIMEOUT_MS,
      });
    },

    verifyTotp(code: string, partialToken: string, signal?: AbortSignal): Promise<AuthResponse> {
      return t.request<AuthResponse>("POST", "/auth/verify-totp", { code }, signal, {
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
      return t.request<AuthResponse>(
        "POST",
        "/auth/recover",
        { username, kit_secret: secret, new_password: newPassword },
        signal,
      );
    },

    deleteAccount(password: string, signal?: AbortSignal): Promise<void> {
      return t.request<void>("DELETE", "/auth/account", { password }, signal);
    },

    // ── Users ─────────────────────────────────────────────

    getMe(signal?: AbortSignal): Promise<MemberResponse> {
      return t.request<MemberResponse>("GET", "/auth/me", undefined, signal);
    },

    updateProfile(
      data: {
        username?: string;
        avatar?: string;
        identity_public_key?: string;
        /** Omit to leave unchanged; "" clears the field. */
        display_name?: string;
        about?: string;
        /** `#rgb` / `#rrggbb`; omit to leave unchanged, "" clears. */
        banner_color?: string;
      },
      signal?: AbortSignal,
    ): Promise<MemberResponse> {
      return t.request<MemberResponse>("PATCH", "/users/me", data, signal);
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

      return t.request<UploadResponse>("POST", "/users/me/avatar", formData, signal, {
        multipart: true,
      });
    },

    /**
     * Remove the signed-in user's avatar and return the updated user.
     * `DELETE /users/me/avatar`; an older server answers 405, so fall back to
     * `PATCH /users/me` with the current username and `avatar: ""`.
     */
    async removeAvatar(currentUsername: string, signal?: AbortSignal): Promise<MemberResponse> {
      try {
        return await t.request<MemberResponse>("DELETE", "/users/me/avatar", undefined, signal);
      } catch (err) {
        if (!(err instanceof ApiClientError) || err.status !== 405) throw err;
        return t.request<MemberResponse>(
          "PATCH",
          "/users/me",
          { username: currentUsername, avatar: "" },
          signal,
        );
      }
    },

    /**
     * Upload a profile banner (PNG/JPEG/WebP, max 1 MiB, max 1920x960).
     * `POST /users/me/banner`. A server with attachment storage off advertises
     * `profile_banners` but does not mount this route, so it answers 404; the
     * caller turns that into its own message. On success the server has already
     * broadcast a user_update.
     */
    uploadBanner(file: File, signal?: AbortSignal): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", file);

      return t.request<UploadResponse>("POST", "/users/me/banner", formData, signal, {
        multipart: true,
      });
    },

    /** Remove the signed-in user's banner image and return the updated user.
     *  `DELETE /users/me/banner`; the colour is cleared by `updateProfile`. */
    removeBanner(signal?: AbortSignal): Promise<MemberResponse> {
      return t.request<MemberResponse>("DELETE", "/users/me/banner", undefined, signal);
    },

    changePassword(
      currentPassword: string,
      newPassword: string,
      signal?: AbortSignal,
    ): Promise<PartialSuccessResponse | undefined> {
      // 204 on full success; 200 with a warning body when the password
      // changed but the other sessions could not be revoked.
      return t.request<PartialSuccessResponse | undefined>(
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
      return t.request("POST", "/users/me/totp/enable", { password }, signal);
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
      return t.request<PartialSuccessResponse | undefined>(
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
      return t.request<PartialSuccessResponse | undefined>(
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
      return t.request("POST", "/users/me/totp/recovery-codes", { password }, signal);
    },

    /** Issue (or replace) the recovery kit; the server generates the secret. */
    enrolRecoveryKit(password: string, signal?: AbortSignal): Promise<RecoveryKitIssue> {
      return t.request<RecoveryKitIssue>("POST", "/users/me/recovery-kit", { password }, signal);
    },

    getRecoveryKitStatus(signal?: AbortSignal): Promise<RecoveryKitStatus> {
      return t.request<RecoveryKitStatus>("GET", "/users/me/recovery-kit", undefined, signal);
    },

    /** The caller's private note about `userId` ("" when none). Callers wrap in try/catch. */
    getUserNote(userId: number, signal?: AbortSignal): Promise<UserNote> {
      return t.request<UserNote>("GET", `/users/me/notes/${userId}`, undefined, signal);
    },

    /** Store (or, when empty after trimming, delete) the caller's note about
     *  `userId`; resolves to the stored value. Callers wrap in try/catch. */
    putUserNote(userId: number, note: string, signal?: AbortSignal): Promise<UserNote> {
      return t.request<UserNote>("PUT", `/users/me/notes/${userId}`, { note }, signal);
    },

    /** The caller's DM privacy settings. Callers wrap in try/catch. */
    getDmPrivacy(signal?: AbortSignal): Promise<DmPrivacy> {
      return t.request<DmPrivacy>("GET", "/users/me/privacy", undefined, signal);
    },

    /** Replace both DM privacy settings; resolves to the stored values. Callers wrap in try/catch. */
    putDmPrivacy(settings: DmPrivacy, signal?: AbortSignal): Promise<DmPrivacy> {
      return t.request<DmPrivacy>("PUT", "/users/me/privacy", settings, signal);
    },

    getOwnModeration(signal?: AbortSignal): Promise<OwnModerationAction[]> {
      return t.request<OwnModerationAction[]>("GET", "/users/me/moderation", undefined, signal);
    },

    /** File a local report; resolves to its opaque public id. */
    fileReport(body: FileReportRequest, signal?: AbortSignal): Promise<{ id: string }> {
      return t.request<{ id: string }>("POST", "/reports", body, signal);
    },

    getMyReports(signal?: AbortSignal): Promise<OwnReportSummary[]> {
      return t.request<OwnReportSummary[]>("GET", "/reports/mine", undefined, signal);
    },

    /** The moderator queue. 403 without MODERATE_MEMBERS. */
    getModerationQueue(
      state: ModerationQueueFilter,
      signal?: AbortSignal,
    ): Promise<ModerationQueueRow[]> {
      const query = state === "" ? "" : `?state=${state}`;
      return t.request<ModerationQueueRow[]>("GET", `/moderation/queue${query}`, undefined, signal);
    },

    /** One report with its evidence. 404 for a report about the caller. */
    getModerationReport(id: string, signal?: AbortSignal): Promise<ModerationReportDetail> {
      return t.request<ModerationReportDetail>(
        "GET",
        `/moderation/queue/${encodeURIComponent(id)}`,
        undefined,
        signal,
      );
    },

    /** Take a report: 409 when another moderator already holds it or it closed. */
    assignModerationReport(id: string, signal?: AbortSignal): Promise<void> {
      return t.request<void>(
        "POST",
        `/moderation/queue/${encodeURIComponent(id)}/assign`,
        undefined,
        signal,
      );
    },

    /** Add an internal note: 409 once the report is closed. */
    addModerationNote(id: string, body: string, signal?: AbortSignal): Promise<void> {
      return t.request<void>(
        "POST",
        `/moderation/queue/${encodeURIComponent(id)}/notes`,
        { body },
        signal,
      );
    },

    /** Close a report with its outcome: 409 when it is already closed. */
    closeModerationReport(
      id: string,
      outcome: ModerationOutcome,
      signal?: AbortSignal,
    ): Promise<void> {
      return t.request<void>(
        "POST",
        `/moderation/queue/${encodeURIComponent(id)}/close`,
        { outcome },
        signal,
      );
    },

    /** Warn or time out a report's subject, linked to the report. A
     *  timeout answers with its voice half, "applied" or "skipped"; a warning
     *  answers nothing. 403 below MODERATE_MEMBERS or the subject's rank. */
    actOnModerationReport(
      id: string,
      body: ModerationActRequest,
      signal?: AbortSignal,
    ): Promise<{ readonly voice?: string } | undefined> {
      return t.request<{ readonly voice?: string } | undefined>(
        "POST",
        `/moderation/queue/${encodeURIComponent(id)}/act`,
        body,
        signal,
      );
    },

    /** Time out a member (MODERATE_MEMBERS, outrank). 60..2419200 s; 403/400 as warn. */
    timeoutMember(
      userId: number,
      durationSeconds: number,
      reason: string,
      signal?: AbortSignal,
    ): Promise<{ readonly id: number; readonly voice: "applied" | "skipped" }> {
      return t.request<{ readonly id: number; readonly voice: "applied" | "skipped" }>(
        "POST",
        `/moderation/users/${userId}/timeout`,
        { reason, duration_seconds: durationSeconds },
        signal,
      );
    },

    /**
     * Set (or, with null, clear) another member's nickname (MANAGE_NICKNAMES,
     * outrank). Idempotent: the same name twice answers 200 both times. 400
     * INVALID_INPUT (length, taken by a username), 403, 404, 429 carry a message.
     */
    setMemberNickname(
      userId: number,
      displayName: string | null,
      signal?: AbortSignal,
    ): Promise<{ readonly user_id: number; readonly display_name: string | null }> {
      return t.request<{ readonly user_id: number; readonly display_name: string | null }>(
        "PUT",
        `/moderation/users/${userId}/nickname`,
        { display_name: displayName },
        signal,
      );
    },

    /** End a member's active timeout early: 404 when they have none. */
    liftTimeout(userId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>("POST", `/moderation/users/${userId}/untimeout`, undefined, signal);
    },

    /** The moderator appeal queue. 403 without MODERATE_MEMBERS. */
    getModerationAppeals(
      state: ModerationAppealFilter,
      signal?: AbortSignal,
    ): Promise<ModerationAppealRow[]> {
      const query = state === "" ? "" : `?state=${state}`;
      return t.request<ModerationAppealRow[]>(
        "GET",
        `/moderation/appeals${query}`,
        undefined,
        signal,
      );
    },

    getModerationAppeal(id: string, signal?: AbortSignal): Promise<ModerationAppealDetail> {
      return t.request<ModerationAppealDetail>(
        "GET",
        `/moderation/appeals/${encodeURIComponent(id)}`,
        undefined,
        signal,
      );
    },

    /** Take an appeal: 409 when someone else holds it or it closed; never forced. */
    assignModerationAppeal(id: string, signal?: AbortSignal): Promise<void> {
      return t.request<void>(
        "POST",
        `/moderation/appeals/${encodeURIComponent(id)}/assign`,
        undefined,
        signal,
      );
    },

    /** Decide an appeal: 409 when it changed since read, or REVERSAL_FAILED. */
    decideModerationAppeal(
      id: string,
      outcome: AppealDecision,
      note: string,
      signal?: AbortSignal,
    ): Promise<void> {
      return t.request<void>(
        "POST",
        `/moderation/appeals/${encodeURIComponent(id)}/decide`,
        { outcome, note },
        signal,
      );
    },

    /** Records that the caller read their own warning. 404 when it is already
     *  acknowledged (or not theirs). */
    acknowledgeNotice(actionId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>("POST", `/users/me/notices/${actionId}/ack`, undefined, signal);
    },

    /** Files an appeal against the caller's own moderation action (its ledger id).
     *  409 ALREADY_APPEALED, 429 RATE_LIMITED, 404 when not theirs or gone. */
    fileAppeal(actionId: number, body: string, signal?: AbortSignal): Promise<{ id: string }> {
      return t.request<{ id: string }>("POST", "/appeals/", { action_id: actionId, body }, signal);
    },

    getMyAppeals(signal?: AbortSignal): Promise<MyAppeal[]> {
      return t.request<MyAppeal[]>("GET", "/appeals/mine", undefined, signal);
    },

    /** Open or assigned appeals only: 409 once decided or withdrawn, 404 when not the caller's. */
    withdrawAppeal(publicId: string, signal?: AbortSignal): Promise<void> {
      return t.request<void>(
        "POST",
        `/appeals/${encodeURIComponent(publicId)}/withdraw`,
        undefined,
        signal,
      );
    },

    getSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
      const owner = t.session;
      return t
        .request<SessionsListResponse>("GET", "/users/me/sessions", undefined, signal)
        .then((r) => {
          owner.assertCurrent();
          return r.sessions;
        });
    },

    revokeSession(sessionId: number, signal?: AbortSignal): Promise<void> {
      return t.request<void>("DELETE", `/users/me/sessions/${sessionId}`, undefined, signal);
    },

    revokeAllSessions(signal?: AbortSignal): Promise<RevokeAllSessionsResponse> {
      return t.request<RevokeAllSessionsResponse>(
        "DELETE",
        "/users/me/sessions",
        undefined,
        signal,
      );
    },
  };
}
