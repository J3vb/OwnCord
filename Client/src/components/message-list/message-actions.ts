/**
 * Which actions a message offers, decided once for every surface that lists
 * them: the hover action bar (renderers.ts) and the right-click menu
 * (message-menu.ts). Pure over the stores, so the two cannot drift.
 */

import { copyWithToast, isDeveloperMode } from "../../features/developer-mode/developerTools";
import { channelBitOrRole } from "@lib/permissions";
import { threadsEnabled } from "@lib/serverCapabilities";
import { authorityChannelId, threadOfMessage } from "@stores/threads.store";
import { isPinRowKind, isServerRowKind, isWelcomeRowKind } from "@lib/text/messageKind";
import { formatMessageLink } from "@lib/deep-link";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { getChannelMessages, type Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { shellText } from "../../i18n/shell";
import { channelCanReact, reactionLockReason } from "./reactions";

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
  readonly forward: ActionGate;
  readonly createThread: ActionGate;
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
  return !msg.deleted && msg.status === "sent";
}

/**
 * Whether Create Thread is offered: the server supports threads, the list is a
 * text channel's own (not a DM, voice or announcement channel, and not another
 * thread), the user may post there, and the message has no thread yet. The
 * server decides again; this keeps a dead affordance off the screen.
 */
function createThreadAllowed(msg: Message, opts: MessageListOptions): boolean {
  if (!threadsEnabled() || opts.channelType !== "text") return false;
  const channel = channelsStore.getState().channels.get(msg.channelId);
  return channel?.type === "text" && channel.canSend && threadOfMessage(msg) === undefined;
}

export function messageActionGates(msg: Message, opts: MessageListOptions): MessageActionGates {
  const sent = isActionableMessage(msg);
  // A server row (call log, group event) is read-only: only Copy ID (developer mode) applies.
  // A pin row and a welcome row additionally offer Delete under the ordinary rule (the server accepts it).
  const on = sent && !isServerRowKind(msg.kind);
  const deletable = on || (sent && (isPinRowKind(msg.kind) || isWelcomeRowKind(msg.kind)));
  const own = msg.user.id === opts.currentUserId;
  // A thread has no roles or overrides of its own: its parent answers.
  const channel = channelsStore.getState().channels.get(authorityChannelId(msg.channelId));
  const isDm = opts.channelType === "dm";
  // The server gates SetMessagePinned on MANAGE_MESSAGES for a channel, but any
  // DM participant may pin, so offering it to a plain member is a broken
  // affordance. In a channel it follows the server's per-channel verdict (an
  // override can grant or deny it), falling back to the role on an older server.
  const canPin = isDm || channelBitOrRole(channel?.canPin);
  // Own message (always), or someone else's where the channel allows it. A DM
  // never lets anyone delete the other participant's messages.
  const canDelete = deletable && (own || (!isDm && channelBitOrRole(channel?.canDeleteOthers)));
  return {
    react: gate(on, on ? reactionLockReason(channelCanReact(msg.channelId)) : null),
    // A forward is a snapshot, a poll is what people voted on and a sticker has no text: the server refuses to edit any of them.
    edit: gate(
      on && own && msg.forward === undefined && msg.poll === undefined && msg.sticker === undefined,
    ),
    // A forward would copy only the poll's fallback text and drop the voting, so the server refuses it.
    // A sticker message cannot be forwarded either.
    forward: gate(
      on &&
        opts.onForwardClick !== undefined &&
        msg.poll === undefined &&
        msg.sticker === undefined,
      on ? deleteLockReason() : null,
    ),
    createThread: gate(
      on && opts.onCreateThreadClick !== undefined && createThreadAllowed(msg, opts),
      on ? deleteLockReason() : null,
    ),
    pin: gate(on && canPin),
    delete: gate(canDelete, canDelete ? deleteLockReason() : null),
    report: gate(on && opts.onReportClick !== undefined && !own),
    copyId: gate(sent && isDeveloperMode()),
  };
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
