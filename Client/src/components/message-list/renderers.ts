/**
 * Message rendering barrel — re-exports the rendering helpers consumers use
 * and contains the composite functions (renderMessage, renderDayDivider,
 * renderReplyRef, renderSystemMessage) that orchestrate pieces from the
 * split modules.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { isPinRowKind, isServerRowKind, isWelcomeRowKind } from "@lib/text/messageKind";
import { groupRowIcon, groupRowText } from "./groupRows";
import { renderPinRowText } from "./pinRows";
import { canWaveIn, renderWaveButton, welcomeGreeting } from "./welcomeRows";
import { endForwardBlock, startForwardBlock } from "./forwardBlock";
import { renderPollCard } from "./pollCard";
import { renderStickerBody, stickerReplyPreview, stickerReplyText } from "./sticker";
import { renderThreadChip } from "./threadChip";
import { threadOfMessage } from "@stores/threads.store";
import { connectionLockReason, messageActionGates } from "./messageActions";
import { QUICK_REACTIONS, emojiNode, quickReactionEmojiForPass } from "./quickReactions";
import { messagesStore, type Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { messageStatusText } from "../../i18n/messageStatus";
import { messagingText } from "../../i18n/messaging";
import { stickersText } from "../../i18n/stickers";
import { isSpoilerFilename } from "../../features/messaging/spoilerAttachment";
import { connectText } from "../../i18n/connect";
import { uiStore } from "@stores/ui.store";
import { voiceStore } from "@stores/voice.store";
import { dmCallText } from "../../i18n/dmCall";
import type { CallInfo } from "../../lib/types";

// -- Re-exports (only the names consumers actually import; everything else is
// -- available directly from the split modules) -------------------------------

export {
  formatTime,
  formatFullDate,
  formatMessageTimestamp,
  isSameDay,
  shouldGroup,
  getUserRole,
  roleColorVar,
} from "@lib/text/formatting";

export {
  renderInlineContent,
  renderMentions,
  renderMentionSegment,
  renderMessageContent,
} from "./contentParser";

export { setServerHost } from "./attachments";
import { isVoiceAttachment } from "../../features/voice-messages/player";

// -- Imports for composite functions ------------------------------------------

import {
  formatClockTime,
  formatFullDate,
  formatMessageTimestamp,
  parseTimestamp,
} from "@lib/text/formatting";
import { formatFullDateTime } from "../../features/messaging/discordTimestamp";
import { resolveAuthor, userRoleColorVar } from "@lib/text/formatting";
import { createAvatarElement, pickAvatarColor } from "./avatar";
import { importedAuthorKey } from "../../features/messaging/importedAuthor";
import { createImportedAvatar, createImportedName, createImportedTag } from "./importedAuthor";
import { resolveDisplayName } from "@lib/ui/avatar";
import { renderMentions, renderMessageContent } from "./contentParser";
import { markdownToPlainText } from "@lib/text/markdown";
import { highlightsCurrentUser } from "@lib/text/mentions";
import { readableRoleColor } from "@lib/prefs/themes";
import { isLoneImageEmbed, renderUrlEmbeds } from "./media";
import {
  isGalleryImage,
  renderAttachment,
  resolveServerUrl,
  type LightboxGallery,
} from "./attachments";
import { atReactionLimit, renderReactions, wireReactionControl } from "./reactions";
import { WsErrorCode } from "@lib/protocolTypes";

/** What a row render reads beyond the list's own options. */
export interface MessageRenderOptions extends MessageListOptions {
  /** Authors whose messages are hidden, so a reply quoting one shows no content. */
  readonly blockedUsers?: ReadonlySet<number>;
  /** The list's own lifetime: owners that must outlive a row rebuild (the End poll confirm) use it. */
  readonly listSignal?: AbortSignal;
}

// -- Composite rendering functions --------------------------------------------

/** Weekday, date and time for a tooltip, in Discord's "F" style. */
export function fullDateTimeTitle(iso: string): string {
  return formatFullDateTime(parseTimestamp(iso));
}

/** The header over a run of blocked users' messages, with its Show/Hide toggle. */
export function renderBlockedRun(
  item: { readonly firstId: number; readonly count: number; readonly expanded: boolean },
  onToggle: () => void,
  signal: AbortSignal,
): HTMLDivElement {
  const toggle = createElement(
    "button",
    {
      type: "button",
      class: "msg-blocked-toggle",
      "aria-expanded": String(item.expanded),
      "data-testid": `msg-blocked-toggle-${item.firstId}`,
    },
    messagingText(item.expanded ? "blocked.hide" : "blocked.show"),
  );
  toggle.addEventListener("click", onToggle, { signal });
  const run = createElement("div", {
    class: "msg-blocked-run",
    "data-testid": `msg-blocked-run-${item.firstId}`,
  });
  appendChildren(
    run,
    createElement("span", { class: "msg-blocked-text" }, messagingText("blocked.run", item)),
    toggle,
  );
  return run;
}

export function renderDayDivider(iso: string): HTMLDivElement {
  const divider = createElement("div", { class: "msg-day-divider" });
  appendChildren(
    divider,
    createElement("span", { class: "line" }),
    createElement("span", { class: "date" }, formatFullDate(iso)),
    createElement("span", { class: "line" }),
  );
  return divider;
}

/**
 * The unread bar pinned to the top of the message region. The
 * caller owns the label text and the `hidden` state; the button only reports
 * the click.
 */
export function renderUnreadBar(
  onMarkRead: () => void,
  signal: AbortSignal,
): {
  readonly bar: HTMLDivElement;
  readonly label: HTMLSpanElement;
  readonly announcer: HTMLDivElement;
} {
  const bar = createElement("div", { class: "unread-bar", "data-testid": "unread-bar" });
  bar.hidden = true;
  const label = createElement("span", { "data-testid": "unread-bar-label" });
  const markRead = createElement(
    "button",
    { type: "button", "data-testid": "unread-bar-mark-read" },
    messagingText("unreadBar.markRead"),
  );
  markRead.addEventListener("click", onMarkRead, { signal });
  appendChildren(bar, label, markRead);
  // A persistent live region outside the hidden bar: changes inside a hidden
  // region are not announced.
  const announcer = createElement("div", {
    class: "sr-only",
    role: "status",
    "data-testid": "unread-bar-announcer",
  });
  return { bar, label, announcer };
}

/**
 * The "NEW" line above the first message the reader has not seen. Built exactly
 * like the day divider — same rule/label/rule shape — so the two read as one
 * family; only the accent colour distinguishes them.
 */
export function renderNewDivider(): HTMLDivElement {
  const divider = createElement("div", {
    class: "msg-new-divider",
    role: "separator",
    "data-testid": "new-messages-divider",
  });
  appendChildren(
    divider,
    createElement("span", { class: "line" }),
    createElement("span", { class: "label" }, messagingText("divider.new")),
    createElement("span", { class: "line" }),
  );
  return divider;
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

/** Apply the connection gate to one delete button in place. */
function applyDeleteGate(
  btn: HTMLButtonElement,
  status: "connected" | "reconnecting" | "disconnected",
): void {
  if (status === "connected") {
    btn.disabled = false;
    btn.removeAttribute("aria-disabled");
    btn.title = messagingText("action.delete");
    return;
  }
  btn.disabled = true;
  btn.setAttribute("aria-disabled", "true");
  btn.title = connectionLockReason(status) ?? messagingText("action.delete");
}

/** Toggle the delete gate on every rendered delete control for the current
 *  connection status. Called on a connection flip; no row is rebuilt. */
export function refreshConnectionControls(root: ParentNode): void {
  const status = uiStore.getState().connectionStatus;
  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-testid^='msg-delete-']")) {
    applyDeleteGate(btn, status);
  }
}

/**
 * The quoted bar above a reply. Clicking it jumps to the replied-to message —
 * including when that message is outside the loaded window, which is why the
 * bar stays clickable even in the "unknown message" case: the id is known, and
 * the jump path can fetch the window around it. A deleted target has nothing
 * to jump to, so its bar is plain text: "Original message was deleted".
 */
function renderReplyRef(
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
  const parentAuthorId = ref?.user.id ?? referenced?.user?.id;
  if (parentAuthorId !== undefined && opts.blockedUsers?.has(parentAuthorId) === true) {
    bar.classList.add("msg-reply-ref--blocked");
    setText(bar, messagingText("blocked.message"));
  } else if (ref) {
    // A sticker message has no text of its own: say what it is.
    const plain =
      stickerReplyText(ref.sticker, ref.content) ??
      Array.from(markdownToPlainText(ref.content, messagingText("spoiler.revealed")))
        .slice(0, 100)
        .join("");
    // A message that is only an attachment (or only a spoiler) has no plain
    // text; show a placeholder rather than an empty preview (F24).
    const preview = plain === "" ? messagingText("reply.attachment") : plain;
    if (ref.importedAuthor !== undefined) {
      bar.dataset["authorKey"] = importedAuthorKey(ref.importedAuthor);
      appendChildren(
        bar,
        createImportedAvatar(ref.importedAuthor, "rr-avatar"),
        createImportedName(ref.importedAuthor, "rr-author"),
        createImportedTag(),
        createElement("span", { class: "rr-text" }, preview),
      );
      return bar;
    }
    const author = resolveAuthor(ref.user);
    const roleColor = userRoleColorVar(ref.user.id);
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
      createElement("span", { class: "rr-text" }, preview),
    );
  } else if (referenced?.user) {
    const importedParent = referenced.imported_author;
    if (importedParent !== undefined) {
      bar.dataset["authorKey"] = importedAuthorKey(importedParent);
      const snippet =
        stickerReplyPreview(referenced.content) ??
        markdownToPlainText(referenced.content, messagingText("spoiler.revealed"));
      appendChildren(
        bar,
        createImportedAvatar(importedParent, "rr-avatar"),
        createImportedName(importedParent, "rr-author"),
        createImportedTag(),
        createElement(
          "span",
          { class: "rr-text" },
          snippet === "" ? messagingText("reply.attachment") : snippet,
        ),
      );
      return bar;
    }
    const author = resolveAuthor(referenced.user);
    const roleColor = userRoleColorVar(referenced.user.id);
    bar.dataset["authorKey"] = authorAvatarKey(author, roleColor);
    const plain =
      stickerReplyPreview(referenced.content) ??
      markdownToPlainText(referenced.content, messagingText("spoiler.revealed"));
    appendChildren(
      bar,
      createAvatarElement(author, {
        className: "rr-avatar",
        background: pickAvatarColor(author.username),
      }),
      createElement("span", { class: "rr-author" }, resolveDisplayName(author)),
      createElement(
        "span",
        { class: "rr-text" },
        plain === "" ? messagingText("reply.attachment") : plain,
      ),
    );
  } else {
    setText(bar, messagingText("reply.unknown"));
  }
  return bar;
}

function renderSystemMessage(msg: Message): HTMLDivElement {
  const el = createElement("div", { class: "system-msg" });
  const icon = createElement("span", { class: "sm-icon" });
  icon.appendChild(createIcon("arrow-right", 14));
  const text = createElement("span", { class: "sm-text" });
  text.appendChild(renderMentions(msg.content));
  const time = createElement("span", { class: "sm-time" }, formatMessageTimestamp(msg.timestamp));
  appendChildren(el, icon, text, time);
  return el;
}

/**
 * A DM call log row, drawn from `kind` and `call` only, never from
 * `content`. Live calls offer Join; an ended call reads "lasted N minutes" to
 * the author and anyone who joined, and "You missed a call" to everyone else.
 */
function renderCallRow(
  msg: Message,
  call: CallInfo,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const name = resolveDisplayName(resolveAuthor(msg.user));
  const live = call.ended_at === null;
  const missed =
    !live && msg.user.id !== opts.currentUserId && !call.participants.includes(opts.currentUserId);
  const el = createElement("div", {
    class: "message call-row" + (missed ? " call-missed" : ""),
    "data-testid": `message-${msg.id}`,
  });
  const icon = createElement("span", { class: "cr-icon" });
  icon.appendChild(createIcon(missed ? "phone-off" : "phone", 16));
  const text = createElement("span", { class: "cr-text" });
  if (live) {
    setText(text, dmCallText("rowLive", { name }));
  } else {
    const seconds = Math.max(
      0,
      (parseTimestamp(call.ended_at).getTime() - parseTimestamp(call.started_at).getTime()) / 1000,
    );
    const count = Math.floor(seconds / 60);
    const few = count < 1;
    if (missed) {
      setText(
        text,
        few
          ? dmCallText("rowMissedSeconds", { name })
          : dmCallText("rowMissedMinutes", { name, count }),
      );
    } else {
      setText(
        text,
        few
          ? dmCallText("rowLastedSeconds", { name })
          : dmCallText("rowLastedMinutes", { name, count }),
      );
    }
  }
  const time = createElement(
    "span",
    { class: "cr-time", title: fullDateTimeTitle(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(el, icon, text);
  const inThisCall = voiceStore.getState().currentChannelId === msg.channelId;
  if (live && opts.onJoinCall !== undefined && !inThisCall) {
    const join = createElement(
      "button",
      {
        class: "cr-join",
        "data-testid": `call-join-${msg.id}`,
        "aria-label": dmCallText("rowJoinLabel"),
      },
      dmCallText("rowJoin"),
    );
    const onJoinCall = opts.onJoinCall;
    join.addEventListener("click", () => onJoinCall(msg.channelId), { signal });
    el.appendChild(join);
  }
  el.appendChild(time);
  return el;
}

/**
 * A group DM system row: add, remove, leave, rename, icon. A
 * one-line record like a call row, drawn from `kind` + `groupEvent` alone. The
 * group name is set as text, so it is never parsed as markdown or mentions.
 */
function renderGroupRow(msg: Message, text: string): HTMLDivElement {
  const el = createElement("div", {
    class: "message group-row",
    "data-testid": `message-${msg.id}`,
  });
  const icon = createElement("span", { class: "gr-icon" });
  icon.appendChild(createIcon(groupRowIcon(msg.kind), 16));
  const body = createElement("span", { class: "gr-text" });
  setText(body, text);
  const time = createElement(
    "span",
    { class: "gr-time", title: fullDateTimeTitle(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(el, icon, body, time);
  return el;
}

/**
 * A "pinned a message" row: the same one-line record as a group row,
 * with two links in its sentence. See pinRows.ts.
 */
function renderPinRow(msg: Message, opts: MessageListOptions, signal: AbortSignal): HTMLDivElement {
  const el = createElement("div", {
    class: "message pin-row",
    "data-testid": `message-${msg.id}`,
  });
  const icon = createElement("span", { class: "pr-icon" });
  icon.appendChild(createIcon("pin", 16));
  const time = createElement(
    "span",
    { class: "pr-time", title: fullDateTimeTitle(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(el, icon, renderPinRowText(msg, opts, signal), time);
  return el;
}

/**
 * A welcome row: the joiner's avatar, one greeting line picked by the
 * row id, and a Wave button for everyone else who can post in the channel.
 */
function renderWelcomeRow(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const author = resolveAuthor(msg.user);
  const el = createElement("div", {
    class: "message welcome-row",
    "data-testid": `message-${msg.id}`,
  });
  const avatar = createAvatarElement(author, {
    className: "wr-avatar",
    background: pickAvatarColor(author.username),
    attrs: { "data-user-id": String(msg.user.id) },
  });
  const text = createElement("span", { class: "wr-text" });
  setText(text, welcomeGreeting(msg.id, resolveDisplayName(author)));
  const time = createElement(
    "span",
    { class: "wr-time", title: fullDateTimeTitle(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(el, avatar, text);
  if (opts.onWave !== undefined && msg.user.id !== opts.currentUserId && canWaveIn(msg.channelId)) {
    el.appendChild(renderWaveButton(msg.id, opts.onWave, signal));
  }
  el.appendChild(time);
  return el;
}

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

export function renderMessage(
  msg: Message,
  isGrouped: boolean,
  allMessages: readonly Message[],
  opts: MessageRenderOptions,
  signal: AbortSignal,
  /** The inline editor to host in place of the message body. */
  editor?: HTMLElement,
): HTMLDivElement {
  // id 0 is the reserved sentinel for server-synthesized system rows (DB
  // user ids are AUTOINCREMENT starting at 1, so no real account can ever
  // hold it). Dispatching on the username alone let any account that
  // registered the display name "System" render with no author, no role
  // colour and no moderation controls — indistinguishable from a genuine
  // server notice.
  if (msg.user.id === 0 && msg.user.username === "System") {
    return renderSystemMessage(msg);
  }

  // A call log row is drawn from kind + call alone, and a group DM row from
  // kind + groupEvent. Any other kind (a future one) falls back to plain system
  // text; so does a call row with no `call`. An empty kind counts as unset.
  if (isServerRowKind(msg.kind)) {
    if (msg.kind === "call" && msg.call !== undefined) {
      return renderCallRow(msg, msg.call, opts, signal);
    }
    if (isPinRowKind(msg.kind)) return renderPinRow(msg, opts, signal);
    if (isWelcomeRowKind(msg.kind)) return renderWelcomeRow(msg, opts, signal);
    const groupText = groupRowText(msg, opts.currentUserId);
    if (groupText !== null) return renderGroupRow(msg, groupText);
    const fallback = renderSystemMessage(msg);
    fallback.dataset["testid"] = `message-${msg.id}`;
    return fallback;
  }

  const statusClass =
    msg.status === "pending" || msg.status === "uploading"
      ? " pending"
      : msg.status === "failed"
        ? " failed"
        : "";
  const mentionInfo = {
    mentions: msg.mentions,
    mentionsEveryone: msg.mentionsEveryone,
    mentionRoles: msg.mentionRoles,
  };
  // A deleted row shows no content, so it must not keep the mention accent.
  const mentionedClass =
    !msg.deleted && highlightsCurrentUser(msg.content, mentionInfo) ? " mentioned" : "";
  const el = createElement("div", {
    class:
      (isGrouped ? "message grouped" : "message") +
      statusClass +
      mentionedClass +
      (editor === undefined ? "" : " editing"),
    "data-testid": `message-${msg.id}`,
  });

  // The author's current identity, not the one frozen into the payload: a
  // rename or a new avatar has to show up on the messages already on screen.
  const author = resolveAuthor(msg.user);
  const roleColor = userRoleColorVar(msg.user.id);
  const imported = msg.importedAuthor;
  // Tag the row with the identity it was drawn from, so MessageList can repaint
  // only the rows whose author actually changed on a roleRevision bump.
  el.dataset["authorKey"] =
    imported === undefined ? authorAvatarKey(author, roleColor) : importedAuthorKey(imported);
  // An imported author has no account to open, so its avatar carries no user id.
  const avatar =
    imported === undefined
      ? createAvatarElement(author, {
          className: "msg-avatar",
          background: pickAvatarColor(author.username),
          attrs: { "data-user-id": String(msg.user.id) },
        })
      : createImportedAvatar(imported, "msg-avatar");
  el.appendChild(avatar);

  if (isGrouped) {
    const hoverTime = createElement(
      "div",
      {
        class: "msg-hover-time",
        title: fullDateTimeTitle(msg.timestamp),
      },
      // The header's clock time without its "Today at" (F24): the full form
      // wrapped onto three lines over the avatar column. The title has the date.
      formatClockTime(msg.timestamp),
    );
    el.appendChild(hoverTime);
  }

  if (msg.replyTo !== null) {
    el.appendChild(renderReplyRef(msg.replyTo, msg.referencedMessage, allMessages, opts, signal));
  }

  const header = createElement("div", { class: "msg-header" });
  const authorEl =
    imported !== undefined
      ? createImportedName(imported, "msg-author msg-author--imported")
      : createElement(
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
  const time = createElement(
    "span",
    { class: "msg-time", title: fullDateTimeTitle(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  // Compact mode shows this short clock time ahead of the name; CSS hides it
  // otherwise. The clock time never changes, so relabelRenderedTimes skips it.
  const compactTime = createElement(
    "span",
    { class: "msg-compact-time", title: fullDateTimeTitle(msg.timestamp) },
    formatClockTime(msg.timestamp),
  );
  appendChildren(header, compactTime, authorEl);
  if (imported !== undefined) header.appendChild(createImportedTag());
  header.appendChild(time);
  el.appendChild(header);

  if (editor !== undefined) {
    // The editor takes the body's place; attachments and reactions stay.
    el.appendChild(editor);
    appendAttachments(el, msg);
    if (msg.reactions.length > 0) {
      el.appendChild(renderReactions(msg, opts, signal));
    }
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
    if (msg.reactions.length > 0) {
      el.appendChild(renderReactions(msg, opts, signal));
    }
  } else if (msg.sticker !== undefined) {
    // A sticker stands alone: the server's "[Sticker: name]" fallback
    // is for clients that predate stickers. It has no files or embeds, and
    // reactions stay.
    el.appendChild(renderStickerBody(msg.sticker, signal));
    if (msg.reactions.length > 0) {
      el.appendChild(renderReactions(msg, opts, signal));
    }
  } else {
    // Key the parse cache by the message's identity plus its edit stamp: an
    // unchanged message reuses its parse when a row is re-materialised, and an
    // edit changes the key so the new content is parsed. Id 0 is the
    // unconfirmed-optimistic sentinel shared by every pending row, so it is not
    // a unique identity — those parse uncached.
    const cacheKey = msg.id === 0 ? undefined : `${msg.id}\u0000${msg.editedAt ?? ""}`;
    const body = renderMessageContent(msg.content, mentionInfo, cacheKey);
    // A forward's text, files and embeds sit inside its "Forwarded" frame.
    const box = msg.forward === undefined ? el : startForwardBlock();
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
    const embeds = renderUrlEmbeds(msg.content);
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

    if (msg.reactions.length > 0) {
      el.appendChild(renderReactions(msg, opts, signal));
    }
  }

  // A send queued behind its files shows them, with progress and Cancel while
  // they upload and plain once it failed (3A-9).
  if ((msg.status === "uploading" || msg.status === "failed") && msg.correlationId !== null) {
    const strip = opts.renderUploadStrip?.(msg.correlationId, signal);
    if (strip != null) el.appendChild(strip);
  }

  // Failed optimistic send: show the reason and offer retry / discard.
  if (msg.status === "failed" && msg.correlationId !== null) {
    const cid = msg.correlationId;
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
    el.appendChild(bar);
  }

  // The hover action bar only applies to confirmed server messages — not
  // deleted rows or unsent optimistic rows. Normal bar: the quick reactions,
  // React, Edit (own) or Reply (others'), then "...". Holding Shift also shows
  // Pin, Delete and, on your own message, Reply (CSS on `.shift-held`; the
  // buttons are always rendered when their gate allows, `display:none` keeps
  // them out of the tab order otherwise). Copy Link, Report and Copy ID live
  // in the "..." menu.
  if (!msg.deleted && msg.status === "sent" && editor === undefined) {
    const gates = messageActionGates(msg, opts);
    const actionsBar = createElement("div", { class: "msg-actions-bar" });

    // The lock is applied at render from the current timeout, then updated in
    // place by refreshReactionLocks when the timeout changes.
    quickReactionEmojiForPass(QUICK_REACTIONS).forEach((emoji, index) => {
      // A new emoji on a message at the cap is left out, as in the menu.
      if (atReactionLimit(msg.reactions, emoji)) return;
      const { node, name } = emojiNode(emoji);
      const label = messagingText("action.reactWith", { name });
      const quickBtn = createElement("button", {
        class: "msg-quick-react",
        "data-testid": `msg-quick-react-${msg.id}-${index}`,
        "aria-label": label,
      });
      quickBtn.appendChild(node);
      quickBtn.title = label;
      wireReactionControl(
        quickBtn,
        () => opts.onReactionClick(msg.id, emoji),
        gates.react.reason,
        signal,
      );
      actionsBar.appendChild(quickBtn);
    });

    const reactBtn = createElement("button", {
      "data-testid": `msg-react-${msg.id}`,
      "aria-label": messagingText("action.react"),
    });
    reactBtn.appendChild(createIcon("smile", 16));
    reactBtn.title = messagingText("action.react");
    wireReactionControl(
      reactBtn,
      () => opts.onReactionClick(msg.id, ""),
      gates.react.reason,
      signal,
    );
    actionsBar.appendChild(reactBtn);

    const own = gates.edit.shown;
    if (own) {
      const editBtn = createElement("button", {
        "data-testid": `msg-edit-${msg.id}`,
        "aria-label": messagingText("action.edit"),
      });
      editBtn.appendChild(createIcon("pencil", 16));
      editBtn.title = messagingText("action.edit");
      editBtn.addEventListener("click", () => opts.onEditClick(msg.id), { signal });
      actionsBar.appendChild(editBtn);
    }

    const replyBtn = createElement("button", {
      class: own ? "msg-shift-only" : "",
      ...(own ? { tabindex: "-1" } : {}),
      "data-testid": `msg-reply-${msg.id}`,
      "aria-label": messagingText("action.reply"),
    });
    replyBtn.appendChild(createIcon("reply", 16));
    replyBtn.title = messagingText("action.reply");
    replyBtn.addEventListener("click", () => opts.onReplyClick(msg.id), { signal });
    actionsBar.appendChild(replyBtn);

    if (gates.pin.shown) {
      const pinBtn = createElement("button", {
        class: "msg-shift-only",
        tabindex: "-1",
        "data-testid": `msg-pin-${msg.id}`,
        "aria-label": msg.pinned ? messagingText("action.unpin") : messagingText("action.pin"),
      });
      pinBtn.appendChild(createIcon(msg.pinned ? "pin-off" : "pin", 16));
      pinBtn.title = msg.pinned ? messagingText("action.unpin") : messagingText("action.pin");
      pinBtn.addEventListener("click", () => opts.onPinClick(msg.id, msg.channelId, msg.pinned), {
        signal,
      });
      actionsBar.appendChild(pinBtn);
    }

    if (gates.delete.shown) {
      const deleteBtn = createElement("button", {
        class: "msg-shift-only",
        tabindex: "-1",
        "data-testid": `msg-delete-${msg.id}`,
        "aria-label": messagingText("action.delete"),
      });
      deleteBtn.appendChild(createIcon("trash-2", 16));
      // The listener is attached once; whether the button is disabled is read
      // at click time, so a connection flip is a class/attribute change on the
      // already-rendered button (refreshConnectionControls) rather than a row
      // rebuild.
      deleteBtn.addEventListener(
        "click",
        (e) => {
          if (deleteBtn.disabled) return;
          opts.onDeleteClick(msg.id, e.shiftKey);
        },
        { signal },
      );
      applyDeleteGate(deleteBtn, uiStore.getState().connectionStatus);
      actionsBar.appendChild(deleteBtn);
    }

    const moreBtn = createElement("button", {
      "data-testid": `msg-more-${msg.id}`,
      "aria-label": messagingText("action.more"),
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    });
    moreBtn.appendChild(createIcon("ellipsis", 16));
    moreBtn.title = messagingText("action.more");
    // Opened by MessageList's delegated listener, which owns the menu's signal.
    actionsBar.appendChild(moreBtn);

    el.appendChild(actionsBar);
  }

  return el;
}
