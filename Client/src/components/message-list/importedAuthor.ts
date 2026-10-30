// DOM for an imported message's author: a letter avatar, a plain-text name
// and an "Imported" tag. None of it is a control: an imported author has no
// profile to open, no one to mention and no one to message.
import { createElement } from "@lib/dom";
import { readableRoleColor } from "@lib/prefs/themes";
import type { ImportedAuthor } from "@lib/types";
import {
  importedColor,
  importedName,
  importedSubject,
} from "../../features/messaging/importedAuthor";
import { messagingText } from "../../i18n/messaging";
import { createAvatarElement, pickAvatarColor } from "./avatar";

/** The name as drawn: the export's, or a stand-in when it is blank. */
export function importedDisplayName(author: ImportedAuthor): string {
  const name = importedName(author);
  return name === "" ? messagingText("imported.unknownName") : name;
}

/** Letter avatar from the first character of the name, never a picture. */
export function createImportedAvatar(author: ImportedAuthor, className: string): HTMLDivElement {
  const subject = importedSubject(author, messagingText("imported.unknownName"));
  return createAvatarElement(subject, {
    className,
    background: pickAvatarColor(subject.username),
    decorative: true,
  });
}

/**
 * The name, as text. It carries the export's colour only when that is a valid
 * `#rrggbb`, clamped to stay readable on the theme; otherwise the surface's
 * default colour applies.
 */
export function createImportedName(author: ImportedAuthor, className: string): HTMLSpanElement {
  const text = importedDisplayName(author);
  const name = createElement("span", { class: `${className} imported-name`, title: text });
  name.textContent = text;
  const color = importedColor(author);
  if (color !== undefined) {
    name.dataset["roleColor"] = color;
    name.style.color = readableRoleColor(color);
  }
  return name;
}

/** The small "Imported" label shown beside the name. */
export function createImportedTag(): HTMLSpanElement {
  const tag = createElement("span", {
    class: "imported-tag",
    title: messagingText("imported.tagTitle"),
  });
  tag.textContent = messagingText("imported.tag");
  return tag;
}
