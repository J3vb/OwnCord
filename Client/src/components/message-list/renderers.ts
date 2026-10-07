/**
 * Message rendering barrel — re-exports the rendering helpers consumers use
 * and contains the composite functions (renderMessage, renderDayDivider,
 * renderReplyRef, renderSystemMessage) that orchestrate pieces from the
 * split modules.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { loadPref } from "@lib/preferences";
import { canManageMessages } from "@lib/permissions";
import { showToast } from "@lib/toast";
import { formatMessageLink } from "@lib/deep-link";
import type { Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { reportEntryText } from "../../i18n/reportEntry";
import { messagingText } from "../../i18n/messaging";
import { shellText } from "../../i18n/shell";
import { connectText } from "../../i18n/connect";
import { uiStore } from "@stores/ui.store";

/** Cached value of the developerMode preference. Invalidated on pref change. */
let developerModeEnabled = loadPref<boolean>("developerMode", false);
window.addEventListener("owncord:pref-change", ((e: CustomEvent<{ key: string }>) => {
  if (e.detail.key === "developerMode") {
    developerModeEnabled = loadPref<boolean>("developerMode", false);
  }
}) as EventListener);

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
} from "@lib/formatting";

export {
  renderInlineContent,
  renderMentions,
  renderMentionSegment,
  renderMessageContent,
} from "./content-parser";

export { setServerHost } from "./attachments";

// -- Imports for composite functions ------------------------------------------

import { formatFullDate, formatMessageTimestamp } from "@lib/formatting";
import { getUserRole, resolveAuthor, roleColorVar } from "@lib/formatting";
import { createAvatarElement } from "./avatar";
import { resolveDisplayName } from "@lib/avatar";
import { renderMentions, renderMessageContent } from "./content-parser";
import { markdownToPlainText } from "@lib/markdown";
import { highlightsCurrentUser } from "@lib/mentions";
import { readableRoleColor } from "@lib/themes";
import { renderUrlEmbeds } from "./media";
import { renderAttachment } from "./attachments";
import { reactionLockReason, renderReactions, wireReactionControl } from "./reactions";

// -- Composite rendering functions --------------------------------------------

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
 * The unread bar pinned to the top of the message region (P4-03 step B). The
 * caller owns the label text and the `hidden` state; the button only reports
 * the click.
 */
export function renderUnreadBar(
  onMarkRead: () => void,
  signal: AbortSignal,
): { readonly bar: HTMLDivElement; readonly label: HTMLSpanElement } {
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
  return { bar, label };
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
 * whose author actually changed (P4-02), so a role change or a rename does not
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

/** Apply the connection gate to one delete button in place (CLI-08). */
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
  btn.title = shellText(
    status === "reconnecting" ? "channel.reconnecting" : "channel.notConnected",
  );
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
 * the jump path can fetch the window around it.
 */
function renderReplyRef(
  replyToId: number,
  referenced: Message["referencedMessage"],
  allMessages: readonly Message[],
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const ref = allMessages.find((m) => m.id === replyToId);
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
  if (ref) {
    const plain = ref.deleted
      ? messagingText("message.deleted")
      : Array.from(markdownToPlainText(ref.content, messagingText("spoiler.revealed")))
          .slice(0, 100)
          .join("");
    // A message that is only an attachment (or only a spoiler) has no plain
    // text; show a placeholder rather than an empty preview (F24).
    const preview = plain === "" ? messagingText("reply.attachment") : plain;
    const role = getUserRole(ref.user.id);
    const author = resolveAuthor(ref.user);
    const roleColor = roleColorVar(role);
    // Tag the quoted author so a rename/role change repaints it in place,
    // without rebuilding the row (P4-02).
    bar.dataset["authorKey"] = authorAvatarKey(author, roleColor);
    const miniAvatar = createAvatarElement(author, {
      className: "rr-avatar",
      background: roleColor,
    });
    appendChildren(
      bar,
      miniAvatar,
      createElement("span", { class: "rr-author" }, resolveDisplayName(author)),
      createElement("span", { class: "rr-text" }, preview),
    );
  } else if (referenced?.deleted) {
    setText(bar, messagingText("message.deleted"));
  } else if (referenced?.user) {
    const author = resolveAuthor(referenced.user);
    const roleColor = roleColorVar(getUserRole(referenced.user.id));
    bar.dataset["authorKey"] = authorAvatarKey(author, roleColor);
    const plain = markdownToPlainText(referenced.content, messagingText("spoiler.revealed"));
    appendChildren(
      bar,
      createAvatarElement(author, { className: "rr-avatar", background: roleColor }),
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

/** Map a send-failure error code to a short, user-facing reason. */
function sendErrorReason(code: string | null): string {
  switch (code) {
    case "SLOW_MODE":
      return messagingText("send.slowMode");
    case "RATE_LIMITED":
      return messagingText("send.rateLimited");
    case "FORBIDDEN":
      return messagingText("send.forbidden");
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
    case "BAD_REQUEST":
      return messagingText("send.rejected");
    case "BEFORE_RESTORE":
      return connectText("app.sendBeforeRestore");
    default:
      return messagingText("send.failed");
  }
}

export function renderMessage(
  msg: Message,
  isGrouped: boolean,
  allMessages: readonly Message[],
  opts: MessageListOptions,
  signal: AbortSignal,
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

  const statusClass =
    msg.status === "pending" ? " pending" : msg.status === "failed" ? " failed" : "";
  const mentionInfo = { mentions: msg.mentions, mentionsEveryone: msg.mentionsEveryone };
  // A deleted row shows no content, so it must not keep the mention accent.
  const mentionedClass =
    !msg.deleted && highlightsCurrentUser(msg.content, mentionInfo) ? " mentioned" : "";
  const el = createElement("div", {
    class: (isGrouped ? "message grouped" : "message") + statusClass + mentionedClass,
    "data-testid": `message-${msg.id}`,
  });

  const role = getUserRole(msg.user.id);
  // The author's current identity, not the one frozen into the payload: a
  // rename or a new avatar has to show up on the messages already on screen.
  const author = resolveAuthor(msg.user);
  const roleColor = roleColorVar(role);
  // Tag the row with the identity it was drawn from, so MessageList can repaint
  // only the rows whose author actually changed on a roleRevision bump (P4-02).
  el.dataset["authorKey"] = authorAvatarKey(author, roleColor);
  const avatar = createAvatarElement(author, {
    className: "msg-avatar",
    background: roleColor,
  });
  el.appendChild(avatar);

  if (isGrouped) {
    const hoverTime = createElement(
      "div",
      {
        class: "msg-hover-time",
        title: formatFullDate(msg.timestamp),
      },
      // Same "Today at 2:34 PM" format the header uses, not a bare 24h HH:MM
      // that disagreed with it (F24).
      formatMessageTimestamp(msg.timestamp),
    );
    el.appendChild(hoverTime);
  }

  if (msg.replyTo !== null) {
    el.appendChild(renderReplyRef(msg.replyTo, msg.referencedMessage, allMessages, opts, signal));
  }

  const header = createElement("div", { class: "msg-header" });
  const authorEl = createElement(
    "span",
    {
      class: "msg-author",
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
    { class: "msg-time", title: formatFullDate(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(header, authorEl, time);
  el.appendChild(header);

  if (msg.deleted) {
    const text = createElement("div", { class: "msg-text" });
    text.style.fontStyle = "italic";
    text.style.color = "var(--text-muted)";
    setText(text, messagingText("message.deleted"));
    el.appendChild(text);
  } else {
    // Key the parse cache by the message's identity plus its edit stamp: an
    // unchanged message reuses its parse when a row is re-materialised, and an
    // edit changes the key so the new content is parsed (P4-02). Id 0 is the
    // unconfirmed-optimistic sentinel shared by every pending row, so it is not
    // a unique identity — those parse uncached.
    const cacheKey = msg.id === 0 ? undefined : `${msg.id}\u0000${msg.editedAt ?? ""}`;
    el.appendChild(renderMessageContent(msg.content, mentionInfo, cacheKey));
    if (msg.editedAt !== null) {
      el.appendChild(
        createElement("span", { class: "msg-edited" }, messagingText("message.edited")),
      );
    }

    for (const att of msg.attachments) {
      el.appendChild(renderAttachment(att));
    }

    // URL embeds (YouTube players, link previews)
    const embeds = renderUrlEmbeds(msg.content);
    if (embeds.childNodes.length > 0) {
      el.appendChild(embeds);
    }

    if (msg.reactions.length > 0) {
      el.appendChild(renderReactions(msg, opts, signal));
    }
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

  // The hover action bar (react/reply/pin/edit/delete) only applies to
  // confirmed server messages — not deleted rows or unsent optimistic rows.
  if (!msg.deleted && msg.status === "sent") {
    const actionsBar = createElement("div", { class: "msg-actions-bar" });

    const reactBtn = createElement("button", {
      "data-testid": `msg-react-${msg.id}`,
      "aria-label": messagingText("action.react"),
    });
    reactBtn.appendChild(createIcon("smile", 16));
    reactBtn.title = messagingText("action.react");
    // The lock is applied at render from the current timeout, then updated in
    // place by refreshReactionLocks when the timeout changes (P4-02).
    wireReactionControl(
      reactBtn,
      () => opts.onReactionClick(msg.id, ""),
      reactionLockReason(),
      signal,
    );
    actionsBar.appendChild(reactBtn);

    const replyBtn = createElement("button", {
      "data-testid": `msg-reply-${msg.id}`,
      "aria-label": messagingText("action.reply"),
    });
    replyBtn.appendChild(createIcon("reply", 16));
    replyBtn.title = messagingText("action.reply");
    replyBtn.addEventListener("click", () => opts.onReplyClick(msg.id), { signal });
    actionsBar.appendChild(replyBtn);

    const pinBtn = createElement("button", {
      "data-testid": `msg-pin-${msg.id}`,
      "aria-label": msg.pinned ? messagingText("action.unpin") : messagingText("action.pin"),
    });
    pinBtn.appendChild(createIcon(msg.pinned ? "pin-off" : "pin", 16));
    pinBtn.title = msg.pinned ? messagingText("action.unpin") : messagingText("action.pin");
    pinBtn.addEventListener("click", () => opts.onPinClick(msg.id, msg.channelId, msg.pinned), {
      signal,
    });
    // The server gates SetMessagePinned on MANAGE_MESSAGES for a channel, but
    // any DM participant may pin — so offering it to a plain member is a
    // broken affordance (PRD.md: permission is a pre-disabled affordance, not
    // a rejection after the fact).
    if (opts.channelType === "dm" || canManageMessages()) {
      actionsBar.appendChild(pinBtn);
    }

    if (msg.user.id === opts.currentUserId) {
      const editBtn = createElement("button", {
        "data-testid": `msg-edit-${msg.id}`,
        "aria-label": messagingText("action.edit"),
      });
      editBtn.appendChild(createIcon("pencil", 16));
      editBtn.title = messagingText("action.edit");
      editBtn.addEventListener("click", () => opts.onEditClick(msg.id), { signal });
      actionsBar.appendChild(editBtn);
    }

    // Own message, or a moderator acting on someone else's.
    if (msg.user.id === opts.currentUserId || canManageMessages()) {
      const deleteBtn = createElement("button", {
        "data-testid": `msg-delete-${msg.id}`,
        "aria-label": messagingText("action.delete"),
      });
      deleteBtn.appendChild(createIcon("trash-2", 16));
      // The listener is attached once; whether the button is disabled is read
      // at click time, so a connection flip is a class/attribute change on the
      // already-rendered button (refreshConnectionControls) rather than a row
      // rebuild (CLI-08).
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

    const copyLinkBtn = createElement("button", {
      "data-testid": `msg-copy-link-${msg.id}`,
      "aria-label": messagingText("action.copyLink"),
    });
    copyLinkBtn.appendChild(createIcon("link", 16));
    copyLinkBtn.title = messagingText("action.copyLink");
    copyLinkBtn.addEventListener(
      "click",
      () => {
        // No silent success: a copy with no feedback is indistinguishable
        // from a clipboard that refused.
        void navigator.clipboard.writeText(formatMessageLink(msg.channelId, msg.id)).then(
          () => showToast(messagingText("toast.linkCopied"), "success"),
          () => showToast(messagingText("toast.linkCopyFailed"), "error"),
        );
      },
      { signal },
    );
    actionsBar.appendChild(copyLinkBtn);

    // Someone else's message: report it, or one of its attachments (B9-10).
    const onReport = opts.onReportClick;
    if (onReport !== undefined && msg.user.id !== opts.currentUserId) {
      const reportBtn = createElement("button", {
        "data-testid": `msg-report-${msg.id}`,
        "aria-label": reportEntryText("reportMessage"),
        "aria-haspopup": "dialog",
      });
      reportBtn.appendChild(createIcon("flag", 16));
      reportBtn.title = reportEntryText("reportMessage");
      reportBtn.addEventListener("click", () => onReport(msg.id), { signal });
      actionsBar.appendChild(reportBtn);
    }

    if (developerModeEnabled) {
      const copyIdBtn = createElement("button", {
        "data-testid": `msg-copy-id-${msg.id}`,
        "aria-label": messagingText("action.copyId"),
      });
      copyIdBtn.appendChild(createIcon("hash", 16));
      copyIdBtn.title = messagingText("action.copyId");
      copyIdBtn.addEventListener(
        "click",
        () => {
          // No silent success: a copy with no feedback is indistinguishable
          // from a clipboard that refused.
          void navigator.clipboard.writeText(String(msg.id)).then(
            () => showToast(messagingText("toast.idCopied"), "success"),
            () => showToast(messagingText("toast.idCopyFailed"), "error"),
          );
        },
        { signal },
      );
      actionsBar.appendChild(copyIdBtn);
    }

    el.appendChild(actionsBar);
  }

  return el;
}
