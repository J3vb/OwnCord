// Module-level slots that deep code reaches the live session through: the
// mark-read and mark-unread senders, the native screen picker, the
// who-reacted fetcher, the notes context and the shared presence sender. Each
// is installed when the page is created and cleared when it is destroyed, so a
// torn-down connection never leaves one pointed at a dead socket. A feature
// that needs a new slot adds a hook here, not to MainPage.
import { setMarkReadSender } from "@lib/readState";
import { setMarkUnreadSender } from "../../features/messaging/message-list/markUnread";
import { setActivePresenceSender } from "@lib/presence/presence";
import { setScreenSourcePicker } from "../../features/voice/native/screenPickerSlot";
import {
  clearReactionUsersCache,
  setReactionUsersFetcher,
} from "../../features/messaging/reactionUsers";
import { createNotesContext, setNotesContextSource } from "../../features/profiles/userNotes";
import type { PageState } from "./pageState";

export interface SessionHook {
  readonly name: string;
  install(st: PageState): void;
  uninstall(st: PageState): void;
}

export const sessionHooks: readonly SessionHook[] = [
  {
    // "Mark as Read" affordances need the socket but are reached from deep
    // inside the sidebar. Clearing it also cancels any still-armed "Mark All
    // as Read" burst: channel ids are per server, so a burst that outlived
    // this connection could mark an unrelated channel read on the next one.
    name: "markReadSender",
    install: ({ ws }) =>
      setMarkReadSender((channelId, messageId) => {
        const payload = { channel_id: channelId };
        ws.send({
          type: "mark_read",
          payload: messageId === undefined ? payload : { ...payload, message_id: messageId },
        });
      }),
    uninstall: () => setMarkReadSender(null),
  },
  {
    name: "markUnreadSender",
    install: ({ ws }) =>
      setMarkUnreadSender((channelId, messageId) =>
        ws.send({ type: "mark_unread", payload: { channel_id: channelId, message_id: messageId } }),
      ),
    uninstall: () => setMarkUnreadSender(null),
  },
  {
    // The native screen-share picker adapter is a lower layer and may not
    // import a component; the UI registers the dialog here. It is its own lazy
    // chunk, and the dynamic import is the sanctioned lower-layer-to-UI seam.
    // With none registered, a share resolves to cancelled.
    name: "screenSourcePicker",
    install: () =>
      setScreenSourcePicker((request) =>
        import("../../features/voice/ScreenSharePicker").then((m) =>
          m.showScreenSharePicker(request),
        ),
      ),
    uninstall: () => setScreenSourcePicker(null),
  },
  {
    // The who-reacted tooltip fetches on hover, from this session's REST client.
    name: "reactionUsers",
    install: ({ api }) => {
      clearReactionUsersCache();
      setReactionUsersFetcher(async (channelId, messageId, emoji) => {
        const res = await api.getReactionUsers(channelId, messageId, emoji);
        return res.users;
      });
    },
    uninstall: () => setReactionUsersFetcher(null),
  },
  {
    // Cards opened from anywhere (member list, message author) take the notes
    // context of this session when they open, never later.
    name: "notesContext",
    install: ({ api, apiConfig }) =>
      setNotesContextSource(() => createNotesContext(api, apiConfig.host ?? "")),
    uninstall: () => setNotesContextSource(null),
  },
  {
    // The session's one presence sender, shared with producers outside the
    // page (main.ts's tray status) so they spend the same server budget.
    name: "presenceSender",
    install: ({ presenceSender }) => setActivePresenceSender(presenceSender),
    uninstall: ({ presenceSender }) => {
      presenceSender.destroy();
      setActivePresenceSender(null);
    },
  },
];
