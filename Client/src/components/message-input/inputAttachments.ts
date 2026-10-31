/**
 * Attachments in the message input: the drop overlay, paste, the preview bar
 * with spoiler and remove buttons, and the upload that follows a send.
 */
import { Disposable } from "@lib/disposable";
import { dialogOpen } from "@lib/ui/dialogOpen";
import { desktop } from "../../platform/desktop";
import { createElement, appendChildren, setOwnedTimeout } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { errorText } from "@lib/api";
import { ATTACHMENT_TTL_MS } from "../../features/messaging/attachmentTtl";
import { toggleSpoilerFilename } from "../../features/messaging/spoilerAttachment";
import { authStore } from "@stores/auth.store";
import { messagingText } from "../../i18n/messaging";
import {
  FALLBACK_MAX_FILE_SIZE,
  uploadsDisabledByServer,
  refusedExtension,
  MAX_ATTACHMENTS,
  DROP_SLOTS,
  fileLabel,
  appendFileLabel,
  isPreviewableImage,
  relabelChip,
  paintSpoilerButton,
} from "./inputShared";
import type { InputState, InputApi } from "./inputState";
import type { NativeFile } from "../../platform/contracts/nativeFiles";
import type { MessageInputOptions, DraftUpload } from "../MessageInput";

/** Start uploading `file`, after `before` when given; the returned upload
 *  outlives any one chip. */
function startUpload(
  upload: NonNullable<MessageInputOptions["onUploadFile"]>,
  file: File,
  before?: Promise<void>,
): DraftUpload {
  const owner = new Disposable();
  let settledAt: number | undefined;
  let fraction: number | null = null;
  const onProgress = (f: number): void => {
    fraction = f;
    handle.onProgress?.(f);
  };
  const result =
    before === undefined
      ? upload(file, owner.signal, onProgress)
      : before.then(() => {
          owner.signal.throwIfAborted();
          return upload(file, owner.signal, onProgress);
        });
  // Also keeps a rejection in a draft that is never restored from
  // surfacing as unhandled; whichever chip follows the upload reads it.
  result.then(
    () => (settledAt = Date.now()),
    () => {},
  );
  const handle: DraftUpload = {
    filename: file.name,
    file,
    owner,
    get settledAt() {
      return settledAt;
    },
    get fraction() {
      return fraction;
    },
    onProgress: null,
    refreshing: null,
    result,
  };
  return handle;
}

/** Clipboard text a file manager writes for copied files: nothing, or one
 *  file URI or absolute path per line. */
export function looksLikeFileList(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return text === "";
  // "/home/me/a.png", never a slash command such as "/shrug".
  return lines.every((l) => l.startsWith("file://") || /^\/[^/\s][^/]*\/./.test(l));
}

export function createInputAttachments(st: InputState, api: InputApi) {
  /** "Upload to #channel" over the chat while a file from the OS is dragged
   *  over a slot that takes the drop. It ignores the pointer, so the drop
   *  still lands on the slot underneath. */
  function wireDropOverlay(container: Element): void {
    if (st.root === null) return;
    const area = container.closest(".chat-area") ?? container;
    const overlay = createElement("div", {
      class: "drop-overlay",
      "data-testid": "drop-overlay",
      "aria-hidden": "true",
    });
    const card = createElement("div", { class: "drop-overlay-card" });
    appendChildren(
      card,
      createElement("strong", {}, messagingText("drop.title", { channel: st.options.channelName })),
      createElement("span", {}, messagingText("drop.hint")),
    );
    overlay.appendChild(card);
    overlay.hidden = true;
    st.root.appendChild(overlay);
    const hide = (): void => {
      overlay.hidden = true;
    };
    const showOver = (target: EventTarget | null): void => {
      if (!acceptsDropAt(target)) {
        hide();
        return;
      }
      if (!overlay.hidden) return;
      const r = area.getBoundingClientRect();
      overlay.style.top = `${r.top}px`;
      overlay.style.left = `${r.left}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
      overlay.hidden = false;
    };
    document.addEventListener(
      "dragover",
      (e: DragEvent) => {
        if (e.dataTransfer?.types.includes("Files") !== true) return;
        showOver(e.target);
      },
      { signal: st.signal },
    );
    wireNativeDrops(showOver, hide);
    // A null relatedTarget is the drag leaving the window.
    document.addEventListener(
      "dragleave",
      (e: DragEvent) => {
        if (e.relatedTarget === null) hide();
      },
      { signal: st.signal },
    );
    document.addEventListener("drop", hide, { signal: st.signal });
    document.addEventListener("dragend", hide, { signal: st.signal });
  }

  /** A file dragged in from the OS lands on `target`: true when this
   *  composer takes it. */
  function acceptsDropAt(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      target.closest(DROP_SLOTS) !== null &&
      st.disabledReason === null &&
      !uploadsDisabledByServer() &&
      !dialogOpen()
    );
  }

  /** Drops the host reads itself (Linux): the overlay follows the native
   *  drag, and a drop over a slot that takes it attaches the files. */
  function wireNativeDrops(showOver: (target: Element | null) => void, hide: () => void): void {
    if (!desktop.nativeFiles.available) return;
    const stop = desktop.nativeFiles.onDrag((drag) => {
      if (st.signal.aborted) return;
      if (drag.kind === "leave") {
        hide();
        return;
      }
      const target = document.elementFromPoint(drag.x, drag.y);
      if (drag.kind === "over") {
        showOver(target);
        return;
      }
      hide();
      if (acceptsDropAt(target)) void handleNativeFiles(drag.files);
    });
    st.signal.addEventListener("abort", stop, { once: true });
  }

  function isStale(a: (typeof st.pendingAttachments)[number]): boolean {
    return a.uploadedAt !== undefined && Date.now() - a.uploadedAt >= ATTACHMENT_TTL_MS;
  }

  /** Re-upload a stale chip from its file, or mark it expired when there is none. */
  function refreshStale(a: (typeof st.pendingAttachments)[number]): void {
    if (a.upload !== undefined || a.expired === true) return;
    if (a.file !== undefined) {
      // The old copy goes first, so a user near their quota has room for
      // the new one. It is never sent again either way.
      void runUpload(a, a.file, discard(a.id));
      return;
    }
    a.expired = true;
    a.previewEl.classList.add("expired");
    a.previewEl.title = messagingText("attach.expired");
  }

  /** Mark a chip with no file expired once it reaches ATTACHMENT_TTL_MS. A
   *  chip that has its file waits for Send to re-upload it, so an idle
   *  composer never uploads in the background. */
  function scheduleExpiry(a: (typeof st.pendingAttachments)[number]): void {
    if (a.uploadedAt === undefined || a.file !== undefined) return;
    setOwnedTimeout(
      st.signal,
      () => {
        if (st.pendingAttachments.includes(a)) refreshStale(a);
      },
      Math.max(0, a.uploadedAt + ATTACHMENT_TTL_MS - Date.now()),
    );
  }

  /** Withdraw a settled upload's server copy. The promise resolves when that
   *  is done or has failed, never rejecting; undefined when nothing withdraws. */
  function discard(id: string): Promise<void> | undefined {
    // A chip that never landed has no server copy to withdraw.
    if (id.startsWith("pending-")) return undefined;
    return st.options.onDiscardUpload?.(id).catch(() => {});
  }

  function removePreviewItem(el: HTMLDivElement): void {
    const idx = st.pendingAttachments.findIndex((a) => a.previewEl === el);
    const att = idx !== -1 ? st.pendingAttachments[idx] : undefined;
    if (att !== undefined) {
      // Removing an in-flight attachment cancels its upload and frees
      // Send immediately, instead of leaving a doomed request running and the
      // composer blocked on it until the request settles.
      att.upload?.owner.destroy();
      const img = att.previewEl.querySelector("img");
      if (img !== null && img.src.startsWith("blob:")) {
        URL.revokeObjectURL(img.src);
      }
      att.previewEl.remove();
      st.pendingAttachments.splice(idx, 1);
      if (st.pendingAttachments.length === 0 && st.attachmentPreviewBar?.childElementCount === 0) {
        st.attachmentPreviewBar.classList.remove("visible");
      }
    }
  }

  /** Read a File as a data: URL (more reliable than createObjectURL in WebView2). */
  // oxlint-disable-next-line consistent-function-scoping -- co-located with handlePasteFile for readability
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result as string));
      // i18n-exempt: internal read failure, surfaced only as the caller's own upload toast
      reader.addEventListener("error", () => reject(new Error("Failed to read file")));
      reader.readAsDataURL(file);
    });
  }

  /** The chip's picture: the image itself when the webview can draw it from
   *  the picked bytes, else the file icon and name. A restored chip without
   *  its file has only the name. */
  function appendPreview(item: HTMLDivElement, file: File | undefined, filename: string): void {
    if (file === undefined || !isPreviewableImage(file)) {
      appendFileLabel(item, filename);
      return;
    }
    // Read file as data URL for preview (works reliably in WebView2)
    const img = createElement("img", { class: "attachment-preview-img", alt: filename });
    item.appendChild(img);
    // A type the webview cannot decode (a camera RAW, PSD, ...) would leave
    // a broken-image icon; the file chip is the honest preview for it.
    const showFileChip = (): void => {
      if (st.signal.aborted || !img.isConnected) return;
      img.replaceWith(...fileLabel(img.alt));
    };
    img.addEventListener("error", showFileChip, { once: true, signal: st.signal });
    readFileAsDataUrl(file)
      .then((dataUrl) => {
        if (st.signal.aborted) return;
        img.src = dataUrl;
      })
      .catch(showFileChip);
  }

  /** The chip's × button; removing the chip cancels its upload, if any. */
  function appendRemoveButton(item: HTMLDivElement, filename: string): void {
    const removeBtn = createElement("button", {
      class: "attachment-preview-remove",
      "data-testid": "attachment-remove",
      "aria-label": messagingText("attach.remove", { filename }),
    });
    removeBtn.appendChild(createIcon("x", 14));
    removeBtn.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        const att = st.pendingAttachments.find((a) => a.previewEl === item);
        if (att !== undefined && att.upload === undefined && att.uploadedAt !== undefined) {
          void discard(att.id);
        }
        removePreviewItem(item);
      },
      { signal: st.signal },
    );
    item.appendChild(removeBtn);
  }

  /** Flip the spoiler mark of a chip's file (6.12). The name is part of the
   *  upload, so the file goes up again under the new name, and only once that
   *  copy has landed is the old one withdrawn: a failed re-upload loses nothing.
   *  The chip is stale meanwhile, so a failed re-upload leaves it for Send to
   *  retry from its file, and the old id is never sent. A running upload is
   *  cancelled by a further toggle, which supersedes it. */
  function toggleSpoiler(
    att: (typeof st.pendingAttachments)[number],
    btn: HTMLButtonElement,
  ): void {
    const upload = st.options.onUploadFile;
    const file = att.file;
    if (upload === undefined || file === undefined) return;
    const renamed = new File([file], toggleSpoilerFilename(file.name), {
      type: file.type,
      lastModified: file.lastModified,
    });
    // The chip's id is the last copy the server holds, until a new one lands.
    const oldId = att.id.startsWith("pending-") ? undefined : att.id;
    att.upload?.owner.destroy();
    att.previewEl.querySelector("progress")?.remove();
    att.file = renamed;
    att.filename = renamed.name;
    att.uploadedAt = 0;
    relabelChip(att.previewEl, renamed.name);
    paintSpoilerButton(btn, renamed.name);
    const handle = startUpload(upload, renamed);
    handle.result.then(
      (r) => {
        // A cancelled upload that landed anyway is a copy nobody will send.
        if (handle.owner.signal.aborted) void discard(r.id);
        else if (oldId !== undefined && r.id !== oldId) void discard(oldId);
      },
      () => {},
    );
    void followUpload(att, handle);
  }

  /** The chip's spoiler toggle; only a chip with its file can rename it. */
  function appendSpoilerButton(item: HTMLDivElement, file: File | undefined): void {
    if (file === undefined) return;
    const btn = createElement("button", {
      class: "attachment-preview-spoiler",
      type: "button",
      "data-testid": "attachment-spoiler",
      "aria-label": messagingText("attach.markSpoiler"),
      title: messagingText("attach.markSpoiler"),
    });
    btn.appendChild(createIcon("eye-off", 14));
    paintSpoilerButton(btn, file.name);
    btn.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        const att = st.pendingAttachments.find((a) => a.previewEl === item);
        if (att !== undefined) toggleSpoiler(att, btn);
      },
      { signal: st.signal },
    );
    item.appendChild(btn);
  }

  /** Show why a file of this name and size cannot be attached; true when refused. */
  function refuseFile(name: string, size: number): boolean {
    if (uploadsDisabledByServer()) {
      api.showUploadError(messagingText("attach.serverDisabled"));
      return true;
    }
    // Any file type the server's file-type policy allows may be attached:
    // the server also sniffs the content, refuses its blocked types and
    // serves unsafe ones as downloads.
    const refused = refusedExtension(name);
    if (refused !== null) {
      api.showUploadError(
        refused === ""
          ? messagingText("error.fileTypeNoExtension", { filename: name })
          : messagingText("error.fileTypeBlocked", { filename: name, ext: refused }),
      );
      return true;
    }
    const maxBytes = authStore.getState().uploadPolicy?.max_upload_bytes ?? FALLBACK_MAX_FILE_SIZE;
    if (size > maxBytes) {
      api.showUploadError(
        messagingText("error.fileTooLarge", {
          filename: name,
          limit: String(Math.floor(maxBytes / (1024 * 1024))),
        }),
      );
      return true;
    }
    return false;
  }

  /** Attach files the host read from the OS (a Linux drop or paste). Each is
   *  checked by name and size before its bytes are read, only as many as the
   *  queue has room for are read, and one at a time, in drop order. */
  async function handleNativeFiles(files: readonly NativeFile[]): Promise<void> {
    if (st.options.onUploadFile === undefined || st.attachmentPreviewBar === null) return;
    if (st.disabledReason !== null) return;
    const accepted = files.filter((f) => !refuseFile(f.name, f.size));
    const room = Math.max(0, MAX_ATTACHMENTS - st.pendingAttachments.length);
    await attachInOrder(accepted.slice(0, room));
    // After the attached ones, whose arrival clears an earlier error.
    if (accepted.length > room && !st.signal.aborted) {
      api.showUploadError(
        messagingText("error.tooManyAttachments", { max: String(MAX_ATTACHMENTS) }),
      );
    }
  }

  async function attachInOrder(files: readonly NativeFile[]): Promise<void> {
    const [next, ...rest] = files;
    if (next === undefined || st.signal.aborted) return;
    try {
      const file = await next.read();
      if (st.signal.aborted) return;
      void handlePasteFile(file);
    } catch (err) {
      api.showUploadError(
        messagingText("error.uploadFailedDetail", {
          detail: errorText(err, messagingText("error.uploadFailed")),
        }),
      );
    }
    await attachInOrder(rest);
  }

  /** A Ctrl+V of files copied in the Linux file manager: the webview sees
   *  only their paths as text (or nothing), so the host reads the clipboard.
   *  The text pastes as usual meanwhile; when the clipboard did hold files,
   *  they are attached and the pasted paths taken back out, if still there. */
  function pasteNativeFiles(e: ClipboardEvent): boolean {
    if (!desktop.nativeFiles.available || st.textarea === null) return false;
    if (st.options.onUploadFile === undefined) return false;
    const data = e.clipboardData;
    if (data === null) return false;
    const text = data.getData("text/plain");
    if (!data.types.includes("text/uri-list") && !looksLikeFileList(text)) return false;
    const textarea = st.textarea;
    const at = textarea.selectionStart;
    const pasted = text.replace(/\r\n?/g, "\n");
    void desktop.nativeFiles.clipboardFiles().then((files) => {
      if (st.signal.aborted || files.length === 0) return;
      if (pasted !== "" && textarea.value.slice(at, at + pasted.length) === pasted) {
        textarea.setRangeText("", at, at + pasted.length, "start");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      void handleNativeFiles(files);
    });
    return true;
  }

  async function handlePasteFile(file: File, draftText?: string): Promise<void> {
    if (st.options.onUploadFile === undefined || st.attachmentPreviewBar === null) return;
    if (st.disabledReason !== null) return;
    if (refuseFile(file.name, file.size)) return;

    // Cap the queue at the server's hard limit. Refusing here -- before the
    // upload starts -- keeps the composer's state and the eventual send in
    // sync with what the server will actually accept.
    if (st.pendingAttachments.length >= MAX_ATTACHMENTS) {
      api.showUploadError(
        messagingText("error.tooManyAttachments", { max: String(MAX_ATTACHMENTS) }),
      );
      return;
    }

    const tempId = `pending-${++st.previewCounter}`;

    // A valid attachment is the user acting on any earlier refusal.
    api.clearUploadError();
    st.attachmentPreviewBar.classList.add("visible");

    const item = createElement("div", { class: "attachment-preview-item uploading" });

    appendPreview(item, file, file.name);

    appendRemoveButton(item, file.name);
    appendSpoilerButton(item, file);
    st.attachmentPreviewBar.appendChild(item);
    const pending: (typeof st.pendingAttachments)[number] = {
      id: tempId,
      filename: file.name,
      previewEl: item,
      file,
      ...(draftText === undefined ? {} : { draftText }),
    };
    st.pendingAttachments.push(pending);
    await runUpload(pending, file);
  }

  /** Upload `file` for `pending`'s chip; also re-uploads a stale chip. */
  async function runUpload(
    pending: (typeof st.pendingAttachments)[number],
    file: File,
    before?: Promise<void>,
  ): Promise<void> {
    const upload = st.options.onUploadFile;
    if (upload === undefined) return;
    await followUpload(pending, startUpload(upload, file, before));
  }

  /** Show `handle` on `pending`'s chip until it settles. */
  /** A draft whose file failed to upload goes back in front of anything typed since. */
  function restoreDraftText(text: string | undefined): void {
    if (text === undefined || st.textarea === null) return;
    const typed = st.textarea.value.trim();
    st.textarea.value = typed === "" ? text : `${text}\n${typed}`;
    api.autoResize();
  }

  async function followUpload(
    pending: (typeof st.pendingAttachments)[number],
    handle: DraftUpload,
  ): Promise<void> {
    const item = pending.previewEl;
    // A native progress bar on the chip: indeterminate (no value) while the
    // transport reports nothing, determinate from its first tick.
    const progressBar = createElement("progress", { "aria-label": handle.filename });
    if (handle.fraction !== null) progressBar.value = handle.fraction;
    item.insertBefore(progressBar, item.querySelector(".attachment-preview-remove"));
    item.classList.add("uploading");
    pending.upload = handle;
    handle.onProgress = (fraction) => (progressBar.value = fraction);
    /** Set when refreshing a stale chip; a failed refresh keeps the chip. */
    const staleUploadedAt = pending.uploadedAt;
    if (staleUploadedAt !== undefined) {
      handle.refreshing = { id: pending.id, uploadedAt: staleUploadedAt };
    }
    pending.uploadedAt = undefined;
    // Removed preview (cancelled), composer torn down (handed to a draft), or
    // the chip left with a queued send, which reads the result itself (3A-9).
    const abandoned = (): boolean =>
      handle.owner.signal.aborted || st.signal.aborted || !st.pendingAttachments.includes(pending);

    try {
      const result = await handle.result;
      if (abandoned()) return;
      pending.id = result.id;
      pending.filename = result.filename;
      pending.upload = undefined;
      pending.uploadedAt = handle.settledAt ?? Date.now();
      if (pending.unsent === true) {
        pending.unsent = false;
        item.classList.remove("unsent");
        item.removeAttribute("title");
      }
      item.classList.remove("uploading");
      progressBar.remove();
      if (st.uploadErrorEl?.textContent === messagingText("error.attachmentRefreshing")) {
        api.clearUploadError();
      }
    } catch (err) {
      // A user-cancelled upload (removed preview) is not a failure: the
      // preview is already gone and there is nothing to report.
      if (abandoned()) return;
      if (staleUploadedAt !== undefined) {
        // A failed refresh keeps the chip stale, so the next Send retries it
        // and still never sends the old id.
        pending.upload = undefined;
        pending.uploadedAt = staleUploadedAt;
        item.classList.remove("uploading");
        progressBar.remove();
      } else {
        removePreviewItem(item);
        restoreDraftText(pending.draftText);
      }
      const errMsg = errorText(err, messagingText("error.uploadFailed"));
      api.showUploadError(messagingText("error.uploadFailedDetail", { detail: errMsg }));
    }
  }

  function openFilePicker(): void {
    st.openPicker?.();
  }

  return {
    wireDropOverlay,
    isStale,
    refreshStale,
    scheduleExpiry,
    discard,
    removePreviewItem,
    readFileAsDataUrl,
    appendPreview,
    appendRemoveButton,
    toggleSpoiler,
    appendSpoilerButton,
    handlePasteFile,
    handleNativeFiles,
    pasteNativeFiles,
    startUpload,
    runUpload,
    restoreDraftText,
    followUpload,
    openFilePicker,
  };
}
