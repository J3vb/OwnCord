/**
 * The Ban dialog (WP 3C-5c): one place that collects a reason, a ban length and
 * how much message history to delete, then sends the ban.
 *
 * The request is the caller's (`submit`); this module owns what the answer
 * means:
 * - Messages were asked for and the response has no `purge`: the server does
 *   not support the field (it ignored it). The ban stands, the dialog closes
 *   and a warning says the messages were kept.
 * - `purge.complete` is false: the ban stands but the purge stopped early. The
 *   form locks and Retry resends the identical request, so `ban_reason` and
 *   `ban_duration_hours` are unchanged (the server then only continues the
 *   deletion).
 * - A rejection (network drop, a refusal because a role changed meanwhile):
 *   the dialog stays open with the error, and the same button sends again.
 * One request is in flight at a time, and Cancel/Escape before a submit send
 * nothing.
 *
 * Deleting history needs MANAGE_MESSAGES as well as BAN_MEMBERS on the server,
 * so without `canDeleteMessages` the field is not offered and the request
 * sends 0.
 *
 * A resend only counts as a purge retry on the server when the ban fields are
 * unchanged, and for a temporary ban only within about an hour of the stored
 * expiry (`banRetryExpirySlack`). So `pending` (what Retry resends) is dropped
 * after an hour and the form unlocks, rather than sending a stale retry as a
 * fresh ban without the moderator seeing the fields. A dropped connection on a
 * request that asked for deletion also keeps its request as `pending`: the ban
 * may have been written, and Retry must resend exactly the same request.
 * The backdrop never closes this dialog (a stray click could lose Retry); if
 * Escape or the owner closes it while a purge is unfinished, a toast reports
 * how many messages were deleted.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/ime";
import { errorText, TransportError, type BanMemberResponse } from "@lib/api";
import { createElement, setOwnedTimeout, setText } from "@lib/dom";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import type { ToastType } from "@components/Toast";
import { shellText } from "../../i18n/shell";
import { moderationText as t } from "../../i18n/moderation";

/** The longest reason the server accepts. */
export const BAN_REASON_MAX = 200;

/** Ban lengths offered (label key, hours; 0 = permanent). */
export const BAN_DURATIONS = [
  { key: "banDialog.forever", hours: 0 },
  { key: "banDialog.oneHour", hours: 1 },
  { key: "banDialog.oneDay", hours: 24 },
  { key: "banDialog.sevenDays", hours: 24 * 7 },
  { key: "banDialog.thirtyDays", hours: 24 * 30 },
] as const;

/** Message history choices (label key, seconds; 0 = delete nothing). */
export const BAN_DELETE_OPTIONS = [
  { key: "banDialog.delete.none", seconds: 0 },
  { key: "banDialog.delete.1h", seconds: 3600 },
  { key: "banDialog.delete.6h", seconds: 6 * 3600 },
  { key: "banDialog.delete.12h", seconds: 12 * 3600 },
  { key: "banDialog.delete.24h", seconds: 24 * 3600 },
  { key: "banDialog.delete.3d", seconds: 3 * 86400 },
  { key: "banDialog.delete.7d", seconds: 7 * 86400 },
] as const;

/** How a ban's message purge went: `deleted` counts one request only. */
export interface BanPurge {
  readonly deleted: number;
  readonly complete: boolean;
}

/** The response's `purge`, or null when it is absent or not the documented
 *  shape. Null means the server did not act on the field. */
export function readBanPurge(response: BanMemberResponse | null | undefined): BanPurge | null {
  const purge = response?.purge as Partial<BanPurge> | null | undefined;
  return typeof purge?.deleted === "number" && typeof purge.complete === "boolean"
    ? { deleted: purge.deleted, complete: purge.complete }
    : null;
}

export interface BanRequest {
  readonly reason: string;
  readonly durationHours: number;
  readonly deleteMessageSeconds: number;
}

/** How long `pending` stays valid: the server's retry slack is about an hour. */
const RETRY_WINDOW_MS = 60 * 60 * 1000;

export interface BanDialogOptions {
  /** Display name, for the title. */
  readonly name: string;
  /** Handle, for the toasts (the same text the ban toast always used). */
  readonly username: string;
  /** Whether the viewer holds MANAGE_MESSAGES (the server requires it, on top of
   *  BAN_MEMBERS, to delete history). False hides the choice and sends 0. */
  readonly canDeleteMessages: boolean;
  /** Sends one ban request; rejects with the failure. */
  readonly submit: (request: BanRequest) => Promise<BanMemberResponse>;
  /** The server accepted a ban request (it may still be finishing a purge):
   *  refresh whatever lists the ban changes. */
  readonly onBanned?: () => void;
  readonly notify: (message: string, type: ToastType) => void;
  /** Closes the dialog with its owner. */
  readonly signal?: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
}

const numberOr0 = (value: string): number => Number.parseInt(value, 10) || 0;

function field(labelId: string, labelText: string, control: HTMLElement): HTMLElement {
  const group = createElement("div", { class: "form-group" });
  group.append(createElement("label", { class: "form-label", for: labelId }, labelText), control);
  return group;
}

export function openBanDialog(options: BanDialogOptions): ModalInstance {
  const { name, username, notify } = options;

  const titleId = "ban-dialog-title";
  const content = createElement("div");
  const header = createElement("div", { class: "modal-header" });
  header.append(createElement("h3", { id: titleId }, t("banDialog.title", { name })));

  const body = createElement("div", { class: "modal-body" });
  const bodyText = createElement("p", {}, t("banDialog.body"));

  const reasonInput = createElement("input", {
    id: "ban-dialog-reason",
    class: "form-input",
    type: "text",
    maxlength: String(BAN_REASON_MAX),
    autocomplete: "off",
    "data-testid": "ban-reason-input",
  });
  const durationSelect = createElement("select", {
    id: "ban-dialog-duration",
    class: "form-input",
    "data-testid": "ban-duration-select",
  });
  for (const d of BAN_DURATIONS) {
    durationSelect.appendChild(createElement("option", { value: String(d.hours) }, t(d.key)));
  }
  const deleteSelect = createElement("select", {
    id: "ban-dialog-delete",
    class: "form-input",
    "data-testid": "ban-delete-select",
  });
  for (const d of BAN_DELETE_OPTIONS) {
    deleteSelect.appendChild(createElement("option", { value: String(d.seconds) }, t(d.key)));
  }

  const status = createElement("div", {
    class: "form-group",
    role: "alert",
    style: "color: var(--text-danger); font-size: 13px; display: none;",
    "data-testid": "ban-status",
  });

  body.append(
    bodyText,
    field("ban-dialog-reason", t("banDialog.reasonLabel"), reasonInput),
    field("ban-dialog-duration", t("banDialog.durationLabel"), durationSelect),
  );
  if (options.canDeleteMessages) {
    body.append(field("ban-dialog-delete", t("banDialog.deleteLabel"), deleteSelect));
  }
  body.append(status);

  const footer = createElement("div", { class: "modal-footer" });
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "ban-cancel" },
    shellText("common.cancel"),
  );
  const confirm = createElement(
    "button",
    { class: "btn-danger", type: "button", "data-testid": "ban-confirm" },
    t("banDialog.confirm"),
  );
  footer.append(cancel, confirm);
  content.append(header, body, footer);

  let closed = false;
  let inFlight = false;
  /** Set once the ban is in and only the purge is unfinished: what Retry resends. */
  let pending: BanRequest | null = null;
  let deletedSoFar = 0;
  /** Aborted on close, so the retry-window timer never outlives the dialog. */
  const lifetime = new Disposable();
  let cancelExpiry: (() => void) | null = null;

  /** The unfinished-purge report for a dialog that closed before Retry. */
  const stoppedText = (): string => t("banDialog.purgeStopped", { name, count: deletedSoFar });

  const modal = createModal({
    content,
    ariaLabelledBy: titleId,
    overlayAttrs: { "data-testid": "ban-dialog" },
    // A stray backdrop click must not lose Retry.
    closeOnBackdrop: false,
    onClose: () => {
      closed = true;
      lifetime.destroy();
      if (pending !== null && !inFlight) notify(stoppedText(), "warning");
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fallbackFocus === undefined ? {} : { fallbackFocus: options.fallbackFocus }),
  });

  function showStatus(text: string): void {
    status.style.display = "block";
    setText(status, text);
  }

  function setBusy(busy: boolean): void {
    inFlight = busy;
    const locked = busy || pending !== null;
    reasonInput.disabled = locked;
    durationSelect.disabled = locked;
    deleteSelect.disabled = locked;
    if (busy) {
      // aria-disabled would keep the click live; the guard is `inFlight`.
      confirm.disabled = true;
      setText(confirm, t(pending === null ? "banDialog.banning" : "banDialog.retrying"));
    } else {
      confirm.disabled = false;
      setText(confirm, t(pending === null ? "banDialog.confirm" : "banDialog.retry"));
    }
  }

  function readForm(): BanRequest {
    return {
      reason: reasonInput.value.trim().slice(0, BAN_REASON_MAX),
      durationHours: numberOr0(durationSelect.value),
      deleteMessageSeconds: options.canDeleteMessages ? numberOr0(deleteSelect.value) : 0,
    };
  }

  /** Keep `request` as what Retry resends, for an hour at most. */
  function holdForRetry(request: BanRequest): void {
    pending = request;
    cancelExpiry?.();
    cancelExpiry = setOwnedTimeout(
      lifetime.signal,
      () => {
        pending = null;
        if (inFlight || closed) return;
        setBusy(false);
        showStatus(t("banDialog.retryExpired"));
      },
      RETRY_WINDOW_MS,
    );
  }

  function bannedToast(req: BanRequest): string {
    return req.durationHours > 0
      ? shellText("members.bannedFor", { username, hours: req.durationHours })
      : shellText("members.banned", { username });
  }

  async function send(): Promise<void> {
    if (inFlight) return;
    const request = pending ?? readForm();
    status.style.display = "none";
    setBusy(true);
    let result: BanMemberResponse;
    try {
      result = await options.submit(request);
    } catch (err) {
      // The ban may have been written before the connection dropped: keep the
      // exact request so Retry cannot differ from it.
      if (err instanceof TransportError && request.deleteMessageSeconds > 0) {
        holdForRetry(request);
      }
      if (closed) {
        notify(errorText(err, shellText("members.banFailed")), "error");
        return;
      }
      setBusy(false);
      showStatus(errorText(err, shellText("members.banFailed")));
      // The disabled button held focus; keep it inside the dialog's trap.
      confirm.focus();
      return;
    }
    options.onBanned?.();

    if (request.deleteMessageSeconds > 0) {
      const purge = readBanPurge(result);
      if (purge === null) {
        // An older server ignores the field and says nothing about it.
        notify(t("banDialog.purgeUnsupported", { username }), "warning");
        pending = null;
        modal.close();
        return;
      }
      deletedSoFar += purge.deleted;
      if (!purge.complete) {
        holdForRetry(request);
        if (closed) {
          notify(stoppedText(), "warning");
          return;
        }
        setBusy(false);
        showStatus(t("banDialog.purgeIncomplete", { name, count: deletedSoFar }));
        confirm.focus();
        return;
      }
      notify(t("banDialog.purgeDone", { username, count: deletedSoFar }), "success");
    } else {
      notify(bannedToast(request), "success");
    }
    pending = null;
    modal.close();
  }

  cancel.addEventListener("click", () => modal.close());
  confirm.addEventListener("click", () => void send());
  reasonInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter" || isImeCommit(e)) return;
    e.preventDefault();
    void send();
  });
  reasonInput.focus();

  return modal;
}
