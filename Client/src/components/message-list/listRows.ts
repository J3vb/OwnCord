/**
 * Changes to rows already drawn in the message list: the inline editor, author
 * repaints and relative timestamps.
 */
import { isServerRowKind } from "@lib/text/messageKind";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { authorAvatarKey, fullDateTimeTitle } from "./renderers";
import { createAvatarElement, pickAvatarColor } from "./avatar";
import { withInlineEdit } from "../../features/messaging/inlineEditLoader";
import { relabelInlineTimestamps, resyncMentions } from "./contentParser";
import { highlightsCurrentUser } from "@lib/text/mentions";
import { applyPickedMentions, tokensToPickedText } from "@lib/text/pickedMentions";
import { readableRoleColor } from "@lib/prefs/themes";
import { resolveDisplayName } from "@lib/ui/avatar";
import { channelsStore } from "@stores/channels.store";
import {
  formatClockTime,
  formatMessageTimestamp,
  resolveAuthor,
  userRoleColorVar,
} from "@lib/text/formatting";
import { idMentionsEnabled } from "@lib/net/serverCapabilities";
import type { ListState, ListApi } from "./listState";

export function createListRows(st: ListState, api: ListApi) {
  /**
   * Repaint author identity on the rendered rows whose author changed after a
   * members-store update, without rebuilding them. A row stores the
   * key it was drawn from in `data-author-key`; only a differing key patches
   * that row's avatar, name and role colour, so a rename or a role change
   * touches the affected rows and a presence update touches none.
   */
  function refreshAuthorRows(): void {
    if (st.contentContainer === null || st.renderedStart < 0) return;
    const children = st.contentContainer.children;
    for (let i = 0; i < children.length; i++) {
      const item = st.virtualItems[st.renderedStart + i];
      if (item?.kind !== "message") continue;
      const el = children[i] as HTMLElement;
      // A reply's quoted author can change even when the row's own author did
      // not, so this runs for every row, not only the ones whose own key moved.
      repaintReplyRefAuthors(el);
      const msg = item.message;
      // @mention resolution depends on the live member store, so a rename or a
      // membership change must re-resolve it on every rendered row — including
      // rows that merely mention the renamed member, not just those it authored
      // — without re-parsing or rebuilding them. A system row draws
      // its mentions with no server info, so it resyncs the same way.
      if (el.classList.contains("message")) {
        const mentionInfo = {
          mentions: msg.mentions,
          mentionsEveryone: msg.mentionsEveryone,
          mentionRoles: msg.mentionRoles,
        };
        resyncMentions(el, mentionInfo);
        el.classList.toggle(
          "mentioned",
          !msg.deleted && highlightsCurrentUser(msg.content, mentionInfo),
        );
      } else {
        resyncMentions(el);
      }
      // An imported author is not a member: no rename or role change reaches it.
      if (msg.importedAuthor !== undefined) continue;
      const roleColor = userRoleColorVar(msg.user.id);
      const author = resolveAuthor(msg.user);
      const key = authorAvatarKey(author, roleColor);
      if (key === el.dataset["authorKey"]) continue;
      el.dataset["authorKey"] = key;
      const name = resolveDisplayName(author);
      const authorEl = el.querySelector<HTMLElement>(".msg-author");
      if (authorEl !== null) {
        authorEl.textContent = name;
        authorEl.title = author.username;
        authorEl.dataset["roleColor"] = roleColor;
        authorEl.style.color = readableRoleColor(roleColor);
      }
      const avatar = el.querySelector<HTMLElement>(".msg-avatar");
      if (avatar !== null) {
        avatar.replaceWith(
          createAvatarElement(author, {
            className: "msg-avatar",
            background: pickAvatarColor(author.username),
            attrs: { "data-user-id": String(msg.user.id) },
          }),
        );
      }
    }
  }

  /**
   * Repaint the quoted author on every reply bar under `row` whose parent's
   * identity changed (a rename, avatar or role change), keyed by the same
   * `data-author-key`. The reply body text is left alone: it belongs to the
   * parent's message row, which the members-store update cannot change — only
   * a parent content edit does, and patchRows re-renders that row.
   */
  function repaintReplyRefAuthors(row: HTMLElement): void {
    for (const bar of row.querySelectorAll<HTMLElement>(".msg-reply-ref")) {
      const replyTo = Number(bar.dataset["replyTo"] ?? "0");
      const parent = st.replyParents.find((m) => m.id === replyTo);
      if (parent === undefined || parent.deleted || parent.importedAuthor !== undefined) continue;
      if (bar.classList.contains("msg-reply-ref--blocked")) continue;
      const roleColor = userRoleColorVar(parent.user.id);
      const author = resolveAuthor(parent.user);
      const key = authorAvatarKey(author, roleColor);
      if (key === bar.dataset["authorKey"]) continue;
      bar.dataset["authorKey"] = key;
      const name = resolveDisplayName(author);
      const authorEl = bar.querySelector<HTMLElement>(".rr-author");
      if (authorEl !== null) authorEl.textContent = name;
      const avatar = bar.querySelector<HTMLElement>(".rr-avatar");
      if (avatar !== null) {
        avatar.replaceWith(
          createAvatarElement(author, {
            className: "rr-avatar",
            background: pickAvatarColor(author.username),
          }),
        );
      }
    }
  }

  function relabelRenderedTimes(): void {
    if (st.contentContainer === null || st.renderedStart < 0) return;
    const children = st.contentContainer.children;
    for (let i = 0; i < children.length; i++) {
      const item = st.virtualItems[st.renderedStart + i];
      if (item?.kind !== "message") continue;
      const text = formatMessageTimestamp(item.message.timestamp);
      for (const el of children[i]!.querySelectorAll(".msg-time, .sm-time")) {
        el.textContent = text;
      }
      // The gutter and compact times are the short clock form, with no day word.
      const clock = formatClockTime(item.message.timestamp);
      for (const el of children[i]!.querySelectorAll(".msg-hover-time, .msg-compact-time")) {
        el.textContent = clock;
      }
      const title = fullDateTimeTitle(item.message.timestamp);
      for (const el of children[i]!.querySelectorAll<HTMLElement>(
        ".msg-time, .msg-hover-time, .msg-compact-time",
      )) {
        el.title = title;
      }
      const edited = children[i]!.querySelector<HTMLElement>(".msg-edited");
      if (edited !== null && item.message.editedAt !== null) {
        edited.title = fullDateTimeTitle(item.message.editedAt);
      }
      relabelInlineTimestamps(children[i]!);
    }
  }

  // ---------------------------------------------------------------------------
  // Inline edit
  // ---------------------------------------------------------------------------

  /** True while the open editor's textarea (or its links) holds focus. */
  function editHoldsFocus(): boolean {
    const el = st.edit?.session?.element;
    return el !== undefined && el.contains(document.activeElement);
  }

  /**
   * Draw message `id`'s row again in place and release the old one. Used when
   * editing starts or stops: the message object did not change, so patchRows
   * would keep the row. A row outside the rendered window is left to the next
   * build, which reads `edit`.
   */
  function replaceRenderedRow(id: number): void {
    if (st.contentContainer === null) return;
    const idx = st.virtualItems.findIndex((it) => it.kind === "message" && it.message.id === id);
    const old = idx === -1 ? undefined : api.renderedRowAt(idx);
    if (old === undefined || !(old instanceof HTMLElement)) return;
    const edge = api.edgeOf(old);
    const fresh = api.renderVirtualItem(st.virtualItems[idx]!);
    st.contentContainer.replaceChild(fresh, old);
    api.releaseRow(old);
    api.measureRendered();
    api.updateSpacers();
    api.holdRow(fresh, edge);
  }

  /** Close the open editor. With `notify`, an editor that held focus hands it back. */
  function closeEdit(notify: boolean): void {
    if (st.edit === null) return;
    const { messageId, session } = st.edit;
    const hadFocus = notify && editHoldsFocus();
    st.edit = null;
    st.editGen++;
    st.editRefocus = false;
    session?.destroy();
    replaceRenderedRow(messageId);
    if (hadFocus) st.options.onEditEnd?.();
  }

  /** An editor whose message left the list (deleted, or a window swap) closes. */
  function dropGoneEdit(hadFocus: boolean): void {
    if (st.edit === null || st.allMessages.some((m) => m.id === st.edit?.messageId)) return;
    const { session } = st.edit;
    st.edit = null;
    st.editRefocus = false;
    st.editGen++;
    session?.destroy();
    if (hadFocus) st.options.onEditEnd?.();
  }

  /** After the editor grew, keep its bottom (where the caret is) inside the view. */
  function keepEditorCaretInView(): void {
    if (st.root === null || !editHoldsFocus()) return;
    const box = st.edit?.session?.element;
    if (box === undefined) return;
    const over = box.getBoundingClientRect().bottom - st.root.getBoundingClientRect().bottom;
    if (over > 0) api.setScrollTop(st.root.scrollTop + over);
  }

  function startEdit(
    messageId: number,
    text?: string,
    opts?: { readonly focus?: boolean },
  ): boolean {
    const takeFocus = opts?.focus !== false;
    if (st.root === null) return false;
    const msg = st.allMessages.find((m) => m.id === messageId);
    if (msg === undefined || msg.user.id !== st.options.currentUserId || msg.status !== "sent") {
      return false;
    }
    // A server-written row (call log, group event) is read-only.
    if (isServerRowKind(msg.kind)) return false;
    // A sticker message has no text to edit; the server refuses it.
    if (msg.sticker !== undefined) return false;
    if (st.edit?.messageId === messageId) {
      if (takeFocus) st.edit.session?.focusEnd();
      return true;
    }
    closeEdit(false);
    st.editRefocus = false;
    const gen = ++st.editGen;
    st.edit = { messageId, session: null, gen };
    // Stored `<@id>` / `<@&id>` tokens read as `@name` in the box, and the
    // spans left intact turn back into tokens on save.
    const names = {
      user: (id: number) => {
        const member = membersStore.getState().members.get(id);
        return member === undefined ? undefined : memberDisplayName(member);
      },
      role: (id: number) => channelsStore.getState().roles.find((r) => r.id === id)?.name,
    };
    const shown = tokensToPickedText(msg.content, names);
    // A restored edit draft (failed save) is converted the same way.
    const restored = text === undefined ? shown : tokensToPickedText(text, names);
    const startText = restored.text;
    // Without the capability the box showed the raw text; save it as is.
    const expandPicks = (content: string): string =>
      applyPickedMentions(content, idMentionsEnabled() ? [...shown.picks, ...restored.picks] : []);
    withInlineEdit(
      (m) => {
        if (st.edit === null || st.edit.gen !== gen || st.disposable.signal.aborted) return;
        const session = m.createInlineEdit({
          messageId,
          text: startText,
          expand: expandPicks,
          onSave: (content) => {
            if (st.options.onEditSave(messageId, expandPicks(content))) {
              closeEdit(true);
            }
          },
          onCancel: () => closeEdit(true),
          onEmpty: () => st.options.onEmptyEdit(messageId),
        });
        st.edit.session = session;
        replaceRenderedRow(messageId);
        const idx = st.virtualItems.findIndex(
          (it) => it.kind === "message" && it.message.id === messageId,
        );
        const row = idx === -1 ? undefined : api.renderedRowAt(idx);
        const visible =
          row !== undefined &&
          st.root !== null &&
          api.edgeOf(row) >= 0 &&
          api.edgeOf(row) + row.getBoundingClientRect().height <= st.root.clientHeight;
        // Already on screen: leave the view alone. Otherwise bring the row in.
        // A quiet restore never moves the view or the focus.
        if (!takeFocus) return;
        if (!visible && idx !== -1) api.revealIndex(idx, false, false);
        session.focusEnd();
      },
      () => {
        // The editor chunk failed to load: nothing is open, so nothing is "editing".
        if (st.edit !== null && st.edit.gen === gen && st.edit.session === null) st.edit = null;
      },
    );
    return true;
  }

  function cancelEdit(): void {
    closeEdit(true);
  }

  function isEditing(): boolean {
    return st.edit !== null;
  }

  return {
    refreshAuthorRows,
    repaintReplyRefAuthors,
    relabelRenderedTimes,
    editHoldsFocus,
    replaceRenderedRow,
    closeEdit,
    dropGoneEdit,
    keepEditorCaretInView,
    startEdit,
    cancelEdit,
    isEditing,
  };
}
