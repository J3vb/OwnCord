/**
 * The Create Thread dialog (WP 6.9c): a name (prefilled from the message, 1 to
 * 100 characters) and how long the thread may sit idle before it is archived.
 *
 * Sends `thread_create` and settles on its own reply, matched by envelope id:
 * `thread_create_ok` opens the thread; `THREAD_EXISTS` (someone else started
 * one on this message first) opens the one that won; any other refusal is a
 * line in the dialog, so the dispatcher's generic toast is told to skip this id
 * (forwardRequests, the claim the Forward picker uses). Loaded on first use, never at startup.
 */

import { createElement, setOwnedTimeout } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createModal } from "@lib/modalFactory";
import type { WsClient } from "@lib/ws";
import type { ThreadAutoArchiveMinutes, ThreadInfo } from "@lib/types";
import { getChannelMessages } from "@stores/messages.store";
import { claimForwardRequest, releaseForwardRequest } from "../features/messaging/forwardRequests";
import {
  AUTO_ARCHIVE_CHOICES,
  DEFAULT_AUTO_ARCHIVE,
  THREAD_NAME_MAX,
  cleanThreadName,
  isConnected,
  suggestThreadName,
} from "../features/threads/threadCommands";
import { threadsText } from "../i18n/threads";
import { WsErrorCode } from "@lib/protocolTypes";

/** How long to wait for the server's answer before saying so. */
const CREATE_TIMEOUT_MS = 20_000;

const PERIOD_KEYS = {
  60: "period.60",
  1440: "period.1440",
  4320: "period.4320",
  10080: "period.10080",
} as const satisfies Record<ThreadAutoArchiveMinutes, string>;

export interface CreateThreadDialogOptions {
  readonly ws: WsClient;
  readonly channelId: number;
  readonly messageId: number;
  /** The mounted channel's lifetime: leaving it closes the dialog. */
  readonly signal: AbortSignal;
  /** The server made the thread (its whole state). */
  readonly onCreated: (thread: ThreadInfo) => void;
  /** The message already had a thread; this is its id. */
  readonly onExists: (threadId: number) => void;
  readonly fallbackFocus?: () => HTMLElement | null;
}

/** The dialog's refusal line for a server error code. */
export function createErrorText(code: string): string {
  switch (code) {
    case WsErrorCode.FORBIDDEN:
      return threadsText("create.error.FORBIDDEN");
    case WsErrorCode.NOT_FOUND:
      return threadsText("create.error.NOT_FOUND");
    case WsErrorCode.RATE_LIMITED:
      return threadsText("create.error.RATE_LIMITED");
    case "UNCONFIRMED":
      return threadsText("create.error.UNCONFIRMED");
    case "OFFLINE":
      return threadsText("create.error.OFFLINE");
    default:
      return threadsText("create.error.other");
  }
}

export function openCreateThreadDialog(options: CreateThreadDialogOptions): void {
  const { ws, channelId, messageId, signal } = options;
  const owner = new Disposable();
  const starter = getChannelMessages(channelId).find((m) => m.id === messageId);

  const titleId = `create-thread-title-${messageId}`;
  const content = createElement("div");
  const header = createElement("div", { class: "modal-header" });
  header.appendChild(createElement("h3", { id: titleId }, threadsText("create.title")));
  const form = createElement("form", { class: "modal-body create-thread-form" });

  const nameId = `create-thread-name-${messageId}`;
  const nameLabel = createElement("label", { for: nameId }, threadsText("create.nameLabel"));
  const nameInput = createElement("input", {
    id: nameId,
    type: "text",
    maxlength: String(THREAD_NAME_MAX),
    autocomplete: "off",
    "data-testid": "create-thread-name",
  });
  nameInput.value = suggestThreadName(starter?.content ?? "");

  const periodId = `create-thread-period-${messageId}`;
  const periodLabel = createElement("label", { for: periodId }, threadsText("create.periodLabel"));
  const periodSelect = createElement("select", {
    id: periodId,
    "data-testid": "create-thread-period",
  });
  for (const minutes of AUTO_ARCHIVE_CHOICES) {
    const option = createElement(
      "option",
      { value: String(minutes) },
      threadsText(PERIOD_KEYS[minutes]),
    );
    if (minutes === DEFAULT_AUTO_ARCHIVE) option.selected = true;
    periodSelect.appendChild(option);
  }

  const errorEl = createElement("p", {
    class: "create-thread-error",
    role: "alert",
    "data-testid": "create-thread-error",
  });
  errorEl.hidden = true;

  const footer = createElement("div", { class: "modal-footer" });
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "create-thread-cancel" },
    threadsText("create.cancel"),
  );
  const submit = createElement(
    "button",
    { class: "btn-primary", type: "submit", "data-testid": "create-thread-submit" },
    threadsText("create.submit"),
  );
  footer.append(cancel, submit);
  form.append(nameLabel, nameInput, periodLabel, periodSelect, errorEl);
  content.append(header, form, footer);
  // The submit button sits in the footer, outside the form element.
  form.id = `create-thread-form-${messageId}`;
  submit.setAttribute("form", form.id);

  const modal = createModal({
    content,
    ariaLabelledBy: titleId,
    overlayAttrs: { "data-testid": "create-thread-dialog" },
    signal,
    onClose: () => owner.destroy(),
    ...(options.fallbackFocus !== undefined && { fallbackFocus: options.fallbackFocus }),
  });
  cancel.addEventListener("click", () => modal.close(), { signal: owner.signal });

  let requestId: string | null = null;
  let stopWaiting: (() => void) | null = null;

  function showError(text: string): void {
    errorEl.textContent = text;
    errorEl.hidden = false;
  }

  function settle(): void {
    stopWaiting?.();
    stopWaiting = null;
    if (requestId !== null) releaseForwardRequest(requestId);
    requestId = null;
    submit.disabled = false;
    submit.textContent = threadsText("create.submit");
  }

  function fail(code: string): void {
    settle();
    showError(createErrorText(code));
  }

  form.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      if (requestId !== null) return;
      errorEl.hidden = true;
      const name = cleanThreadName(nameInput.value);
      if (name === null) {
        showError(threadsText("create.nameRequired"));
        nameInput.focus();
        return;
      }
      if (!isConnected()) {
        showError(createErrorText("OFFLINE"));
        return;
      }
      const minutes = Number(periodSelect.value) as ThreadAutoArchiveMinutes;
      const id = ws.send({
        type: "thread_create",
        payload: {
          channel_id: channelId,
          message_id: messageId,
          name,
          auto_archive_minutes: minutes,
        },
      });
      requestId = id;
      claimForwardRequest(id);
      submit.disabled = true;
      submit.textContent = threadsText("create.sending");

      const unsubs = [
        ws.on("thread_create_ok", (payload, replyId) => {
          if (replyId !== id) return;
          settle();
          modal.close();
          options.onCreated(payload.thread);
        }),
        ws.on("error", (payload, replyId) => {
          if (replyId !== id) return;
          if (payload.code === WsErrorCode.THREAD_EXISTS && payload.thread_id !== undefined) {
            settle();
            modal.close();
            options.onExists(payload.thread_id);
            return;
          }
          fail(payload.code);
        }),
        ws.onSendFailure((failedId) => {
          if (failedId === id) fail("OFFLINE");
        }),
      ];
      const cancelTimer = setOwnedTimeout(
        owner.signal,
        () => fail("UNCONFIRMED"),
        CREATE_TIMEOUT_MS,
      );
      stopWaiting = () => {
        for (const unsub of unsubs) unsub();
        cancelTimer();
      };
    },
    { signal: owner.signal },
  );
  owner.addCleanup(() => {
    stopWaiting?.();
    if (requestId !== null) releaseForwardRequest(requestId);
  });

  nameInput.focus();
  nameInput.select();
}
