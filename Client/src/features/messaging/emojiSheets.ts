/**
 * The emoji picker's image sheets (scripts/gen-emoji-sheets.mjs): one picture
 * per catalog group, its emoji in catalog order eight to a row; a skin tone's
 * sheet is drawn in the app (toneSheets.ts). A grid shows its whole category from
 * one decoded image instead of hundreds of font glyphs; a cell finds its spot
 * from the emoji's index in the group.
 */

import { EMOJI_SHEETS } from "./emojiSheetsData";

/** Emoji per sheet row: the picker's own column count. */
export const SHEET_COLUMNS = 8;

/** The shipped sheet for `group`, without skin tones, or null when there is none. */
export function sheetUrl(group: string): string | null {
  return EMOJI_SHEETS[group] ?? null;
}

/** Point a category grid at its sheet; `count` is the group's full size. */
export function useSheet(grid: HTMLElement, url: string, count: number): void {
  grid.style.setProperty("--ep-sheet", `url("${url}")`);
  grid.style.setProperty("--ep-sheet-rows", String(Math.ceil(count / SHEET_COLUMNS)));
}

/** Show the emoji at `index` of a `count`-emoji group in its sheet cell. */
export function showSheetCell(cell: HTMLElement, index: number, count: number): void {
  const rows = Math.ceil(count / SHEET_COLUMNS);
  const col = index % SHEET_COLUMNS;
  const row = Math.floor(index / SHEET_COLUMNS);
  const x = (col / (SHEET_COLUMNS - 1)) * 100;
  const y = rows > 1 ? (row / (rows - 1)) * 100 : 0;
  cell.classList.add("ep-sheet");
  cell.style.backgroundPosition = `${x.toFixed(4)}% ${y.toFixed(4)}%`;
}
