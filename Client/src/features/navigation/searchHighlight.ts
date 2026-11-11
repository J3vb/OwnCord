// Search result text: the terms to highlight for a query, the plain-text preview
// windowed around the first hit, and the <mark> wrapping.
import { createElement, setText } from "@lib/dom";
import { markdownToPlainText } from "@lib/text/markdown";

/** Filter keys the server parses out of `q` (service.ParseSearch). */
const FILTER_KEYS = new Set([
  "from",
  "in",
  "before",
  "after",
  "during",
  "has",
  "mentions",
  "pinned",
]);
/** A preview whose first hit lies beyond this many chars is windowed around it. */
const WINDOW_LEAD = 60;
const PREVIEW_MAX = 200;
const MIN_TERM_LEN = 2;

/**
 * The words to highlight for a query: whitespace-split, `key:value` filter
 * tokens (including a quoted value that holds spaces) dropped, quotes removed,
 * then every remaining token split on non letter/digit/mark characters (the
 * server's sanitizeFTSQuery turns those into separators) and terms under 2
 * chars ignored. Mirrors the server's lexSearch.
 */
export function highlightTerms(query: string): string[] {
  const terms: string[] = [];
  const n = query.length;
  let i = 0;
  while (i < n) {
    if (/\s/.test(query[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(query[j]!)) j++;
    const token = query.slice(i, j);
    const colon = token.indexOf(":");
    if (colon > 0 && FILTER_KEYS.has(token.slice(0, colon).toLowerCase())) {
      // A quoted filter value runs to the next quote, spaces included.
      if (token[colon + 1] === '"') {
        const close = query.indexOf('"', i + colon + 2);
        j = close === -1 ? n : close + 1;
      }
    } else {
      for (const part of token.replace(/"/g, "").split(/[^\p{L}\p{N}\p{M}]+/u)) {
        if (Array.from(part).length >= MIN_TERM_LEN) terms.push(part);
      }
    }
    i = j;
  }
  return terms;
}

/**
 * One case-insensitive regex over the terms (longest first so the longer of
 * two overlapping terms wins), or null when there is nothing to match. It runs
 * on the original text, so offsets never drift the way a lowercased copy can
 * ("İ" lowercases to two units), and the `u` flag keeps surrogate pairs whole.
 */
function termRegex(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  const alts = terms
    .toSorted((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(alts.join("|"), "giu");
}

const isLowSurrogate = (text: string, at: number): boolean => {
  const c = text.charCodeAt(at);
  return c >= 0xdc00 && c <= 0xdfff;
};

/** Plain-text preview: markdown stripped, windowed around the first hit, capped. */
export function buildPreview(raw: string, terms: readonly string[], spoilerLabel: string): string {
  const plain = markdownToPlainText(raw, spoilerLabel);
  const re = termRegex(terms);
  const hit = re === null ? null : re.exec(plain);
  let start = 0;
  if (hit !== null && hit.index > WINDOW_LEAD) start = hit.index - WINDOW_LEAD;
  // Never cut through a surrogate pair: step back so the pair stays whole at
  // the start, and stop before its high half at the end.
  if (start > 0 && isLowSurrogate(plain, start)) start--;
  let end = start + PREVIEW_MAX;
  if (end < plain.length && isLowSurrogate(plain, end)) end--;
  return (
    (start > 0 ? "\u2026" : "") + plain.slice(start, end) + (end < plain.length ? "\u2026" : "")
  );
}

/** Fill `el` with `text`, each case-insensitive term hit wrapped in a <mark>. */
export function fillHighlighted(el: HTMLElement, text: string, terms: readonly string[]): void {
  const re = termRegex(terms);
  let pos = 0;
  if (re !== null) {
    for (const m of text.matchAll(re)) {
      if (m[0] === "") continue;
      if (m.index > pos) el.appendChild(document.createTextNode(text.slice(pos, m.index)));
      const mark = createElement("mark", { class: "search-hit" });
      setText(mark, m[0]);
      el.appendChild(mark);
      pos = m.index + m[0].length;
    }
  }
  if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
}
