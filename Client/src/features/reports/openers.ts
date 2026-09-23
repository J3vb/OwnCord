/**
 * The report entry points (B9-10): each turns the local thing on screen into
 * the dialog's targets, using only identifiers the client already holds.
 * Loaded on first use, so the report form stays out of the startup bundle.
 */

import type { ApiClient } from "@lib/api";
import type { ModalInstance } from "@lib/modalFactory";
import type { Message } from "@stores/messages.store";
import { reportsText as t } from "../../i18n/reports";
import { openReportDialog, type ReportTarget } from "./reportDialog";

interface OpenerContext {
  readonly api: Pick<ApiClient, "fileReport">;
  readonly signal: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
}

/** Report a message, or one of its attachments by its upload id. */
export function openMessageReport(
  ctx: OpenerContext & { readonly msg: Pick<Message, "id" | "attachments"> },
): ModalInstance {
  const targets: [ReportTarget, ...ReportTarget[]] = [
    { type: "message", id: String(ctx.msg.id), label: t("dialog.targetMessage") },
  ];
  for (const att of ctx.msg.attachments) {
    targets.push({
      type: "attachment",
      id: att.id,
      label: t("dialog.targetAttachment", { name: att.filename }),
    });
  }
  return openReportDialog({ ...ctx, title: t("dialog.titleMessage"), targets });
}

/**
 * Report a user by their id; `name` is only the dialog's title. The member
 * list rebuilds its rows, so focus returns to the user's current row, else the
 * list's first row, when the one that opened the form has gone.
 */
export function openUserReport(
  ctx: OpenerContext & {
    readonly userId: number;
    readonly name: string;
    readonly list: HTMLElement;
  },
): ModalInstance {
  const { list, userId } = ctx;
  return openReportDialog({
    ...ctx,
    fallbackFocus: () =>
      list.querySelector<HTMLElement>(`[data-testid="member-${userId}"]`) ??
      list.querySelector<HTMLElement>(".member-item"),
    title: t("dialog.titleUser", { name: ctx.name }),
    targets: [{ type: "user", id: String(ctx.userId), label: ctx.name }],
  });
}
