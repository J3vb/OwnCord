/**
 * The Moderation Center's view-independent pieces: the queue filters, the
 * write kinds, the request each write sends and the text each answer or
 * refusal shows.
 */

import {
  ApiClientError,
  errorText,
  serverErrorText,
  type ModerationActRequest,
  type ModerationOutcome,
  type ModerationQueueFilter,
} from "@lib/api";
import { RestErrorCode } from "@lib/protocolTypes";
import { moderationText as t } from "../../i18n/moderation";
import type { FeatureViewContext } from "../navigation/destinations";
import { ENFORCE, UNITS, type ActionDraft, type ActionWrite } from "./ActionForms";
import { isStatus } from "./api";
import type { WorkflowWrite } from "./Workflow";

export const FILTERS = [
  { value: "", labelKey: "filter.active", countKey: "count.active" },
  { value: "open", labelKey: "filter.open", countKey: "count.open" },
  { value: "assigned", labelKey: "filter.assigned", countKey: "count.assigned" },
  { value: "closed", labelKey: "filter.closed", countKey: "count.closed" },
] as const satisfies readonly {
  value: ModerationQueueFilter;
  labelKey: string;
  countKey: string;
}[];

let viewSeq = 0;

/** The next view number: tab and filter ids stay unique across mounted centers. */
export function nextViewSeq(): number {
  return ++viewSeq;
}

export type Write = WorkflowWrite | ActionWrite;
export const isAction = (w: Write): w is ActionWrite =>
  w.kind !== "assign" && w.kind !== "note" && w.kind !== "close";

export interface ReportsView {
  readonly deny: () => void;
  /** Open a report by id, kept open outside the filter (an appeal's link). */
  readonly openLinked: (id: string) => void;
}

/** A removal's refusal: the channel's rules, the reader's bit, or the server's own words. */
function removalRefusal(code: string, message: string): string {
  if (message === "forbidden: channel is archived") return t("act.refusedArchived");
  if (message === "forbidden: cannot delete this message") return t("act.refusedRemoval");
  const text = serverErrorText(code, message, "");
  return text === "" ? t("act.unknown") : t("act.invalid", { message: text });
}

export function actionErrorText(w: ActionWrite, err: unknown): string {
  if (isStatus(err, 403, RestErrorCode.SELF_REVIEW)) return t("write.selfReview");
  if (isStatus(err, 403)) {
    // Kick and ban each have their own bit, which a role change can take
    // while MODERATE_MEMBERS stays, so a refusal is not only about rank.
    if (w.kind === "removal")
      return removalRefusal((err as ApiClientError).code, (err as ApiClientError).message);
    return t(w.kind === "kick" || w.kind === "ban" ? "act.refusedEnforce" : "act.refused");
  }
  if (isStatus(err, 404) && w.kind === "lift") return t("act.liftNone");
  // 409 ALREADY_DELETED (removing an already-removed message): a
  // known end state, not the uncertain "may still have been recorded" answer.
  if (isStatus(err, 409, RestErrorCode.ALREADY_DELETED)) return t("act.alreadyDeleted");
  if (isStatus(err, 400)) {
    const message = err instanceof ApiClientError ? serverErrorText(err.code, err.message, "") : "";
    if (message !== "") return t("act.invalid", { message });
  }
  // No answer, or an internal failure: the action may still have been recorded.
  return err instanceof ApiClientError ? errorText(err, t("act.unknown")) : t("act.unknown");
}

const WRITE_DONE = { assign: "done.assign", note: "done.note", close: "done.close" } as const;

const WRITE_CONFLICT = {
  assign: "conflict.assign",
  note: "conflict.note",
  close: "conflict.close",
} as const;

export function sendWrite(
  api: FeatureViewContext["api"],
  signal: AbortSignal,
  id: string,
  w: Write,
): Promise<unknown> {
  if (w.kind === "assign") return api.assignModerationReport(id, signal);
  if (w.kind === "note") return api.addModerationNote(id, w.body, signal);
  if (w.kind === "close") return api.closeModerationReport(id, w.outcome, signal);
  if (w.kind === "lift") return api.liftTimeout(w.userId, signal);
  const body: ModerationActRequest =
    w.kind === "timeout"
      ? { kind: "timeout", reason: w.reason, duration_seconds: w.amount * UNITS[w.unit].seconds }
      : { kind: w.kind, reason: w.reason };
  return api.actOnModerationReport(id, body, signal);
}

/** What the server's answer means; a timeout's voice half is "applied" only when it says so. */
export function doneText(w: Write, answer: unknown): string {
  if (w.kind === "warning") return t("done.warning");
  if (w.kind === "lift") return t("done.lift");
  if (w.kind === "removal" || w.kind === "kick" || w.kind === "ban")
    return t(ENFORCE[w.kind].doneKey);
  if (w.kind === "timeout") {
    const length = t(UNITS[w.unit].lengthKey, { count: w.amount });
    const voice = (answer as { voice?: unknown } | undefined)?.voice;
    return t(voice === "applied" ? "done.timeoutApplied" : "done.timeoutSkipped", { length });
  }
  return t(WRITE_DONE[w.kind]);
}

export function reviewErrorText(w: WorkflowWrite, err: unknown): string {
  if (isStatus(err, 409)) return t(WRITE_CONFLICT[w.kind]);
  if (isStatus(err, 403)) return t("write.selfReview");
  return t(isStatus(err, 400) ? "write.invalid" : "write.error");
}

/** Empty the action field a sent write used, on the draft kept for report `id`. */
export function clearSentActDraft(
  actDraft: ActionDraft & { id: string },
  id: string,
  w: Write,
): void {
  if (actDraft.id !== id) return;
  if (w.kind === "warning") actDraft.warn = "";
  if (w.kind === "timeout") {
    actDraft.reason = "";
    actDraft.amount = "";
  }
  if (w.kind === "removal" || w.kind === "kick" || w.kind === "ban") actDraft.enforce = "";
}

/** The unsaved note and chosen outcome of the review form, for report `id`. */
export interface ReviewDraft {
  readonly id: string;
  readonly text: string;
  readonly outcome: ModerationOutcome | null;
}

/** The unsaved action reasons and length, for the report with `id`. */
export type ActDraft = ActionDraft & { id: string };

/** No review draft. Compared by identity nowhere; a fresh empty draft is the same. */
export const NO_DRAFT: ReviewDraft = { id: "", text: "", outcome: null };

/** Read and replace the drafts kept for the open report. */
export interface ReportDrafts {
  review(): ReviewDraft;
  setReview(next: ReviewDraft): void;
  act(): ActDraft;
  setAct(next: ActDraft): void;
}
