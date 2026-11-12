// The one file-naming rule for Twemoji images, shared by the sheet generator
// and the build step that copies the SVGs. The client's own copy is
// twemojiName() in src/features/messaging/emojiImage.ts; twemojiNames.test.ts
// keeps the two in step.
//
// Twemoji names a file by its code points in hex, joined by "-", keeping U+FE0F
// in some ZWJ sequences and dropping it elsewhere. Dropping every U+FE0F gives
// one name per emoji whichever way it was typed (no two Twemoji files collide
// that way), so the copied files are renamed to that form.

/** A file name (without ".svg") or an emoji string, in the FE0F-free form. */
export function twemojiFileName(nameOrEmoji) {
  if (/^[0-9a-f]+(-[0-9a-f]+)*$/.test(nameOrEmoji)) {
    return nameOrEmoji
      .split("-")
      .filter((cp) => cp !== "fe0f")
      .join("-");
  }
  return [...nameOrEmoji]
    .map((c) => c.codePointAt(0) ?? 0)
    .filter((cp) => cp !== 0xfe0f)
    .map((cp) => cp.toString(16))
    .join("-");
}
