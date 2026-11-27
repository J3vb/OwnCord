import { voiceText as t } from "../../../i18n/voice";

/** The moderator-imposed state as a sentence, or "" when there is none. */
export function moderationText(serverMuted: boolean, serverDeafened: boolean): string {
  if (serverMuted && serverDeafened) return t("widget.moderatedMutedDeafened");
  if (serverMuted) return t("widget.mutedByModerator");
  if (serverDeafened) return t("widget.deafenedByModerator");
  return "";
}
