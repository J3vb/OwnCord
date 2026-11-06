/** A forum channel's view: its post list in place of the message list. */

import { NAVIGATION_DESTINATIONS } from "../navigation/destinations";
import { createAvatarElement, pickAvatarColor } from "../profiles/avatar";
import { settleThreadNavigation } from "../threads/threadNavigation";
import type { ChannelState, MountScope } from "../../pages/main-page/channel/channelState";

/** A post opens in the thread panel. A forum has no typing row or composer. */
export function mountForumView(st: ChannelState, ms: MountScope): void {
  const forum = NAVIGATION_DESTINATIONS.forum;
  if (forum === undefined) return;
  st.slots.messagesSlot.appendChild(
    forum.build({
      channelId: ms.channelId,
      signal: ms.signal,
      api: st.api,
      ws: st.ws,
      openPost: (threadId) =>
        st.threadHost?.openById(
          threadId,
          ms.channelId,
          ms.signal,
          () =>
            // The post's row, or the New Post button once the row is gone.
            st.slots.messagesSlot.querySelector<HTMLElement>(`[data-post-id="${threadId}"]`) ??
            st.slots.messagesSlot.querySelector<HTMLElement>('[data-testid="forum-new-post"]'),
        ),
      avatar: (subject, className) =>
        createAvatarElement(subject, {
          className,
          background: pickAvatarColor(subject.username),
          decorative: true,
          deferUntilVisible: true,
        }),
    }),
  );
  if (ms.storedChannel?.nsfw === true) ms.mountConsentBar();
  // A followed post's sidebar row asked for this forum: open the post now.
  settleThreadNavigation(ms.channelId);
}
