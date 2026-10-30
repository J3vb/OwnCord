// How an imported message's author is shown. The export is untrusted: a name
// is only ever text, and a colour is used only when it is a plain #rrggbb.
import type { AvatarSubject } from "@lib/avatar";
import type { ImportedAuthor } from "@lib/types";

/** Longest name drawn, in code points; CSS clips what still overflows. */
export const IMPORTED_NAME_MAX = 80;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
// Control and bidi-override characters would reorder or hide the name.
const UNSAFE_CHARS = /[\p{Cc}‪-‮⁦-⁩]/gu;

/** The colour when it is a valid `#rrggbb`, else undefined (default colour). */
export function importedColor(author: ImportedAuthor): string | undefined {
  const color = author.color;
  return typeof color === "string" && HEX_COLOR.test(color) ? color : undefined;
}

/** The name to draw: control characters dropped, cut to IMPORTED_NAME_MAX with an ellipsis. */
export function importedName(author: ImportedAuthor): string {
  const clean = author.name.replace(UNSAFE_CHARS, "").trim();
  const points = Array.from(clean);
  return points.length > IMPORTED_NAME_MAX
    ? `${points.slice(0, IMPORTED_NAME_MAX - 1).join("")}…`
    : clean;
}

/** What the letter avatar is drawn from: the name, never a picture. */
export function importedSubject(author: ImportedAuthor, fallbackName: string): AvatarSubject {
  const name = importedName(author);
  return { username: name === "" ? fallbackName : name, avatar: null };
}

/** Stable key for the identity a row was drawn from, for in-place repaints. */
export function importedAuthorKey(author: ImportedAuthor): string {
  return ["imported", author.name, importedColor(author) ?? ""].join("\u0000");
}
