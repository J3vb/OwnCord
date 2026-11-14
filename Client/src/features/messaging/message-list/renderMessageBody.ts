/**
 * The pieces of an ordinary message row: avatar, header, body, attachments and send state.
 */
import { createElement, setText, appendChildren } from "@lib/dom";
import { endForwardBlock, startForwardBlock } from "./forwardBlock";
import { renderPollCard } from "./pollCard";
import { renderStickerBody } from "./sticker";
import { renderThreadChip } from "./threadChip";
import { threadOfMessage } from "@stores/threads.store";
import { messagesStore, type Message } from "@stores/messages.store";
import { messageStatusText } from "../../../i18n/messageStatus";
import { messagingText } from "../../../i18n/messaging";
import { stickersText } from "../../../i18n/stickers";
import { isSpoilerFilename } from "../spoilerAttachment";
import { connectText } from "../../../i18n/connect";
import { isVoiceAttachment } from "../../voice-messages/player";
import { formatClockTime } from "@lib/text/formatting";
import { resolveAuthor } from "@lib/text/formatting";
import { createAvatarElement, pickAvatarColor } from "../../profiles/avatar";
import { createImportedAvatar, createImportedName, createImportedTag } from "./importedAuthor";
import { resolveDisplayName } from "@lib/ui/avatar";
import { renderMessageContent } from "../content/contentParser";
import { readableRoleColor } from "@lib/prefs/themes";
import { isLoneImageEmbed, renderUrlEmbeds } from "../content/media";
import { serverCardsFor } from "../content/serverPreviews";
import {
  isGalleryImage,
  renderAttachment,
  resolveServerUrl,
  type LightboxGallery,
} from "../content/attachments";
import { renderReactions } from "./reactions";
import { WsErrorCode } from "@lib/protocolTypes";
import { fullDateTimeTitle, messageHeaderTime } from "./messageTimes";
import type { MessageRenderOptions } from "./messageRenderOptions";

/** Map a send-failure error code to a short, user-facing reason. */
function sendErrorReason(code: string | null): string {
  switch (code) {
    case WsErrorCode.SLOW_MODE:
      return messagingText("send.slowMode");
    case WsErrorCode.RATE_LIMITED:
      return messagingText("send.rateLimited");
    case WsErrorCode.FORBIDDEN:
      return messagingText("send.forbidden");
    case WsErrorCode.REQUEST_TIMEOUT:
      return messageStatusText("send.requestTimeout");
    case "OFFLINE":
      return messagingText("send.disconnected");
    case "OFFLINE_NO_RECOVERY":
      return messagingText("send.offlineNoRecovery");
    case "NETWORK":
      return messagingText("send.network");
    case "UNCONFIRMED":
      return messagingText("send.unconfirmed");
    case "RECOVERED":
      return messagingText("send.recovered");
    case WsErrorCode.BAD_REQUEST:
      return messagingText("send.rejected");
    case WsErrorCode.STICKER_NOT_FOUND:
      return stickersText("send.notFound");
    case "UPLOAD_FAILED":
      return messagingText("send.uploadFailed");
    case "UPLOAD_CANCELLED":
      return messagingText("send.uploadCancelled");
    case "BEFORE_RESTORE":
      return connectText("app.sendBeforeRestore");
    default:
      return messagingText("send.failed");
  }
}

/** A message that is nothing but voice messages: no empty text line above the player. */
function isVoiceOnly(msg: Message): boolean {
  return (
    msg.content === "" && msg.attachments.length > 0 && msg.attachments.every(isVoiceAttachment)
  );
}

/** Append a message's attachments. Its inline images form one lightbox
 *  sequence, in attachment order (3A-10c); an unconfirmed row (id 0) has none,
 *  and a lone image opens as it always did. */
function appendAttachments(el: HTMLElement, msg: Message): void {
  // A pending row already lays its images out as the grid, so confirming it
  // does not resize the row; only the lightbox sequence waits for the id.
  const tiles = msg.attachments.filter(isGalleryImage);
  // A spoiler image stays out of the sequence, or the arrows would open it
  // while it is covered; once revealed it opens on its own.
  const images = msg.id === 0 ? [] : tiles.filter((att) => !isSpoilerFilename(att.filename));
  const items = images.map((att) => ({
    url: resolveServerUrl(att.url),
    filename: att.filename,
    mime: att.mime,
  }));
  const isDeleted = (): boolean =>
    messagesStore
      .getState()
      .messagesByChannel.get(msg.channelId)
      ?.find((m) => m.id === msg.id)?.deleted === true;
  // Two or more images share one mosaic wrapper, placed where the first image was.
  const grid =
    tiles.length >= 2
      ? createElement("div", { class: "msg-image-grid", "data-count": String(tiles.length) })
      : null;
  for (const att of msg.attachments) {
    const index = images.indexOf(att);
    const gallery: LightboxGallery | undefined =
      index === -1 || items.length < 2
        ? undefined
        : {
            items,
            index,
            isGone: isDeleted,
            watch: (onGone) =>
              messagesStore.subscribeSelector(isDeleted, (gone) => {
                if (gone) onGone();
              }),
            // The row is re-rendered as a tombstone: find the new element.
            row: () => document.querySelector(`[data-testid="message-${msg.id}"]`),
          };
    const node = renderAttachment(att, gallery);
    if (grid !== null && tiles.includes(att)) {
      if (grid.parentNode === null) el.appendChild(grid);
      grid.appendChild(node);
    } else {
      el.appendChild(node);
    }
  }
}

/** The mention fields that decide whether a row highlights the viewer. */
export function mentionInfoOf(msg: Message): {
  mentions: Message["mentions"];
  mentionsEveryone: Message["mentionsEveryone"];
  mentionRoles: Message["mentionRoles"];
} {
  return {
    mentions: msg.mentions,
    mentionsEveryone: msg.mentionsEveryone,
    mentionRoles: msg.mentionRoles,
  };
}

export function sendStatusClass(msg: Message): string {
  if (msg.status === "pending" || msg.status === "uploading") return " pending";
  return msg.status === "failed" ? " failed" : "";
}

/** The avatar a row is drawn with: the account's picture, or an imported
 *  author's letter. */
export function renderRowAvatar(
  msg: Message,
  author: ReturnType<typeof resolveAuthor>,
): HTMLDivElement {
  const imported = msg.importedAuthor;
  // An imported author has no account to open, so its avatar carries no user id.
  if (imported !== undefined) return createImportedAvatar(imported, "msg-avatar");
  return createAvatarElement(author, {
    className: "msg-avatar",
    background: pickAvatarColor(author.username),
    attrs: { "data-user-id": String(msg.user.id) },
  });
}

export function renderHoverTime(msg: Message): HTMLDivElement {
  return createElement(
    "div",
    {
      class: "msg-hover-time",
      title: fullDateTimeTitle(msg.timestamp),
    },
    // The header's clock time without its "Today at" (F24): the full form
    // wrapped onto three lines over the avatar column. The title has the date.
    formatClockTime(msg.timestamp),
  );
}

function renderAuthorName(
  msg: Message,
  author: ReturnType<typeof resolveAuthor>,
  roleColor: string,
): HTMLElement {
  const imported = msg.importedAuthor;
  if (imported !== undefined) {
    return createImportedName(imported, "msg-author msg-author--imported");
  }
  return createElement(
    "span",
    {
      class: "msg-author",
      // The list's one delegated handler opens the author's profile from this
      // (and from the avatar), so the name is a real control for the keyboard.
      role: "button",
      tabindex: "0",
      "data-user-id": String(msg.user.id),
      // The username stays as the title so the handle you would @mention is
      // one hover away even when a display name is standing in for it.
      title: author.username,
      style: `color: ${readableRoleColor(roleColor)}`,
      "data-role-color": roleColor,
    },
    resolveDisplayName(author),
  );
}

export function renderMessageHeader(
  msg: Message,
  author: ReturnType<typeof resolveAuthor>,
  roleColor: string,
): HTMLDivElement {
  const header = createElement("div", { class: "msg-header" });
  const authorEl = renderAuthorName(msg, author, roleColor);
  const time = createElement(
    "span",
    { class: "msg-time", title: fullDateTimeTitle(msg.timestamp) },
    messageHeaderTime(msg.timestamp),
  );
  // Compact mode shows this short clock time ahead of the name; CSS hides it
  // otherwise. The clock time never changes, so relabelRenderedTimes skips it.
  const compactTime = createElement(
    "span",
    { class: "msg-compact-time", title: fullDateTimeTitle(msg.timestamp) },
    formatClockTime(msg.timestamp),
  );
  appendChildren(header, compactTime, authorEl);
  if (msg.importedAuthor !== undefined) header.appendChild(createImportedTag());
  header.appendChild(time);
  return header;
}

function appendReactionsIfAny(
  el: HTMLElement,
  msg: Message,
  opts: MessageRenderOptions,
  signal: AbortSignal,
): void {
  if (msg.reactions.length > 0) {
    el.appendChild(renderReactions(msg, opts, signal));
  }
}

/** Put the parsed text into `box`, wrapped where it needs a hook or is hidden. */
function appendTextBody(box: HTMLElement, msg: Message, body: Node): void {
  if (msg.status === "uploading" && msg.correlationId !== null) {
    // A queued row's Cancel describes itself by this text (3A-9).
    const wrap = createElement("div", { id: `msg-body-${msg.correlationId}` });
    wrap.style.display = "contents";
    wrap.appendChild(body);
    box.appendChild(wrap);
  } else if (isLoneImageEmbed(msg.content)) {
    // The image stands in for its link; the text comes back if the embed goes.
    const wrap = createElement("div", { "data-lone-image-text": "" });
    wrap.hidden = true;
    wrap.appendChild(body);
    box.appendChild(wrap);
  } else if (!isVoiceOnly(msg)) box.appendChild(body);
}

/** An ordinary message's text, files and embeds, thread chip and reactions. */
function appendStandardBody(
  el: HTMLElement,
  msg: Message,
  opts: MessageRenderOptions,
  signal: AbortSignal,
): void {
  // Key the parse cache by the message's identity plus its edit stamp: an
  // unchanged message reuses its parse when a row is re-materialised, and an
  // edit changes the key so the new content is parsed. Id 0 is the
  // unconfirmed-optimistic sentinel shared by every pending row, so it is not
  // a unique identity — those parse uncached.
  const cacheKey = msg.id === 0 ? undefined : `${msg.id}\u0000${msg.editedAt ?? ""}`;
  const body = renderMessageContent(msg.content, mentionInfoOf(msg), cacheKey);
  // A forward's text, files and embeds sit inside its "Forwarded" frame.
  const box = msg.forward === undefined ? el : startForwardBlock();
  appendTextBody(box, msg, body);
  if (msg.editedAt !== null) {
    box.appendChild(
      createElement(
        "span",
        { class: "msg-edited", title: fullDateTimeTitle(msg.editedAt) },
        messagingText("message.edited"),
      ),
    );
  }

  appendAttachments(box, msg);

  // URL embeds (YouTube players, link previews)
  const embeds = renderUrlEmbeds(msg.content, serverCardsFor(msg));
  if (embeds.childNodes.length > 0) {
    box.appendChild(embeds);
  }
  if (msg.forward !== undefined) {
    endForwardBlock(box, msg.forward);
    el.appendChild(box);
  }

  // The thread this message started, below its body.
  const thread = threadOfMessage(msg);
  if (thread !== undefined) el.appendChild(renderThreadChip(thread, opts.onOpenThread, signal));

  appendReactionsIfAny(el, msg, opts, signal);
}

/** The row's body, in place of which an editor, a poll or a sticker may stand. */
export function appendBody(
  el: HTMLElement,
  msg: Message,
  opts: MessageRenderOptions,
  signal: AbortSignal,
  editor: HTMLElement | undefined,
): void {
  if (editor !== undefined) {
    // The editor takes the body's place; attachments and reactions stay.
    el.appendChild(editor);
    appendAttachments(el, msg);
    appendReactionsIfAny(el, msg, opts, signal);
  } else if (msg.deleted) {
    const text = createElement("div", { class: "msg-text" });
    text.style.fontStyle = "italic";
    text.style.color = "var(--text-muted)";
    setText(text, messagingText("message.deleted"));
    el.appendChild(text);
  } else if (msg.poll !== undefined) {
    // A poll's card takes the body's place (the server's fallback text is for
    // clients that predate polls); it has no files or embeds, and reactions stay.
    el.appendChild(renderPollCard(msg, opts, signal));
    appendReactionsIfAny(el, msg, opts, signal);
  } else if (msg.sticker !== undefined) {
    // A sticker stands alone: the server's "[Sticker: name]" fallback
    // is for clients that predate stickers. It has no files or embeds, and
    // reactions stay.
    el.appendChild(renderStickerBody(msg.sticker, signal));
    appendReactionsIfAny(el, msg, opts, signal);
  } else {
    appendStandardBody(el, msg, opts, signal);
  }
}

/** Failed optimistic send: the reason, with retry and discard. */
function renderSendFailedBar(
  msg: Message,
  cid: string,
  opts: MessageRenderOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const bar = createElement("div", { class: "msg-send-failed" });
  bar.appendChild(
    createElement("span", { class: "msg-send-failed-text" }, sendErrorReason(msg.errorCode)),
  );
  const retryBtn = createElement(
    "button",
    { class: "msg-send-retry", "data-testid": `msg-retry-${cid}` },
    messagingText("action.retry"),
  );
  retryBtn.addEventListener("click", () => opts.onRetry?.(cid), { signal });
  const discardBtn = createElement(
    "button",
    { class: "msg-send-discard", "data-testid": `msg-discard-${cid}` },
    messagingText("action.delete"),
  );
  discardBtn.addEventListener("click", () => opts.onDeleteDraft?.(cid), { signal });
  appendChildren(bar, retryBtn, discardBtn);
  return bar;
}

/** What a send that is queued or failed adds below the body. */
export function appendSendState(
  el: HTMLElement,
  msg: Message,
  opts: MessageRenderOptions,
  signal: AbortSignal,
): void {
  const cid = msg.correlationId;
  if (cid === null) return;
  // A send queued behind its files shows them, with progress and Cancel while
  // they upload and plain once it failed (3A-9).
  if (msg.status === "uploading" || msg.status === "failed") {
    const strip = opts.renderUploadStrip?.(cid, signal);
    if (strip != null) el.appendChild(strip);
  }
  if (msg.status === "failed") el.appendChild(renderSendFailedBar(msg, cid, opts, signal));
}

/**
 * A stable key for the identity a row's author is drawn from — the avatar URL,
 * the displayed name, the username (the hover handle) and the role colour.
 * MessageList compares it against the last render to repaint only the rows
 * whose author actually changed, so a role change or a rename does not
 * rebuild every other row.
 */
export function authorAvatarKey(
  author: {
    readonly username: string;
    readonly displayName: string | null;
    readonly avatar: string | null;
  },
  roleColor: string,
): string {
  return `${author.avatar ?? ""}\u0000${resolveDisplayName(author)}\u0000${author.username}\u0000${roleColor}`;
}
