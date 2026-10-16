/**
 * Which actions a message offers, decided once for every surface that lists
 * them: the hover action bar (renderers.ts) and the right-click menu
 * (message-menu.ts). Pure over the stores, so the two cannot drift.
 */

import { loadPref } from "@lib/preferences";
import { channelBitOrRole } from "@lib/permissions";
import { formatMessageLink } from "@lib/deep-link";
import { showToast } from "@lib/toast";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { getChannelMessages, type Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { messagingText } from "../../i18n/messaging";
import { shellText } from "../../i18n/shell";
import { channelCanReact, reactionLockReason } from "./reactions";

/** Cached value of the developerMode preference. Invalidated on pref change. */
let developerModeEnabled = loadPref<boolean>("developerMode", false);
window.addEventListener("owncord:pref-change", ((e: CustomEvent<{ key: string }>) => {
  if (e.detail.key === "developerMode") {
    developerModeEnabled = loadPref<boolean>("developerMode", false);
  }
}) as EventListener);

/** Controls a keyboard user can land on inside a rendered row. */
export const ROW_FOCUSABLE_SELECTOR = "button, [tabindex='0'], a[href]";

/** One action: offered at all, and if so whether it can be used right now. */
export interface ActionGate {
  readonly shown: boolean;
  readonly disabled: boolean;
  /** Why it is disabled (offline, timed out, channel locked); null when usable. */
  readonly reason: string | null;
}

export interface MessageActionGates {
  readonly react: ActionGate;
  readonly edit: ActionGate;
  readonly pin: ActionGate;
  readonly delete: ActionGate;
  readonly report: ActionGate;
  readonly copyId: ActionGate;
}

/** The delete lock for the connection as it is right now (null when usable). */
export const deleteLockReason = (): string | null =>
  connectionLockReason(uiStore.getState().connectionStatus);

const gate = (shown: boolean, reason: string | null = null): ActionGate => ({
  shown,
  disabled: reason !== null,
  reason,
});

/** Why a socket-bound action is unusable for this connection status. */
export function connectionLockReason(
  status: "connected" | "reconnecting" | "disconnected",
): string | null {
  if (status === "connected") return null;
  return shellText(status === "reconnecting" ? "channel.reconnecting" : "channel.notConnected");
}

/** Reply, copy link and the rest are unconditional on a sent row, so they have
 *  no gate; a row that is not a confirmed server message offers nothing at all. */
export function isActionableMessage(msg: Message): boolean {
  return !msg.deleted && msg.status === "sent" && msg.user.id !== 0;
}

export function messageActionGates(msg: Message, opts: MessageListOptions): MessageActionGates {
  const on = isActionableMessage(msg);
  const own = msg.user.id === opts.currentUserId;
  const channel = channelsStore.getState().channels.get(msg.channelId);
  const isDm = opts.channelType === "dm";
  // The server gates SetMessagePinned on MANAGE_MESSAGES for a channel, but any
  // DM participant may pin, so offering it to a plain member is a broken
  // affordance. In a channel it follows the server's per-channel verdict (an
  // override can grant or deny it), falling back to the role on an older server.
  const canPin = isDm || channelBitOrRole(channel?.canPin);
  // Own message (always), or someone else's where the channel allows it. A DM
  // never lets anyone delete the other participant's messages.
  const canDelete = on && (own || (!isDm && channelBitOrRole(channel?.canDeleteOthers)));
  return {
    react: gate(on, on ? reactionLockReason(channelCanReact(msg.channelId)) : null),
    edit: gate(on && own),
    pin: gate(on && canPin),
    delete: gate(canDelete, canDelete ? deleteLockReason() : null),
    report: gate(on && opts.onReportClick !== undefined && !own),
    copyId: gate(on && developerModeEnabled),
  };
}

type MessagingKey = Parameters<typeof messagingText>[0];

/** Copy `text`, then say whether it worked: a copy with no feedback is
 *  indistinguishable from a clipboard that refused. */
export function copyWithToast(text: string, done: MessagingKey, failed: MessagingKey): void {
  void navigator.clipboard.writeText(text).then(
    () => showToast(messagingText(done), "success"),
    () => showToast(messagingText(failed), "error"),
  );
}

/** Copy the message's permalink, with the usual toasts. */
export function copyMessageLink(msg: Message): void {
  copyWithToast(
    formatMessageLink(msg.channelId, msg.id),
    "toast.linkCopied",
    "toast.linkCopyFailed",
  );
}

/** The message as the store holds it now; undefined once it is gone. */
export function findMessage(channelId: number, id: number): Message | undefined {
  return getChannelMessages(channelId).find((m) => m.id === id);
}
