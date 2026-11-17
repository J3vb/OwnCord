/**
 * Plain-text names for `<@id>` and `<@&id>` mention tokens, for the views that
 * show a message as text rather than as rendered pills: OS notifications,
 * reply previews, the DM list and search snippets.
 *
 * A leaf on purpose, like presence/roleLookup: the markdown flattener sits
 * below the stores, so the members and channels stores register how an id is
 * named when they load.
 */

type NameOf = (id: number) => string | undefined;

let userName: NameOf = () => undefined;
let roleName: NameOf = () => undefined;

/** Register how a user id is named (the member's shown name). */
export function registerUserMentionName(next: NameOf): void {
  userName = next;
}

/** Register how a role id is named. */
export function registerRoleMentionName(next: NameOf): void {
  roleName = next;
}

const ID_TOKEN = /<@(&?)(\d{1,15})>/g;
/** A token cut short at the end of a server-truncated preview. */
const CUT_TOKEN = /<@&?\d*$/;

/** `text` with each token the client can name shown as `@name`; the rest stay raw. */
export function idMentionsToNames(text: string): string {
  if (!text.includes("<@")) return text;
  return text.replace(ID_TOKEN, (raw, role: string, digits: string) => {
    const id = Number(digits);
    const name = role === "" ? userName(id) : roleName(id);
    return name === undefined ? raw : `@${name}`;
  });
}

/** Like idMentionsToNames, for a preview the server cut to length: a token cut in half is dropped. */
export function previewMentionsToNames(text: string): string {
  return idMentionsToNames(text).replace(CUT_TOKEN, "");
}
