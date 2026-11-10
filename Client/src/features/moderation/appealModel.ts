/**
 * The Appeals tab's view-independent pieces: the queue filters, the view
 * handles and the refusal text for a failed write.
 */

import { ApiClientError, serverErrorText, type ModerationAppealFilter } from "@lib/api";
import { RestErrorCode } from "@lib/protocolTypes";
import { moderationText as t } from "../../i18n/moderation";
import type { AppealWrite } from "./AppealDetail";
import { isStatus } from "./api";

export const FILTERS = [
  { value: "", labelKey: "appeal.filter.active", countKey: "appeal.count.active" },
  { value: "open", labelKey: "appeal.filter.open", countKey: "appeal.count.open" },
  { value: "assigned", labelKey: "appeal.filter.assigned", countKey: "appeal.count.assigned" },
  { value: "decided", labelKey: "appeal.filter.decided", countKey: "appeal.count.decided" },
] as const satisfies readonly {
  value: ModerationAppealFilter;
  labelKey: string;
  countKey: string;
}[];

export interface AppealsView {
  /** The other tab lost authority: clear this one too. */
  readonly deny: () => void;
}

export interface AppealsOptions {
  /** This tab lost authority: clear the other one too. */
  readonly onDenied: () => void;
  /** Open a linked report in Reports. */
  readonly openReport: (id: string) => void;
}

export function errorText(w: AppealWrite, err: unknown): string {
  if (isStatus(err, 403, RestErrorCode.SELF_REVIEW)) return t("appeal.selfReview");
  if (isStatus(err, 409, RestErrorCode.REVERSAL_FAILED)) return t("appeal.reversalFailed");
  if (isStatus(err, 409))
    return t(w.kind === "assign" ? "appeal.conflict.assign" : "appeal.conflict.decide");
  if (isStatus(err, 400)) {
    const message = err instanceof ApiClientError ? serverErrorText(err.code, err.message, "") : "";
    if (message !== "") return t("appeal.invalid", { message });
  }
  // No answer, or an internal failure: the change may still have been recorded.
  return t("appeal.unknown");
}
