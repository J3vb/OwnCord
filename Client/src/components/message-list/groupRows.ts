// Group DM system rows: "A added B to the group", "A left the group",
// and the rename / icon lines. The wording is built from `kind` + `groupEvent`
// alone, never from `content` (the server's English fallback sentence), and the
// names come from live stores so a rename of a member shows up on re-render.
import { dmStore } from "@stores/dm.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import type { Message } from "@stores/messages.store";
import { resolveDisplayName } from "@lib/avatar";
import { resolveAuthor } from "@lib/text/formatting";
import { ChatMessageKind } from "@lib/protocolTypes";
import { messagingText } from "../../i18n/messaging";

/** The group kinds this client draws; any other kind falls back to system text. */
export function isGroupRowKind(kind: string | undefined): boolean {
  return (
    kind === ChatMessageKind.GROUP_ADD ||
    kind === ChatMessageKind.GROUP_REMOVE ||
    kind === ChatMessageKind.GROUP_LEAVE ||
    kind === ChatMessageKind.GROUP_RENAME ||
    kind === ChatMessageKind.GROUP_ICON
  );
}

/** A user's name for a group row: the viewer is "You", then the DM's own
 *  participants, then the server member list, else "Unknown user". */
function targetName(channelId: number, userId: number | undefined, viewerId: number): string {
  if (userId === undefined) return messagingText("group.unknownUser");
  if (userId === viewerId) return messagingText("group.you");
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  const participant = dm?.participants.find((u) => u.id === userId);
  if (participant !== undefined) return resolveDisplayName(participant);
  const member = membersStore.getState().members.get(userId);
  if (member !== undefined) return memberDisplayName(member);
  return messagingText("group.unknownUser");
}

/**
 * The sentence for a group row, or null when `msg.kind` is not one of the five
 * group kinds (the caller then falls back to the system-text rendering).
 */
export function groupRowText(msg: Message, viewerId: number): string | null {
  if (!isGroupRowKind(msg.kind)) return null;
  const event = msg.groupEvent;
  const author =
    msg.user.id === viewerId
      ? messagingText("group.you")
      : resolveDisplayName(resolveAuthor(msg.user));
  switch (msg.kind) {
    case ChatMessageKind.GROUP_ADD:
      return messagingText("group.add", {
        author,
        target: targetName(msg.channelId, event?.target_user_id, viewerId),
      });
    case ChatMessageKind.GROUP_REMOVE:
      return messagingText("group.remove", {
        author,
        target: targetName(msg.channelId, event?.target_user_id, viewerId),
      });
    case ChatMessageKind.GROUP_LEAVE:
      return messagingText("group.leave", { author });
    case ChatMessageKind.GROUP_RENAME: {
      const name = event?.name ?? "";
      return name === ""
        ? messagingText("group.renameCleared", { author })
        : messagingText("group.rename", { author, name });
    }
    case ChatMessageKind.GROUP_ICON:
      return event?.icon_removed === true
        ? messagingText("group.iconRemoved", { author })
        : messagingText("group.icon", { author });
    default:
      return null;
  }
}

/** The icon a group row leads with. */
export function groupRowIcon(
  kind: string | undefined,
): "user-plus" | "x" | "log-out" | "pencil" | "image" {
  switch (kind) {
    case ChatMessageKind.GROUP_ADD:
      return "user-plus";
    case ChatMessageKind.GROUP_REMOVE:
      return "x";
    case ChatMessageKind.GROUP_LEAVE:
      return "log-out";
    case ChatMessageKind.GROUP_RENAME:
      return "pencil";
    default:
      return "image";
  }
}
