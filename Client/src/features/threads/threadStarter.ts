/**
 * The thread's starter message, shown above its own list: the opening message
 * of the parent channel the thread was started from.
 */

import { createElement } from "@lib/dom";
import { formatMessageTimestamp, resolveAuthor, userRoleColorVar } from "@lib/text/formatting";
import { resolveDisplayName } from "@lib/ui/avatar";
import { readableRoleColor } from "@lib/prefs/themes";
import type { ApiClient } from "@lib/api";
import { getChannelMessages, type Message } from "@stores/messages.store";
import { getThread } from "@stores/threads.store";
import { messageResponseToMessage } from "../messaging/messageModel";
import { renderMessageContent } from "../messaging/content/contentParser";
import { createAvatarElement, pickAvatarColor } from "../profiles/avatar";
import {
  createImportedAvatar,
  createImportedName,
  createImportedTag,
} from "../messaging/message-list/importedAuthor";
import { threadsText } from "../../i18n/threads";

export interface ThreadStarter {
  readonly element: HTMLDivElement;
  /** Redraw from the thread and the parent's loaded messages. */
  paint(): void;
  /** Ask the server for the starter when the parent's window does not hold it. */
  fetchIfMissing(): void;
}

export function createThreadStarter(options: {
  readonly api: ApiClient;
  readonly threadId: number;
  readonly signal: AbortSignal;
}): ThreadStarter {
  const { api, threadId, signal } = options;
  const thread = () => getThread(threadId);
  const starterEl = createElement("div", {
    class: "thread-starter",
    "data-testid": "thread-starter",
  });
  /** The starter when it is not in the parent's loaded window (opened from the thread list). */
  let fetchedStarter: Message | null = null;
  let starterFetchedFor = 0;

  function findStarter(): Message | undefined {
    const t = thread();
    if (t === undefined || t.starter_message_id === null) return undefined;
    const id = t.starter_message_id;
    return getChannelMessages(t.parent_id).find((m) => m.id === id) ?? fetchedStarter ?? undefined;
  }

  function fetchIfMissing(): void {
    const t = thread();
    if (t === undefined || t.starter_message_id === null) return;
    const id = t.starter_message_id;
    if (starterFetchedFor === id) return;
    if (getChannelMessages(t.parent_id).some((m) => m.id === id)) return;
    starterFetchedFor = id;
    api.getMessagesAround(t.parent_id, id, { limit: 1 }, signal).then(
      (resp) => {
        const found = resp.messages.find((m) => m.id === id);
        if (found === undefined || signal.aborted) return;
        fetchedStarter = messageResponseToMessage(found);
        paint();
      },
      () => {
        // The placeholder stays; the thread itself is unaffected.
      },
    );
  }

  function paint(): void {
    const t = thread();
    starterEl.replaceChildren();
    // A forum post has no starter message: its opening message is the first
    // one in the list below, so there is nothing to state here.
    starterEl.hidden = t?.post !== undefined;
    if (t === undefined || t.post !== undefined) return;
    const msg = findStarter();
    if (t.starter_message_id === null || msg?.deleted === true) {
      starterEl.appendChild(
        createElement("div", { class: "thread-starter-note" }, threadsText("starter.deleted")),
      );
      return;
    }
    if (msg === undefined) {
      starterEl.appendChild(
        createElement("div", { class: "thread-starter-note" }, threadsText("starter.unavailable")),
      );
      return;
    }
    const author = resolveAuthor(msg.user);
    const color = userRoleColorVar(msg.user.id);
    const imported = msg.importedAuthor;
    starterEl.appendChild(
      imported !== undefined
        ? createImportedAvatar(imported, "msg-avatar thread-starter-avatar")
        : createAvatarElement(author, {
            className: "msg-avatar thread-starter-avatar",
            background: pickAvatarColor(author.username),
          }),
    );
    const main = createElement("div", { class: "thread-starter-main" });
    const head = createElement("div", { class: "thread-starter-head" });
    head.appendChild(
      imported !== undefined
        ? createImportedName(imported, "msg-author msg-author--imported")
        : createElement(
            "span",
            {
              class: "msg-author",
              style: `color: ${readableRoleColor(color)}`,
              "data-role-color": color,
            },
            resolveDisplayName(author),
          ),
    );
    if (imported !== undefined) head.appendChild(createImportedTag());
    head.appendChild(
      createElement("span", { class: "msg-time" }, formatMessageTimestamp(msg.timestamp)),
    );
    const text = createElement("div", { class: "msg-text" });
    text.appendChild(
      renderMessageContent(
        msg.content,
        {
          mentions: msg.mentions,
          mentionsEveryone: msg.mentionsEveryone,
          mentionRoles: msg.mentionRoles,
        },
        msg.id === 0 ? undefined : `${msg.id}\u0000${msg.editedAt ?? ""}`,
      ),
    );
    main.append(head, text);
    starterEl.appendChild(main);
  }

  return { element: starterEl, paint, fetchIfMissing };
}
