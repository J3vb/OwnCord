/** A Twemoji file name (without ".svg") or an emoji string, in the FE0F-free form. */
export function twemojiFileName(nameOrEmoji: string): string;

export const TWEMOJI_PACK_COUNT: number;

export function twemojiPacks(svgs: Map<string, string>): {
  starts: string[];
  packs: Record<string, string>[];
};
