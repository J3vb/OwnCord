/** Constants and small helpers the channel controller modules share. */
import { createElement } from "@lib/dom";
import { createLogger } from "@lib/logger";
import type { QueuedSend } from "../../../features/messaging/sendQueue";
import type { Message } from "@stores/messages.store";
import { resolveAuthor } from "@lib/text/formatting";
import { resolveDisplayName } from "@lib/ui/avatar";
import { markdownToPlainText } from "@lib/text/markdown";
import { authStore } from "@stores/auth.store";
import type { MessageUser } from "@lib/types";
import type { DmChannel } from "@stores/dm.store";
import { createAvatarElement, pickAvatarColor } from "../../../features/profiles/avatar";
import { buildGroupAvatarStack } from "@components/DmSidebar";
import { membersStore } from "@stores/members.store";
import { messagingText } from "../../../i18n/messaging";

export const log = createLogger("channel-ctrl");

/** Longer than ws.ts's 60 s server-silence deadline, so a half-open socket is
 *  declared dead (and the entry failed) before the entry can expire. */
export const TRACKED_ACTION_EXPIRY_MS = 90_000;

/** How long typing must pause before the draft is written to storage. */
export const DRAFT_SAVE_DELAY_MS = 750;

/** Characters of the message shown in the delete confirm. */
export const DELETE_PREVIEW_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** The header's mark for a DM: the partner's avatar, or a group's face stack. */
export function buildDmHeaderAvatar(dm: DmChannel, label: string): HTMLElement {
  if (dm.isGroup) {
    // The row's colour for a group, and a testid of its own so the header's
    // stack never doubles the row's.
    const stack = buildGroupAvatarStack(
      dm.channelId,
      dm.participants,
      label,
      "#5865F2",
      "ch-avatar-stack",
      dm.icon ?? null,
    );
    stack.setAttribute("aria-hidden", "true");
    return stack;
  }
  const member = membersStore.getState().members.get(dm.recipient.id);
  const wrapper = createAvatarElement(
    {
      username: dm.recipient.username,
      displayName: label,
      avatar: member?.avatar ?? dm.recipient.avatar,
    },
    { className: "ch-avatar-circle", background: pickAvatarColor(label) },
  );
  wrapper.setAttribute("aria-hidden", "true");
  return wrapper;
}

/** What the header's avatar is drawn from; equal keys mean the same picture. */
export function dmHeaderAvatarKey(dm: DmChannel, label: string): string {
  if (dm.isGroup) {
    return `g|${label}|${dm.icon ?? ""}|${dm.participants.map((p) => `${p.id}:${p.avatar}`).join(",")}`;
  }
  const member = membersStore.getState().members.get(dm.recipient.id);
  return `u|${label}|${dm.recipient.id}|${member?.avatar ?? dm.recipient.avatar}`;
}

export function currentMessageUser(): MessageUser | null {
  const u = authStore.getState().user;
  if (u === null) return null;
  return { id: u.id, username: u.username, avatar: u.avatar };
}

/** The message the dialog is about: author and a truncated plain-text
 *  excerpt, both set as text. An attachments-only message shows nothing
 *  extra beyond its author. */
export function renderDeletePreview(msg: Message): HTMLElement {
  const author = resolveDisplayName(resolveAuthor(msg.user));
  const plain = Array.from(markdownToPlainText(msg.content, messagingText("spoiler.revealed")));
  const excerpt = plain.slice(0, DELETE_PREVIEW_MAX_CHARS).join("");
  const preview = createElement("div", {
    class: "msg-delete-preview",
    "data-testid": "msg-delete-preview",
  });
  preview.appendChild(createElement("span", { class: "msg-delete-preview-author" }, author));
  if (excerpt !== "") {
    const truncated = plain.length > DELETE_PREVIEW_MAX_CHARS;
    preview.appendChild(
      createElement(
        "span",
        { class: "msg-delete-preview-text" },
        truncated ? `${excerpt}\u2026` : excerpt,
      ),
    );
  } else if (msg.attachments.length > 0) {
    preview.appendChild(
      createElement(
        "span",
        { class: "msg-delete-preview-text" },
        messagingText("reply.attachment"),
      ),
    );
  }
  return preview;
}

/** Stop a queued send's uploads (Delete, teardown, a stale account); the
 *  module's Cancel does the same once it is loaded. */
export function abortQueued(entry: QueuedSend): void {
  entry.cancelled = true;
  for (const item of entry.items) item.upload?.owner.destroy();
}

export interface TrackedEdit {
  readonly channelId: number;
  readonly messageId: number;
  readonly content: string;
}
