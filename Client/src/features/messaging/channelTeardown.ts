/** Steps of tearing down a mounted channel view. */

import type { ComposerDraft } from "./MessageInput";
import type { ChannelState, ChannelApi } from "../../pages/main-page/channel/channelState";

/** Empty drafts are not stored, so leaving a channel with nothing typed
 *  leaves no entry behind. */
export function hasDraftContent(draft: ComposerDraft): boolean {
  return (
    draft.content !== "" ||
    draft.replyTo !== null ||
    draft.attachments.length > 0 ||
    (draft.uploads?.length ?? 0) > 0
  );
}

/** Destroy the consent UI, the message list and the typing indicator. */
export function dropMountedComponents(st: ChannelState): void {
  st.nsfwConsentUiGen++;
  if (st.nsfwConsentUi !== null) {
    st.nsfwConsentUi.destroy?.();
    st.nsfwConsentUi = null;
  }
  if (st.messageList !== null) {
    st.messageList.destroy?.();
    st.messageList = null;
  }
  if (st.typingIndicator !== null) {
    st.typingIndicator.destroy?.();
    st.typingIndicator = null;
  }
}

/** Save the composer's draft, stash the unsent state, then destroy it. */
export function stashAndDestroyComposer(st: ChannelState, cc: ChannelApi): void {
  if (st.messageInput === null) return;
  cc.saveMountedDraft();
  if (st.currentChannelId !== null) {
    const draft = st.messageInput.getDraft();
    if (hasDraftContent(draft)) st.draftByChannel.set(st.currentChannelId, draft);
    else st.draftByChannel.delete(st.currentChannelId);
  }
  st.messageInput.destroy?.();
  st.messageInput = null;
}
