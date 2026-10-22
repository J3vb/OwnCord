// channelTypes — channel-type labels and the topic ceiling shared by the create
// and edit dialogs. A leaf module so the always-loaded edit dialog does not
// pull in the create dialog, which loads on first use.

import type { ChannelType } from "@lib/types";
import { shellText } from "../i18n/shell";

/** The server's ceiling for a channel topic (`MaxChannelTopicLen`), mirrored for the field. */
export const MAX_CHANNEL_TOPIC_LENGTH = 1024;

const CHANNEL_TYPE_LABELS = {
  text: "channel.type.text",
  voice: "channel.type.voice",
  announcement: "channel.type.announcement",
  forum: "channel.type.forum",
  dm: "channel.type.dm",
} as const;

/** The display name of a channel type; an unrecognised wire value is shown capitalised. */
export function channelTypeLabel(type: string): string {
  return Object.hasOwn(CHANNEL_TYPE_LABELS, type)
    ? shellText(CHANNEL_TYPE_LABELS[type as ChannelType])
    : type.charAt(0).toUpperCase() + type.slice(1);
}
