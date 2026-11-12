/**
 * Registers how plain-text views name a `<@id>` / `<@&id>` token: OS
 * notifications, reply previews, the DM list, search snippets, previews.
 * Imported for its effect by the chat notifier (the lazy dispatcher chunk,
 * loaded before any message arrives) and by the pill renderer, so the names
 * are there before either can show a message, and the startup chunk does not
 * carry them.
 */
import { channelsStore } from "../../stores/channels.store";
import { memberDisplayName, membersStore } from "../../stores/members.store";
import { registerRoleMentionName, registerUserMentionName } from "@lib/text/mentionNames";

registerUserMentionName((id) => {
  const member = membersStore.getState().members.get(id);
  return member === undefined ? undefined : memberDisplayName(member);
});
registerRoleMentionName((id) => channelsStore.getState().roles.find((r) => r.id === id)?.name);
