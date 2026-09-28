/**
 * The shared answer to "what name and letter does this user render as".
 *
 * Pure identity helpers only. The DOM builder and the URL-renderability check
 * that need the authenticated image fetch live one layer up, in
 * `components/message-list/avatar.ts` — an earlier version kept them here and
 * imported that UI helper, which the ARCH-06 import-direction check forbids
 * (`lib/` must not reach `components/`).
 */

/** Everything the shared identity helpers need to know about the user. */
export interface AvatarSubject {
  readonly username: string;
  /** Nickname, when set. Used for the initial and the alt text, so a row shows
   *  the letter of the name the reader actually sees. */
  readonly displayName?: string | null;
  /** Avatar URL: a server-relative `/api/v1/files/{id}` or an https:// URL. */
  readonly avatar?: string | null;
  /** Renders as "?" on a neutral background and never fetches an image. */
  readonly isDeleted?: boolean;
}

/** The name to render for a user: display name when set, username otherwise. */
export function resolveDisplayName(subject: AvatarSubject): string {
  const display = subject.displayName;
  if (typeof display === "string" && display.trim().length > 0) return display;
  return subject.username;
}

/** The single letter a user with no avatar is drawn as. */
export function avatarInitial(subject: AvatarSubject): string {
  if (subject.isDeleted === true) return "?";
  return resolveDisplayName(subject).charAt(0).toUpperCase() || "?";
}
