#!/usr/bin/env node
// Generates src/features/messaging/emojiData.ts — the Unicode emoji set the
// picker and the composer's `:` popup load as a lazy chunk — from Unicode's
// emoji-test.txt at a pinned version, checked against a pinned SHA-256.
//
// From Client/:
//   node scripts/gen-emoji-data.mjs
//
// Emoji 15.1 rather than the newest version: the app renders emoji with the
// OS font (Segoe UI Emoji, Noto Color Emoji), and an emoji newer than that
// font shows as a box. Bump EMOJI_VERSION and EMOJI_TEST_SHA256 together.
//
// Every fully-qualified emoji outside the Component group becomes one row,
// in Unicode order. Skin-tone variants are not rows: a row records which of
// its ZWJ segments take the modifier, and withSkinTone() in emojiCatalog.ts
// rebuilds the variant. The generator checks that rule against every uniform
// skin-tone sequence in the file and fails if one disagrees. Mixed-tone
// sequences (two people, two tones) are left out. It also fails if any
// sequence exceeds the server's reaction cap (maxReactionRunes,
// Server/service/message_reactions.go), so every row can be a reaction.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { EMOJI_ALIASES } from "./emoji-aliases.mjs";

const EMOJI_VERSION = "15.1";
const EMOJI_TEST_URL = `https://unicode.org/Public/emoji/${EMOJI_VERSION}/emoji-test.txt`;
const EMOJI_TEST_SHA256 = "d876ee249aa28eaa76cfa6dfaa702847a8d13b062aa488d465d0395ee8137ed9";
const OUT = new URL("../src/features/messaging/emojiData.ts", import.meta.url);
/** Server maxReactionRunes = MaxShortcodeLen (32) + 2. */
const MAX_REACTION_RUNES = 34;

const GROUP_KEYS = {
  "Smileys & Emotion": "smileys",
  "People & Body": "people",
  "Animals & Nature": "nature",
  "Food & Drink": "food",
  "Travel & Places": "travel",
  Activities: "activities",
  Objects: "objects",
  Symbols: "symbols",
  Flags: "flags",
};

const ZWJ = "‍";
const VS16 = "️";
const TONES = ["\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"];
const TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const HAS_TONE = /[\u{1F3FB}-\u{1F3FF}]/u;

/** Must match withSkinTone() in src/features/messaging/emojiCatalog.ts. */
function withSkinTone(char, segments, mod) {
  const segs = char.split(ZWJ);
  for (const i of segments) {
    const seg = segs[Number(i)];
    const first = String.fromCodePoint(seg.codePointAt(0));
    segs[Number(i)] = first + mod + seg.slice(first.length).replace(VS16, "");
  }
  return segs.join(ZWJ);
}

/** A Unicode name as a shortcode: "flag: Côte d’Ivoire" → "flag_cote_d_ivoire". */
function shortcode(name) {
  return name
    .replace("#", "number sign")
    .replace("*", "asterisk")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

const res = await fetch(EMOJI_TEST_URL);
if (!res.ok) throw new Error(`${EMOJI_TEST_URL}: HTTP ${res.status}`);
const text = await res.text();
const sha = createHash("sha256").update(text).digest("hex");
if (sha !== EMOJI_TEST_SHA256) {
  throw new Error(`${EMOJI_TEST_URL}: sha256 ${sha}, expected ${EMOJI_TEST_SHA256}`);
}

// --- parse ------------------------------------------------------------------
const rows = []; // { group, char, name }
/** An emoji with its skin tones and presentation selectors removed. */
const bare = (char) => char.replace(TONE_RE, "").replaceAll(VS16, "");
const tonedByBare = new Map(); // bare base -> its light-skin-tone variant
const allTonedChars = new Set();
let group = null;
for (const line of text.split("\n")) {
  const g = /^# group: (.+)$/.exec(line);
  if (g) {
    group = GROUP_KEYS[g[1]] ?? null;
    continue;
  }
  const m = /^[0-9A-F ]+;\s*fully-qualified\s*#\s*(\S+)\s+E\d+\.\d+\s+(.+)$/.exec(line);
  if (!m || group === null) continue;
  const [, char, name] = m;
  const tones = new Set(char.match(TONE_RE) ?? []);
  if (tones.size === 0) {
    rows.push({ group, char, name });
  } else if (tones.size === 1) {
    allTonedChars.add(char);
    if (tones.has(TONES[0])) tonedByBare.set(bare(char), char);
  }
}

// --- aliases ------------------------------------------------------------------
const aliasByBare = new Map(Object.entries(EMOJI_ALIASES).map(([k, v]) => [bare(k), v]));
const usedAliases = new Set();

// --- rows ---------------------------------------------------------------------
const byGroup = new Map(Object.values(GROUP_KEYS).map((k) => [k, []]));
let longest = { char: "", runes: 0 };
const checkCap = (char) => {
  const runes = [...char].length;
  if (runes > MAX_REACTION_RUNES) {
    throw new Error(`${char} is ${runes} runes, over the server's ${MAX_REACTION_RUNES}`);
  }
  if (runes > longest.runes) longest = { char, runes };
};
const verified = new Set();
for (const { group: key, char, name } of rows) {
  if (char.includes("|")) throw new Error(`${char}: '|' is the row separator`);
  let segments = "";
  const toned = tonedByBare.get(bare(char));
  if (toned !== undefined) {
    const parts = toned.split(ZWJ);
    segments = parts.flatMap((p, i) => (HAS_TONE.test(p) ? [String(i)] : [])).join("");
    for (const mod of TONES) {
      const variant = withSkinTone(char, segments, mod);
      if (!allTonedChars.has(variant)) {
        throw new Error(`${name}: rebuilt ${variant} is not in emoji-test.txt`);
      }
      verified.add(variant);
      checkCap(variant);
    }
  }
  checkCap(char);
  const code = shortcode(name);
  const alias = aliasByBare.get(bare(char));
  if (alias !== undefined) usedAliases.add(bare(char));
  const keywords =
    alias === undefined ? code : alias.split(" ").includes(code) ? alias : `${alias} ${code}`;
  byGroup.get(key).push(`${char}|${segments}|${keywords}`);
}

const unused = [...aliasByBare.keys()].filter((k) => !usedAliases.has(k));
if (unused.length > 0) throw new Error(`aliases match no emoji: ${unused.join(" ")}`);
const unrebuilt = [...allTonedChars].filter((c) => !verified.has(c));
if (unrebuilt.length > 0)
  throw new Error(`skin-tone sequences not rebuilt: ${unrebuilt.join(" ")}`);

// --- write ----------------------------------------------------------------------
const keys = Object.values(GROUP_KEYS);
// Laid out exactly as Prettier formats it, so the format gate passes as is.
let out = `// Generated by scripts/gen-emoji-data.mjs from Unicode emoji-test.txt ${EMOJI_VERSION}. Do not edit.
// Each row is \`emoji|skin-tone segments|keywords\`; the first keyword is the
// emoji's name. Loaded lazily through emojiCatalog.ts, never imported directly.

export const EMOJI_GROUPS: readonly (readonly [
  (
${keys.map((k) => `    | "${k}"`).join("\n")}
  ),
  string,
])[] = [\n`;
for (const key of keys)
  out += `  [\n    "${key}",\n    \`${byGroup.get(key).join("\n")}\`,\n  ],\n`;
out += "];\n";
writeFileSync(OUT, out);

const total = [...byGroup.values()].reduce((n, r) => n + r.length, 0);
console.log(`gen-emoji-data: ${total} emoji, ${verified.size} skin-tone variants`);
console.log(`gen-emoji-data: longest ${longest.char} at ${longest.runes} runes`);
