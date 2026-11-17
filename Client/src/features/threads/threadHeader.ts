/**
 * The thread panel's header: the thread's name, where it lives, its status and
 * forum tags, and the actions this viewer may use (follow, rename, archive,
 * lock, delete). A phone shows only the overflow button and Close; the actions
 * open in one sheet.
 */

import { isImeCommit } from "@lib/text/ime";
import { createElement, setText } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import type { ContextMenuItem } from "@lib/ui/contextMenu";
import type { WsClient } from "@lib/ws";
import { threadFollowsEnabled } from "@lib/net/serverCapabilities";
import { channelsStore } from "@stores/channels.store";
import { getThread, isFollowed } from "@stores/threads.store";
import { createConfirmModal } from "../dialogs/confirmModal";
import { openMenuSheet } from "../menus/menuSheet";
import { createArchiveIcon } from "../messaging/message-list/threadChip";
import {
  canManageThread,
  cleanThreadName,
  isThreadModerator,
  sendThreadDelete,
  sendThreadFollow,
  sendThreadUpdate,
  THREAD_NAME_MAX,
} from "./threadCommands";
import { currentUserId } from "./threadSender";
import { threadsText } from "../../i18n/threads";

export interface ThreadHeader {
  readonly element: HTMLDivElement;
  /** The name, status and the actions this viewer may use, from the thread's current state. */
  paint(): void;
}

export function createThreadHeader(options: {
  readonly ws: WsClient;
  readonly threadId: number;
  readonly signal: AbortSignal;
  readonly showToast: (msg: string, type: "success" | "error" | "info") => void;
  /** The panel's own close button. */
  readonly onClose: () => void;
  /** The panel's accessible name follows the thread's. */
  readonly setRootLabel: (name: string) => void;
}): ThreadHeader {
  const { ws, threadId, signal, showToast, onClose, setRootLabel } = options;
  const thread = () => getThread(threadId);

  const nameEl = createElement("span", { class: "thread-panel-name" });
  const parentEl = createElement("span", { class: "thread-panel-parent" });
  const statusEl = createElement("span", {
    class: "thread-panel-status",
    "data-testid": "thread-panel-status",
  });
  /** A forum post's tags; empty and hidden on any other thread. */
  const tagsEl = createElement("span", {
    class: "forum-tags thread-panel-tags",
    "data-testid": "thread-panel-tags",
  });
  const actionsEl = createElement("div", { class: "thread-panel-actions" });
  const titleEl = createElement("div", { class: "thread-panel-title" });
  const renameForm = createElement("form", { class: "thread-panel-rename" });
  renameForm.hidden = true;

  function iconButton(
    icon: IconName | "archive",
    testId: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = createElement("button", {
      type: "button",
      class: "thread-panel-btn",
      "data-testid": testId,
    });
    btn.appendChild(icon === "archive" ? createArchiveIcon(16) : createIcon(icon, 16));
    btn.addEventListener("click", onClick, { signal });
    return btn;
  }

  const renameBtn = iconButton("pencil", "thread-rename", () => startRename());
  const archiveBtn = iconButton("archive", "thread-archive", () => {
    const t = thread();
    if (t !== undefined) update({ archived: !t.archived });
  });
  const lockBtn = iconButton("lock", "thread-lock", () => {
    const t = thread();
    if (t !== undefined) update({ locked: !t.locked });
  });
  // Follow / Following: the state comes back as thread_follow_update.
  const followBtn = createElement("button", {
    type: "button",
    class: "thread-panel-btn thread-panel-follow",
    "data-testid": "thread-follow",
  });
  followBtn.addEventListener(
    "click",
    () => {
      if (!sendThreadFollow(ws, threadId, !isFollowed(threadId))) {
        showToast(threadsText("toast.notConnected"), "error");
      }
    },
    { signal },
  );
  const deleteBtn = iconButton("trash-2", "thread-delete", () => confirmDelete());
  deleteBtn.classList.add("danger");
  const closeBtn = iconButton("x", "thread-close", onClose);
  closeBtn.classList.add("thread-panel-close");
  closeBtn.title = threadsText("panel.close");
  closeBtn.setAttribute("aria-label", threadsText("panel.close"));
  // A phone shows only this and Close; the actions open in one sheet.
  const moreBtn = iconButton("ellipsis", "thread-more", () => openActionsSheet());
  moreBtn.classList.add("thread-panel-more");
  moreBtn.title = threadsText("panel.more");
  moreBtn.setAttribute("aria-label", threadsText("panel.more"));
  moreBtn.setAttribute("aria-haspopup", "true");
  moreBtn.setAttribute("aria-expanded", "false");

  /** Where focus lands after an action, on whichever layout shows it. */
  const actionFocus = (desktopBtn: HTMLButtonElement): HTMLButtonElement =>
    isPhoneLayout() ? moreBtn : desktopBtn;

  /** The header actions this viewer may use, as sheet rows in the desktop order. */
  function actionItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    const row = (btn: HTMLButtonElement, item: ContextMenuItem): void => {
      if (!btn.hidden) items.push(item);
    };
    row(followBtn, {
      label: threadsText("follow.follow"),
      checked: isFollowed(threadId),
      testId: "thread-sheet-follow",
      icon: "bell",
      onClick: () => followBtn.click(),
    });
    row(renameBtn, {
      label: threadsText("action.rename"),
      testId: "thread-sheet-rename",
      icon: "pencil",
      onClick: () => startRename(),
    });
    row(archiveBtn, {
      label: archiveBtn.getAttribute("aria-label") ?? "",
      testId: "thread-sheet-archive",
      icon: "archive",
      onClick: () => archiveBtn.click(),
    });
    row(lockBtn, {
      label: lockBtn.getAttribute("aria-label") ?? "",
      testId: "thread-sheet-lock",
      icon: "lock",
      onClick: () => lockBtn.click(),
    });
    row(deleteBtn, {
      label: threadsText("action.delete"),
      danger: true,
      testId: "thread-sheet-delete",
      icon: "trash-2",
      onClick: () => confirmDelete(),
    });
    return items;
  }

  function openActionsSheet(): void {
    const items = actionItems();
    if (items.length === 0) return;
    moreBtn.setAttribute("aria-expanded", "true");
    openMenuSheet({
      items,
      label: threadsText("panel.more"),
      testId: "thread-actions-sheet",
      signal,
      fallbackFocus: () => (moreBtn.isConnected ? moreBtn : null),
      onClosed: () => moreBtn.setAttribute("aria-expanded", "false"),
    });
  }

  function update(fields: Parameters<typeof sendThreadUpdate>[2]): void {
    if (!sendThreadUpdate(ws, threadId, fields)) {
      showToast(threadsText("toast.notConnected"), "error");
    }
  }

  const renameInput = createElement("input", {
    type: "text",
    class: "thread-panel-rename-input",
    maxlength: String(THREAD_NAME_MAX),
    "aria-label": threadsText("rename.label"),
    "data-testid": "thread-rename-input",
  });
  const renameSave = createElement(
    "button",
    { type: "submit", class: "thread-panel-btn", "data-testid": "thread-rename-save" },
    threadsText("rename.save"),
  );
  const renameCancel = createElement(
    "button",
    { type: "button", class: "thread-panel-btn", "data-testid": "thread-rename-cancel" },
    threadsText("rename.cancel"),
  );
  renameForm.append(renameInput, renameSave, renameCancel);

  function startRename(): void {
    renameInput.value = thread()?.name ?? "";
    renameForm.hidden = false;
    titleEl.hidden = true;
    renameInput.focus();
    renameInput.select();
  }
  function endRename(): void {
    renameForm.hidden = true;
    titleEl.hidden = false;
    actionFocus(renameBtn).focus();
  }
  renameCancel.addEventListener("click", endRename, { signal });
  renameInput.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !isImeCommit(e)) {
        e.stopPropagation();
        endRename();
      }
    },
    { signal },
  );
  renameForm.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const name = cleanThreadName(renameInput.value);
      if (name === null) return;
      if (name !== thread()?.name) update({ name });
      endRename();
    },
    { signal },
  );

  function confirmDelete(): void {
    const t = thread();
    if (t === undefined) return;
    createConfirmModal({
      title: threadsText("delete.title"),
      titleId: `thread-delete-title-${threadId}`,
      body: threadsText("delete.body", { name: t.name }),
      confirmLabel: threadsText("delete.confirm"),
      testId: "thread-delete-modal",
      confirmTestId: "thread-delete-confirm",
      cancelTestId: "thread-delete-cancel",
      signal,
      fallbackFocus: () => actionFocus(deleteBtn),
      onConfirm: () => {
        if (!sendThreadDelete(ws, threadId)) {
          showToast(threadsText("toast.notConnected"), "error");
        }
      },
    });
  }

  /** The name, status and the actions this viewer may use, from the thread's current state. */
  function paintHeader(): void {
    const t = thread();
    if (t === undefined) return;
    setText(nameEl, t.name);
    const parent = channelsStore.getState().channels.get(t.parent_id);
    setText(
      parentEl,
      parent === undefined ? "" : threadsText("panel.in", { channel: parent.name }),
    );
    const marks = [
      t.archived ? threadsText("status.archived") : "",
      t.locked ? threadsText("status.locked") : "",
    ].filter((m) => m !== "");
    setText(statusEl, marks.join(" · "));
    statusEl.hidden = marks.length === 0;
    const forumTags = channelsStore.getState().channels.get(t.parent_id)?.forum?.tags ?? [];
    tagsEl.replaceChildren(
      ...forumTags
        .filter((tag) => t.post?.tag_ids.includes(tag.id) === true)
        .map((tag) =>
          createElement("span", { class: "forum-tag" }, `${tag.emoji ?? ""} ${tag.name}`.trim()),
        ),
    );
    tagsEl.hidden = tagsEl.childElementCount === 0;

    const following = isFollowed(threadId);
    followBtn.hidden = !threadFollowsEnabled();
    followBtn.textContent = threadsText(following ? "follow.following" : "follow.follow");
    followBtn.setAttribute("aria-pressed", String(following));
    followBtn.title = threadsText(following ? "follow.unfollowHint" : "follow.followHint");

    const manage = canManageThread(t, currentUserId());
    const moderator = isThreadModerator(t);
    renameBtn.hidden = !manage;
    archiveBtn.hidden = !manage;
    lockBtn.hidden = !moderator;
    deleteBtn.hidden = !moderator;
    moreBtn.hidden = [followBtn, renameBtn, archiveBtn, lockBtn, deleteBtn].every((b) => b.hidden);
    const archiveLabel = threadsText(t.archived ? "action.unarchive" : "action.archive");
    archiveBtn.title = archiveLabel;
    archiveBtn.setAttribute("aria-label", archiveLabel);
    const lockLabel = threadsText(t.locked ? "action.unlock" : "action.lock");
    lockBtn.title = lockLabel;
    lockBtn.setAttribute("aria-label", lockLabel);
    renameBtn.title = threadsText("action.rename");
    renameBtn.setAttribute("aria-label", threadsText("action.rename"));
    deleteBtn.title = threadsText("action.delete");
    deleteBtn.setAttribute("aria-label", threadsText("action.delete"));
    setRootLabel(t.name);
  }

  const header = createElement("div", { class: "thread-panel-header" });
  titleEl.append(nameEl, parentEl, statusEl, tagsEl);
  actionsEl.append(followBtn, renameBtn, archiveBtn, lockBtn, deleteBtn, moreBtn, closeBtn);
  header.append(titleEl, renameForm, actionsEl);

  return { element: header, paint: paintHeader };
}
