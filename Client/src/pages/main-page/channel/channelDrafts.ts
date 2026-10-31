/**
 * Composer drafts per channel: saving the mounted draft, restoring a saved one,
 * and putting unsent files back.
 */
import type { MessageInputComponent, SentAttachment } from "@components/MessageInput";
import { getChannelMessages } from "@stores/messages.store";
import { loadSavedDraft, saveDraft, type SavedDraft } from "@lib/prefs/savedDrafts";
import { DRAFT_SAVE_DELAY_MS } from "./channelShared";
import type { ChannelState, ChannelApi } from "./channelState";

export function createChannelDrafts(st: ChannelState, cc: ChannelApi) {
  function persistDraft(channelId: number, draft: SavedDraft): void {
    const owner = st.draftOwner;
    if (owner === null || !(owner.userId > 0) || owner.host === "" || !owner.current()) return;
    const stamp = JSON.stringify([owner.host, owner.userId, channelId, draft]);
    if (stamp === st.lastSavedDraft) return;
    st.lastSavedDraft = stamp;
    saveDraft(owner.host, owner.userId, channelId, draft);
  }

  function saveMountedDraft(): void {
    if (st.draftSaveTimer !== null) {
      clearTimeout(st.draftSaveTimer);
      st.draftSaveTimer = null;
    }
    if (st.messageInput !== null && st.currentChannelId !== null) {
      persistDraft(st.currentChannelId, st.messageInput.peekDraft());
    }
  }

  function scheduleDraftSave(): void {
    if (st.draftSaveTimer !== null) clearTimeout(st.draftSaveTimer);
    const draft = st.messageInput?.peekDraft();
    if (draft !== undefined && draft.content === "" && draft.replyTo === null) {
      saveMountedDraft();
      return;
    }
    st.draftSaveTimer = setTimeout(saveMountedDraft, DRAFT_SAVE_DELAY_MS);
  }

  /** After a restart there is no in-memory draft, so take the saved one. Its
   *  reply is dropped only when the loaded history shows the target deleted:
   *  history is usually not loaded yet, and the server refuses a reply to a
   *  message that is gone. */
  function restoreSavedDraft(channelId: number, input: MessageInputComponent): void {
    const userId = st.getCurrentUserId();
    const host = st.api.getConfig?.().host ?? "";
    if (!(userId > 0) || host === "") return;
    const saved = loadSavedDraft(host, userId, channelId);
    if (saved === null) return;
    const target = saved.replyTo;
    const gone =
      target !== null &&
      getChannelMessages(channelId).some((m) => m.id === target.messageId && m.deleted);
    input.restoreDraft({
      content: saved.content,
      replyTo: gone ? null : target,
      attachments: [],
    });
  }

  /** 2A-3: give files a send did not carry back to the composer of the
   *  channel it went to, mounted or stashed, with the send's reply target
   *  when given and that composer has none of its own. */
  function putBackUnsent(
    sentTo: number,
    files: readonly SentAttachment[],
    reason: "skipped" | "unavailable",
    replyTo: number | null = null,
    ping?: boolean,
  ): void {
    const target =
      replyTo === null
        ? undefined
        : getChannelMessages(sentTo).find((m) => m.id === replyTo && !m.deleted);
    const reply = target === undefined ? null : { ...cc.replyTargetOf(target), ping };
    if (sentTo === st.currentChannelId && st.messageInput !== null) {
      st.messageInput.restoreUnsent(files, reason, reply);
      scheduleDraftSave();
      return;
    }
    const stashed = st.draftByChannel.get(sentTo);
    st.draftByChannel.set(sentTo, {
      content: stashed?.content ?? "",
      replyTo: stashed?.replyTo ?? reply,
      attachments: [
        ...(stashed?.attachments ?? []),
        ...files.map((f) => ({ ...f, uploadedAt: 0, unsent: true })),
      ],
      ...(stashed?.uploads === undefined ? {} : { uploads: stashed.uploads }),
    });
  }

  return { persistDraft, saveMountedDraft, scheduleDraftSave, restoreSavedDraft, putBackUnsent };
}
