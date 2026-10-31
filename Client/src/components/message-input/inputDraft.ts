/**
 * Drafts in the message input: reading and restoring a draft and its unsent
 * attachments.
 */
import { createElement } from "@lib/dom";
import { ATTACHMENT_TTL_MS } from "../../features/messaging/attachmentTtl";
import { messagingText } from "../../i18n/messaging";
import { MAX_ATTACHMENTS } from "./inputShared";
import type { InputState, InputApi } from "./inputState";
import type { SentAttachment, ReplyTarget, ComposerDraft, DraftUpload } from "../MessageInput";

export function createInputDraft(st: InputState, api: InputApi) {
  /** Capture the unsent state for a channel switch. Settled attachments carry
   *  their server id; an upload still in flight is handed to the draft, and
   *  destroy() then leaves it running for the composer that restores it.
   *  The caller owns those uploads: store the draft or destroy each owner.
   */
  function peekDraft(): { content: string; replyTo: ReplyTarget | null } {
    return { content: st.textarea?.value ?? "", replyTo: st.state.replyTo };
  }

  function getDraft(): ComposerDraft {
    const uploads: DraftUpload[] = [];
    for (const a of st.pendingAttachments) {
      if (a.upload === undefined) continue;
      st.handedOff.add(a.upload);
      uploads.push(a.upload);
    }
    return {
      content: st.textarea?.value ?? "",
      replyTo: st.state.replyTo,
      ...(st.pickedMentions.length === 0 ? {} : { picks: [...st.pickedMentions] }),
      attachments: st.pendingAttachments.flatMap((a) =>
        a.uploadedAt === undefined
          ? []
          : [
              {
                id: a.id,
                filename: a.filename,
                uploadedAt: a.uploadedAt,
                ...(a.file === undefined ? {} : { file: a.file }),
                ...(a.unsent === true ? { unsent: true } : {}),
              },
            ],
      ),
      ...(uploads.length === 0 ? {} : { uploads }),
    };
  }

  /** Restore a captured draft into this (fresh) composer: text, reply bar, a
   *  ready chip (no spinner) per still-live upload, so its id sends without
   *  re-uploading, and an uploading chip per upload still in flight. A chip
   *  past its age with its file stays and re-uploads at Send. */
  function restoreDraft(draft: ComposerDraft): void {
    if (st.textarea !== null) {
      st.textarea.value = draft.content;
      api.autoResize();
    }
    st.pickedMentions = [...(draft.picks ?? [])];
    if (draft.replyTo !== null) {
      const { messageId, username, ...opts } = draft.replyTo;
      api.setReplyTo(messageId, username, opts);
    }
    const now = Date.now();
    const live = draft.attachments.filter(
      (a) => a.unsent === true || a.file !== undefined || now - a.uploadedAt < ATTACHMENT_TTL_MS,
    );
    const unsent = live.filter((a) => a.unsent === true);
    for (const att of live) {
      if (st.attachmentPreviewBar === null) break;
      if (att.unsent === true) continue;
      const item = createElement("div", { class: "attachment-preview-item" });
      api.appendPreview(item, att.file, att.filename);
      api.appendRemoveButton(item, att.filename);
      api.appendSpoilerButton(item, att.file);
      st.attachmentPreviewBar.classList.add("visible");
      st.attachmentPreviewBar.appendChild(item);
      const restored = { ...att, previewEl: item };
      st.pendingAttachments.push(restored);
      api.scheduleExpiry(restored);
    }
    for (const handle of draft.uploads ?? []) {
      if (handle.owner.signal.aborted) continue;
      if (st.attachmentPreviewBar === null) {
        handle.owner.destroy();
        continue;
      }
      const item = createElement("div", { class: "attachment-preview-item" });
      api.appendPreview(item, handle.file, handle.filename);
      api.appendRemoveButton(item, handle.filename);
      api.appendSpoilerButton(item, handle.file);
      st.attachmentPreviewBar.classList.add("visible");
      st.attachmentPreviewBar.appendChild(item);
      const pending: (typeof st.pendingAttachments)[number] = {
        id: handle.refreshing?.id ?? `pending-${++st.previewCounter}`,
        filename: handle.filename,
        previewEl: item,
        file: handle.file,
      };
      if (handle.refreshing !== null) pending.uploadedAt = handle.refreshing.uploadedAt;
      st.pendingAttachments.push(pending);
      void api.followUpload(pending, handle);
    }
    if (unsent.length > 0) restoreUnsent(unsent, "skipped");
    if (live.length < draft.attachments.length) {
      api.showUploadError(messagingText("error.draftAttachmentExpired"));
    }
  }

  /** A chip for a file the server did not attach. It is stale from the start,
   *  so Send re-uploads it from its file and never posts the old id again; with
   *  no file it is expired and only removing it frees Send. */
  function addUnsentChip(att: SentAttachment): boolean {
    if (st.pendingAttachments.some((a) => a.id === att.id)) return true;
    if (st.attachmentPreviewBar === null || st.pendingAttachments.length >= MAX_ATTACHMENTS)
      return false;
    const item = createElement("div", {
      class: "attachment-preview-item unsent",
      title: messagingText("attach.notSent"),
    });
    api.appendPreview(item, att.file, att.filename);
    api.appendRemoveButton(item, att.filename);
    api.appendSpoilerButton(item, att.file);
    st.attachmentPreviewBar.classList.add("visible");
    st.attachmentPreviewBar.appendChild(item);
    st.pendingAttachments.push({
      id: att.id,
      filename: att.filename,
      previewEl: item,
      uploadedAt: 0,
      unsent: true,
      ...(att.file === undefined ? { expired: true } : { file: att.file }),
    });
    return true;
  }

  function restoreUnsent(
    files: readonly SentAttachment[],
    reason: "skipped" | "unavailable",
    replyTo?: ComposerDraft["replyTo"],
  ): void {
    if (st.attachmentPreviewBar === null) return;
    if (replyTo != null && st.state.replyTo === null) {
      const { messageId, username, ...opts } = replyTo;
      api.setReplyTo(messageId, username, opts);
    }
    const dropped = files.filter((f) => !addUnsentChip(f)).length;
    api.showUploadError(
      dropped > 0
        ? messagingText("error.tooManyAttachments", { max: String(MAX_ATTACHMENTS) })
        : messagingText(
            reason === "unavailable" ? "error.attachmentsUnavailable" : "error.attachmentsNotSent",
          ),
    );
  }

  return { peekDraft, getDraft, restoreDraft, addUnsentChip, restoreUnsent };
}
