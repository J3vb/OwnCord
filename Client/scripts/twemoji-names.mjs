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

/** How many files the SVGs are packed into (vite.config.ts, `twemojiAssets`). */
export const TWEMOJI_PACK_COUNT = 8;

/**
 * The SVGs grouped into TWEMOJI_PACK_COUNT packs of neighbouring names, so
 * tone variants and related emoji share a file and compress together. Each
 * pack maps a FE0F-free name to its SVG text; `starts` holds each pack's first
 * name, which is how the client finds the pack an emoji lives in.
 *
 * @param {Map<string, string>} svgs FE0F-free name -> SVG text
 * @returns {{ starts: string[], packs: Record<string, string>[] }}
 */
export function twemojiPacks(svgs) {
  const names = [...svgs.keys()].sort();
  const starts = [];
  const packs = [];
  for (let i = 0; i < TWEMOJI_PACK_COUNT; i++) {
    const slice = names.slice(
      Math.floor((i * names.length) / TWEMOJI_PACK_COUNT),
      Math.floor(((i + 1) * names.length) / TWEMOJI_PACK_COUNT),
    );
    starts.push(slice[0] ?? "");
    packs.push(Object.fromEntries(slice.map((name) => [name, svgs.get(name) ?? ""])));
  }
  return { starts, packs };
}
