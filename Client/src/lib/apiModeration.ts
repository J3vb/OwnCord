// REST calls for the signed-in member's moderation record, reports and appeals, and the moderation queue.

import type {
  ApiTransport,
  OwnModerationAction,
  FileReportRequest,
  OwnReportSummary,
  ModerationQueueFilter,
  ModerationQueueRow,
  ModerationReportDetail,
  ModerationOutcome,
  ModerationActRequest,
  ModerationAppealFilter,
  ModerationAppealRow,
  ModerationAppealDetail,
  AppealDecision,
  MyAppeal,
} from "./apiShared";

/** The moderation, report and appeal calls of the REST client. */
export function createModerationApi(t: ApiTransport) {
  return {
    getOwnModeration(signal?: AbortSignal): Promise<OwnModerationAction[]> {
      return t.request("OwnModerationActionList", "GET", "/users/me/moderation", undefined, signal);
    },

    /** File a local report; resolves to its opaque public id. */
    fileReport(body: FileReportRequest, signal?: AbortSignal): Promise<{ id: string }> {
      return t.request("PublicIdResponse", "POST", "/reports", body, signal);
    },

    getMyReports(signal?: AbortSignal): Promise<OwnReportSummary[]> {
      return t.request("OwnReportSummaryList", "GET", "/reports/mine", undefined, signal);
    },

    /** The moderator queue. 403 without MODERATE_MEMBERS. */
    getModerationQueue(
      state: ModerationQueueFilter,
      signal?: AbortSignal,
    ): Promise<ModerationQueueRow[]> {
      const query = state === "" ? "" : `?state=${state}`;
      return t.request("QueueRowList", "GET", `/moderation/queue${query}`, undefined, signal);
    },

    /** One report with its evidence. 404 for a report about the caller. */
    getModerationReport(id: string, signal?: AbortSignal): Promise<ModerationReportDetail> {
      return t.request(
        "ModerationReportDetail",
        "GET",
        `/moderation/queue/${encodeURIComponent(id)}`,
        undefined,
        signal,
      );
    },

    /** Take a report: 409 when another moderator already holds it or it closed. */
    assignModerationReport(id: string, signal?: AbortSignal): Promise<void> {
      return t.request(
        "NoBody",
        "POST",
        `/moderation/queue/${encodeURIComponent(id)}/assign`,
        undefined,
        signal,
      );
    },

    /** Add an internal note: 409 once the report is closed. */
    addModerationNote(id: string, body: string, signal?: AbortSignal): Promise<void> {
      return t.request(
        "NoBody",
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
      return t.request(
        "NoBody",
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
      return t.request(
        "ReportActResultOrNone",
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
      return t.request(
        "TimeoutResult",
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
      return t.request(
        "NicknameResult",
        "PUT",
        `/moderation/users/${userId}/nickname`,
        { display_name: displayName },
        signal,
      );
    },

    /** End a member's active timeout early: 404 when they have none. */
    liftTimeout(userId: number, signal?: AbortSignal): Promise<void> {
      return t.request(
        "NoBody",
        "POST",
        `/moderation/users/${userId}/untimeout`,
        undefined,
        signal,
      );
    },

    /** The moderator appeal queue. 403 without MODERATE_MEMBERS. */
    getModerationAppeals(
      state: ModerationAppealFilter,
      signal?: AbortSignal,
    ): Promise<ModerationAppealRow[]> {
      const query = state === "" ? "" : `?state=${state}`;
      return t.request("AppealRowList", "GET", `/moderation/appeals${query}`, undefined, signal);
    },

    getModerationAppeal(id: string, signal?: AbortSignal): Promise<ModerationAppealDetail> {
      return t.request(
        "ModerationAppealDetail",
        "GET",
        `/moderation/appeals/${encodeURIComponent(id)}`,
        undefined,
        signal,
      );
    },

    /** Take an appeal: 409 when someone else holds it or it closed; never forced. */
    assignModerationAppeal(id: string, signal?: AbortSignal): Promise<void> {
      return t.request(
        "NoBody",
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
      return t.request(
        "NoBody",
        "POST",
        `/moderation/appeals/${encodeURIComponent(id)}/decide`,
        { outcome, note },
        signal,
      );
    },

    /** Records that the caller read their own warning. 404 when it is already
     *  acknowledged (or not theirs). */
    acknowledgeNotice(actionId: number, signal?: AbortSignal): Promise<void> {
      return t.request("NoBody", "POST", `/users/me/notices/${actionId}/ack`, undefined, signal);
    },

    /** Files an appeal against the caller's own moderation action (its ledger id).
     *  409 ALREADY_APPEALED, 429 RATE_LIMITED, 404 when not theirs or gone. */
    fileAppeal(actionId: number, body: string, signal?: AbortSignal): Promise<{ id: string }> {
      return t.request(
        "PublicIdResponse",
        "POST",
        "/appeals/",
        { action_id: actionId, body },
        signal,
      );
    },

    getMyAppeals(signal?: AbortSignal): Promise<MyAppeal[]> {
      return t.request("MyAppealList", "GET", "/appeals/mine", undefined, signal);
    },

    /** Open or assigned appeals only: 409 once decided or withdrawn, 404 when not the caller's. */
    withdrawAppeal(publicId: string, signal?: AbortSignal): Promise<void> {
      return t.request(
        "NoBody",
        "POST",
        `/appeals/${encodeURIComponent(publicId)}/withdraw`,
        undefined,
        signal,
      );
    },
  };
}
