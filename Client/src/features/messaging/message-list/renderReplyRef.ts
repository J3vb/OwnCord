/**
 * The reply quote above a message: the jump-to-parent bar and the quoted parent.
 */
import { authorAvatarKey } from "./renderMessageBody";
import { createElement, setText, appendChildren } from "@lib/dom";
import { stickerReplyPreview, stickerReplyText } from "./sticker";
import { type Message } from "@stores/messages.store";
import { messagingText } from "../../../i18n/messaging";
import type { ImportedAuthor } from "../../../lib/types";
import { resolveAuthor, userRoleColorVar } from "@lib/text/formatting";
import { createAvatarElement, pickAvatarColor } from "../../profiles/avatar";
import { importedAuthorKey } from "../importedAuthor";
import { createImportedAvatar, createImportedName, createImportedTag } from "./importedAuthor";
import { resolveDisplayName } from "@lib/ui/avatar";
import { markdownToPlainText } from "@lib/text/markdown";
import type { MessageRenderOptions } from "./messageRenderOptions";

/** The jump-to-parent bar, activatable by click, Enter or Space. */
function createReplyBar(
  replyToId: number,
  opts: MessageRenderOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const bar = createElement("div", {
    class: "msg-reply-ref",
    role: "button",
    tabindex: "0",
    "data-reply-to": String(replyToId),
    title: messagingText("reply.jumpTitle"),
  });
  const jump = (): void => opts.onJumpToMessage?.(replyToId);
  bar.addEventListener("click", jump, { signal });
  bar.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        jump();
      }
    },
    { signal },
  );
  return bar;
}

/** The quoted author and text, for an imported author or an account. */
function fillReplyQuote(
  bar: HTMLElement,
  imported: ImportedAuthor | undefined,
  user: Message["user"],
  preview: string,
): void {
  const text = createElement("span", { class: "rr-text" }, preview);
  if (imported !== undefined) {
    bar.dataset["authorKey"] = importedAuthorKey(imported);
    appendChildren(
      bar,
      createImportedAvatar(imported, "rr-avatar"),
      createImportedName(imported, "rr-author"),
      createImportedTag(),
      text,
    );
    return;
  }
  const author = resolveAuthor(user);
  const roleColor = userRoleColorVar(user.id);
  // Tag the quoted author so a rename/role change repaints it in place,
  // without rebuilding the row.
  bar.dataset["authorKey"] = authorAvatarKey(author, roleColor);
  const miniAvatar = createAvatarElement(author, {
    className: "rr-avatar",
    background: pickAvatarColor(author.username),
  });
  appendChildren(
    bar,
    miniAvatar,
    createElement("span", { class: "rr-author" }, resolveDisplayName(author)),
    text,
  );
}

/** The quote of a parent that is in the loaded window. */
function fillLoadedReply(bar: HTMLElement, ref: Message): void {
  // A sticker message has no text of its own: say what it is.
  const plain =
    stickerReplyText(ref.sticker, ref.content) ??
    Array.from(markdownToPlainText(ref.content, messagingText("spoiler.revealed")))
      .slice(0, 100)
      .join("");
  // A message that is only an attachment (or only a spoiler) has no plain
  // text; show a placeholder rather than an empty preview (F24).
  fillReplyQuote(
    bar,
    ref.importedAuthor,
    ref.user,
    plain === "" ? messagingText("reply.attachment") : plain,
  );
}

/** The quote of a parent outside the loaded window, from the server's snippet. */
function fillSnippetReply(
  bar: HTMLElement,
  referenced: NonNullable<Message["referencedMessage"]>,
  user: Message["user"],
): void {
  const snippet =
    stickerReplyPreview(referenced.content) ??
    markdownToPlainText(referenced.content, messagingText("spoiler.revealed"));
  fillReplyQuote(
    bar,
    referenced.imported_author,
    user,
    snippet === "" ? messagingText("reply.attachment") : snippet,
  );
}

/**
 * The quoted bar above a reply. Clicking it jumps to the replied-to message —
 * including when that message is outside the loaded window, which is why the
 * bar stays clickable even in the "unknown message" case: the id is known, and
 * the jump path can fetch the window around it. A deleted target has nothing
 * to jump to, so its bar is plain text: "Original message was deleted".
 */
export function renderReplyRef(
  replyToId: number,
  referenced: Message["referencedMessage"],
  allMessages: readonly Message[],
  opts: MessageRenderOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const ref = allMessages.find((m) => m.id === replyToId);
  const deleted = ref ? ref.deleted : referenced?.deleted === true;
  // A deleted parent has nothing to show or jump to: plain text, no avatar or
  // author (the list no longer draws the parent at all).
  if (deleted) {
    return createElement(
      "div",
      { class: "msg-reply-ref msg-reply-ref--deleted", "data-reply-to": String(replyToId) },
      messagingText("reply.originalDeleted"),
    );
  }
  const bar = createReplyBar(replyToId, opts, signal);
  const parentAuthorId = ref?.user.id ?? referenced?.user?.id;
  if (parentAuthorId !== undefined && opts.blockedUsers?.has(parentAuthorId) === true) {
    bar.classList.add("msg-reply-ref--blocked");
    setText(bar, messagingText("blocked.message"));
  } else if (ref) {
    fillLoadedReply(bar, ref);
  } else if (referenced?.user) {
    fillSnippetReply(bar, referenced, referenced.user);
  } else {
    setText(bar, messagingText("reply.unknown"));
  }
  return bar;
}
