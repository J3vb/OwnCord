/**
 * The New Post dialog: the forum's guidelines, a title (required,
 * with a counter), the tag picker (a required marker when the forum asks for a
 * tag), the opening message and its attachments. Loaded on first use, never at
 * startup.
 *
 * One `client_message_id` names one logical post. It is minted on the first
 * attempt and kept across retries of the same content, so a post whose ack was
 * lost is answered with the same ack by the server (`deduplicated`) instead of
 * being created twice; editing the post makes it a different one and mints a
 * new id. The ack is matched by that id as well as by the envelope id, so an
 * ack that arrives after a timeout still finishes the dialog.
 *
 * Attachments go through the same upload route the composer uses
 * (`api.uploadFile`, `api.discardUpload`); the ids ride the frame.
 */

import { createElement, setOwnedTimeout, setText } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon } from "@lib/icons";
import { createModal } from "@lib/ui/modalFactory";
import { errorText, type ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { newClientMessageId, pendingMessageRetryFloor } from "@lib/pendingMessages";
import type { WsClient } from "@lib/ws";
import type { ThreadInfo } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { showToast } from "@lib/ui/toast";
import { claimForwardRequest, releaseForwardRequest } from "../messaging/forwardRequests";
import { forumsText } from "../../i18n/forums";
import { POST_TITLE_MAX, cleanPostTitle } from "./forumModel";
import { buildTagSection, fieldGroup } from "./postTagPicker";
import { postErrorText, type Attachment, type ErrorField } from "./newPostParts";

export { postErrorText } from "./newPostParts";

const log = createLogger("forum-new-post");

/** How long to wait for the server's answer before saying so. */
const POST_TIMEOUT_MS = 20_000;
/** The server rejects a frame with more attachments than this. */
const MAX_ATTACHMENTS = 10;

export interface NewPostDialogOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  /** The forum. */
  readonly channelId: number;
  /** The mounted forum's lifetime: leaving it closes the dialog. */
  readonly signal: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
  /** The server made the post (its whole state); the opener shows it. */
  readonly onCreated: (post: ThreadInfo) => void;
  /** The dialog went away (posted or cancelled); the opener may open another. */
  readonly onClosed?: () => void;
}

export function openNewPostDialog(options: NewPostDialogOptions): void {
  const { ws, api, channelId, signal } = options;
  const owner = new Disposable();
  const forum = channelsStore.getState().channels.get(channelId);
  const tags = (forum?.forum?.tags ?? []).toSorted(
    (a, b) => a.position - b.position || a.id - b.id,
  );
  const requireTag = forum?.forum?.require_tag === true && tags.length > 0;
  const guidelines = (forum?.topic ?? "").trim();

  const titleId = `forum-post-title-${channelId}`;
  const header = createElement("div", { class: "modal-header" });
  header.appendChild(createElement("h3", { id: titleId }, forumsText("dialog.title")));
  const form = createElement("form", { class: "modal-body forum-post-form" });
  form.id = `forum-post-form-${channelId}`;

  // ── Guidelines ───────────────────────────────────────────────────────────
  if (guidelines !== "") {
    const box = createElement("div", {
      class: "forum-dialog-guidelines",
      "data-testid": "forum-dialog-guidelines",
    });
    box.append(
      createElement("strong", {}, forumsText("dialog.guidelines")),
      createElement("p", {}, guidelines),
    );
    form.appendChild(box);
  }

  // ── Title ────────────────────────────────────────────────────────────────
  const titleInputId = `forum-post-name-${channelId}`;
  const titleInput = createElement("input", {
    class: "form-input",
    id: titleInputId,
    type: "text",
    maxlength: String(POST_TITLE_MAX),
    autocomplete: "off",
    placeholder: forumsText("dialog.titlePlaceholder"),
    required: "",
    "data-testid": "forum-post-title",
  });
  const counter = createElement("span", {
    class: "forum-title-count",
    "data-testid": "forum-post-count",
  });
  const paintCounter = (): void =>
    setText(
      counter,
      forumsText("dialog.titleCount", {
        count: Array.from(titleInput.value).length,
        max: POST_TITLE_MAX,
      }),
    );
  paintCounter();
  titleInput.addEventListener("input", paintCounter, { signal: owner.signal });
  const titleRow = createElement("div", { class: "forum-field-head" });
  titleRow.append(
    createElement(
      "label",
      { class: "form-label", for: titleInputId },
      forumsText("dialog.titleLabel"),
    ),
    counter,
  );
  titleInput.addEventListener("input", () => clearError("title"), { signal: owner.signal });
  form.append(fieldGroup(titleRow, titleInput));

  // ── Tags ─────────────────────────────────────────────────────────────────
  const picked = new Set<number>();
  let firstTagChip: HTMLButtonElement | null = null;
  if (tags.length > 0) {
    const section = buildTagSection({
      tags,
      requireTag,
      channelId,
      picked,
      onPick: () => clearError("tags"),
      signal: owner.signal,
    });
    firstTagChip = section.firstChip;
    form.append(section.group);
  }

  // ── Message and attachments ──────────────────────────────────────────────
  const messageId = `forum-post-message-${channelId}`;
  const messageInput = createElement("textarea", {
    class: "form-input",
    id: messageId,
    rows: "6",
    placeholder: forumsText("dialog.messagePlaceholder"),
    "data-testid": "forum-post-message",
  });
  messageInput.addEventListener("input", () => clearError("message"), { signal: owner.signal });
  form.append(
    fieldGroup(
      createElement(
        "label",
        { class: "form-label", for: messageId },
        forumsText("dialog.messageLabel"),
      ),
      messageInput,
    ),
  );

  const attachments: Attachment[] = [];
  const chipList = createElement("ul", {
    class: "forum-attachments",
    "data-testid": "forum-post-attachments",
  });
  const fileInput = createElement("input", {
    type: "file",
    multiple: "",
    hidden: "",
    "data-testid": "forum-post-file",
  });
  const attachBtn = createElement("button", {
    type: "button",
    class: "btn-modal-cancel forum-attach",
    "data-testid": "forum-post-attach",
  });
  setText(attachBtn, forumsText("dialog.attach"));
  // A server with uploads switched off advertises a zero ceiling.
  const uploadsOff = authStore.getState().uploadPolicy?.max_upload_bytes === 0;
  attachBtn.hidden = uploadsOff;
  attachBtn.addEventListener("click", () => fileInput.click(), { signal: owner.signal });

  function paintChip(a: Attachment): void {
    const label =
      a.status === "uploading"
        ? forumsText("dialog.uploading")
        : a.status === "failed"
          ? forumsText("dialog.uploadFailed")
          : "";
    a.chip.replaceChildren(createElement("span", { class: "forum-attachment-name" }, a.file.name));
    if (label !== "")
      a.chip.appendChild(createElement("span", { class: "forum-attachment-state" }, label));
    const remove = createElement("button", {
      type: "button",
      class: "forum-attachment-remove",
      "aria-label": forumsText("dialog.removeFile", { name: a.file.name }),
      "data-testid": "forum-post-remove-file",
    });
    remove.appendChild(createIcon("x", 12));
    remove.addEventListener("click", () => removeAttachment(a), { signal: owner.signal });
    a.chip.appendChild(remove);
    a.chip.classList.toggle("failed", a.status === "failed");
  }

  /** Withdraw an upload the server will never get a post for; best effort. */
  function discard(a: Attachment): void {
    a.owner.destroy();
    if (a.id !== null) {
      api.discardUpload(a.id).catch((err: unknown) => {
        log.warn("Discarding an unsent upload failed", { error: String(err) });
      });
    }
  }

  function removeAttachment(a: Attachment): void {
    const i = attachments.indexOf(a);
    if (i >= 0) attachments.splice(i, 1);
    a.chip.remove();
    discard(a);
  }

  function addFiles(files: readonly File[]): void {
    for (const file of files) {
      if (attachments.length >= MAX_ATTACHMENTS) break;
      const upload = new Disposable();
      const a: Attachment = {
        file,
        id: null,
        status: "uploading",
        owner: upload,
        chip: createElement("li", { class: "forum-attachment" }),
      };
      attachments.push(a);
      chipList.appendChild(a.chip);
      paintChip(a);
      api.uploadFile(file, upload.signal).then(
        (result) => {
          if (upload.signal.aborted) {
            // Removed while it ran: the copy that landed is released at once.
            api.discardUpload(result.id).catch(() => {});
            return;
          }
          a.id = result.id;
          a.status = "done";
          paintChip(a);
        },
        (err: unknown) => {
          if (upload.signal.aborted) return;
          a.status = "failed";
          log.warn("Forum attachment upload failed", { error: errorText(err, "") });
          paintChip(a);
        },
      );
    }
  }
  fileInput.addEventListener(
    "change",
    () => {
      addFiles(Array.from(fileInput.files ?? []));
      fileInput.value = "";
    },
    { signal: owner.signal },
  );
  // A pasted screenshot or copied file attaches; pasted text stays text.
  messageInput.addEventListener(
    "paste",
    (e: ClipboardEvent) => {
      if (uploadsOff) return;
      const files: File[] = [];
      for (const item of e.clipboardData?.items ?? []) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file !== null) files.push(file);
      }
      if (files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    },
    { signal: owner.signal },
  );
  form.append(attachBtn, fileInput, chipList);

  let errorField: ErrorField | null = null;
  const errorEl = createElement("p", {
    id: `forum-post-error-${channelId}`,
    class: "forum-post-error",
    role: "alert",
    "data-testid": "forum-post-error",
  });
  errorEl.hidden = true;
  form.appendChild(errorEl);

  // ── Footer ───────────────────────────────────────────────────────────────
  const footer = createElement("div", { class: "modal-footer" });
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "forum-post-cancel" },
    forumsText("dialog.cancel"),
  );
  const submit = createElement(
    "button",
    { class: "btn-modal-save", type: "submit", "data-testid": "forum-post-submit" },
    forumsText("dialog.submit"),
  );
  submit.setAttribute("form", form.id);
  footer.append(cancel, submit);

  let posted = false;
  /** An attempt went unanswered: its post may exist, so its uploads are kept. */
  let unconfirmed = false;
  /** Ids of earlier attempts of this dialog; a late ack for one is still ours. */
  const retiredIds = new Set<string>();
  /** The logical post being sent: its id lives as long as its content does. */
  let attempt: { readonly key: string; readonly clientMessageId: string } | null = null;
  let requestId: string | null = null;
  let stopWaiting: (() => void) | null = null;
  let offOk: (() => void) | null = null;
  const modal = createModal({
    content: header,
    ariaLabelledBy: titleId,
    overlayAttrs: { "data-testid": "forum-post-dialog" },
    // A typed post is worth more than a stray click outside the dialog.
    closeOnBackdrop: false,
    signal,
    onClose: () => {
      stopWaiting?.();
      stopWaiting = null;
      offOk?.();
      // Uploads that never became a post are released.
      if (!posted && !unconfirmed) for (const a of attachments) discard(a);
      owner.destroy();
      options.onClosed?.();
    },
    ...(options.fallbackFocus !== undefined && { fallbackFocus: options.fallbackFocus }),
  });
  modal.modal.append(form, footer);
  cancel.addEventListener("click", () => modal.close(), { signal: owner.signal });

  // ── Sending ──────────────────────────────────────────────────────────────
  function markInvalid(field: ErrorField | null, on: boolean): void {
    const el = field === "title" ? titleInput : field === "message" ? messageInput : null;
    if (el === null) return;
    if (on) {
      el.setAttribute("aria-invalid", "true");
      el.setAttribute("aria-describedby", errorEl.id);
    } else {
      el.removeAttribute("aria-invalid");
      el.removeAttribute("aria-describedby");
    }
  }
  function showError(text: string, field: ErrorField | null = null): void {
    markInvalid(errorField, false);
    setText(errorEl, text);
    errorEl.hidden = false;
    errorField = field;
    markInvalid(field, true);
  }
  /** Editing the field a validation error names takes the error away. */
  function clearError(field: ErrorField): void {
    if (errorField !== field) return;
    markInvalid(field, false);
    errorEl.hidden = true;
    errorField = null;
  }

  function settle(): void {
    stopWaiting?.();
    stopWaiting = null;
    if (requestId !== null) releaseForwardRequest(requestId);
    requestId = null;
    submit.disabled = false;
    setText(submit, forumsText("dialog.submit"));
  }

  function fail(code: string): void {
    if (code === "UNCONFIRMED") unconfirmed = true;
    settle();
    showError(postErrorText(code));
  }

  function finish(ack: {
    readonly thread?: ThreadInfo;
    readonly skipped_attachment_ids?: readonly string[];
  }): void {
    posted = true;
    settle();
    modal.close();
    const skipped = ack.skipped_attachment_ids?.length ?? 0;
    if (skipped > 0) showToast(forumsText("dialog.skipped", { count: skipped }), "info");
    if (ack.thread !== undefined) options.onCreated(ack.thread);
  }

  // The ack finishes the dialog whichever request it answers: a retry of a post
  // whose first ack was lost is answered with the same post.
  offOk = ws.on("forum_post_create_ok", (payload, replyId) => {
    const ackId = payload.client_message_id;
    const mine =
      (requestId !== null && replyId === requestId) ||
      (ackId !== undefined && (ackId === attempt?.clientMessageId || retiredIds.has(ackId)));
    if (mine) finish(payload);
  });

  /** The checks before sending; null (with the problem shown and focused) when one fails. */
  function validatePost(): { name: string; text: string; ready: Attachment[] } | null {
    const name = cleanPostTitle(titleInput.value);
    if (name === null) {
      showError(forumsText("error.titleRequired"), "title");
      titleInput.focus();
      return null;
    }
    if (requireTag && picked.size === 0) {
      showError(forumsText("error.tagRequired"), "tags");
      firstTagChip?.focus();
      return null;
    }
    if (attachments.some((a) => a.status === "uploading")) {
      showError(forumsText("error.uploading"));
      return null;
    }
    const ready = attachments.filter((a) => a.status === "done" && a.id !== null);
    const text = messageInput.value.trim();
    if (text === "" && ready.length === 0) {
      showError(forumsText("error.messageRequired"), "message");
      messageInput.focus();
      return null;
    }
    return { name, text, ready };
  }

  /** A new post's content gets a new client id; the old one stays ours, as its ack may still be on the way. */
  function nextAttempt(key: string): { readonly key: string; readonly clientMessageId: string } {
    if (attempt !== null) retiredIds.add(attempt.clientMessageId);
    const user = authStore.getState().user;
    const sessionOwner = { host: api.getConfig?.().host ?? "", userId: user?.id ?? 0 };
    return { key, clientMessageId: newClientMessageId(pendingMessageRetryFloor(sessionOwner)) };
  }

  /** Listen for this request's failure or silence until it settles. */
  function waitForAck(id: string): void {
    const unsubs = [
      ws.on("error", (payload, replyId) => {
        if (replyId === id) fail(payload.code);
      }),
      ws.onSendFailure((failedId) => {
        if (failedId === id) fail("OFFLINE");
      }),
    ];
    const cancelTimer = setOwnedTimeout(owner.signal, () => fail("UNCONFIRMED"), POST_TIMEOUT_MS);
    stopWaiting = () => {
      for (const unsub of unsubs) unsub();
      cancelTimer();
    };
  }

  form.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      if (requestId !== null) return;
      errorEl.hidden = true;
      const valid = validatePost();
      if (valid === null) return;
      if (uiStore.getState().connectionStatus !== "connected") {
        fail("OFFLINE");
        return;
      }
      const body = {
        channel_id: channelId,
        name: valid.name,
        content: valid.text,
        attachments: valid.ready.map((a) => a.id as string),
        tag_ids: tags.filter((t) => picked.has(t.id)).map((t) => t.id),
      };
      const key = JSON.stringify(body);
      if (attempt?.key !== key) attempt = nextAttempt(key);
      const id = ws.send({
        type: "forum_post_create",
        payload: { ...body, client_message_id: attempt.clientMessageId },
      });
      requestId = id;
      claimForwardRequest(id);
      submit.disabled = true;
      setText(submit, forumsText("dialog.sending"));
      waitForAck(id);
    },
    { signal: owner.signal },
  );
  owner.addCleanup(() => {
    stopWaiting?.();
    if (requestId !== null) releaseForwardRequest(requestId);
  });

  titleInput.focus();
}
