import { isServerRowKind } from "@lib/text/messageKind";
import type { Message } from "@stores/messages.store";

/**
 * The newest message `userId` sent that can be edited from the keyboard
 * (ArrowUp in an empty composer). `messages` is chronological.
 *
 * Mirrors the gate on the visual Edit affordance: an optimistic row (pending or
 * failed) carries id 0 until the server acks it, so editing it would send an
 * edit for a message that does not exist yet. A server-written row (a DM call
 * log) is never editable, nor is a sticker message: it has no text.
 */
export function lastOwnEditable(messages: readonly Message[], userId: number): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (
      m.user.id === userId &&
      m.deleted !== true &&
      m.status === "sent" &&
      !isServerRowKind(m.kind) &&
      m.sticker === undefined
    ) {
      return m;
    }
  }
  return undefined;
}
