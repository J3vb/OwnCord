import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMOJI_GROUPS } from "../../../../src/features/messaging/emojiData";
import {
  EMOJI_SHEETS,
  SHEETS_CATALOG_HASH,
} from "../../../../src/features/messaging/emojiSheetsData";
import {
  SHEET_COLUMNS,
  sheetUrl,
  showSheetCell,
  useSheet,
} from "../../../../src/features/messaging/emojiSheets";

describe("emoji sheets", () => {
  it("were drawn from the current catalog (re-run scripts/gen-emoji-sheets.mjs)", () => {
    const hash = createHash("sha256").update(JSON.stringify(EMOJI_GROUPS)).digest("hex");
    expect(SHEETS_CATALOG_HASH).toBe(hash.slice(0, 16));
  });

  it("cover every group, and every skin tone of a group with toneable emoji", () => {
    for (const [group, rows] of EMOJI_GROUPS) {
      expect(EMOJI_SHEETS[group], group).toBeDefined();
      const toneable = rows.split("\n").some((row) => row.split("|")[1] !== "");
      for (let tone = 1; tone <= 5; tone++) {
        expect(sheetUrl(group, tone)).toBe(
          toneable ? EMOJI_SHEETS[`${group}-${tone}`] : EMOJI_SHEETS[group],
        );
      }
    }
    expect(sheetUrl("nope", 0)).toBeNull();
  });

  it("place an emoji in its cell from its index", () => {
    const count = SHEET_COLUMNS * 5 - 3; // five rows, the last one short
    const at = (index: number): string => {
      const cell = document.createElement("span");
      showSheetCell(cell, index, count);
      expect(cell.classList.contains("ep-sheet")).toBe(true);
      return cell.style.backgroundPosition;
    };
    expect(at(0)).toBe("0% 0%");
    expect(at(SHEET_COLUMNS - 1)).toBe("100% 0%");
    expect(at(SHEET_COLUMNS * 4)).toBe("0% 100%");
    expect(at(SHEET_COLUMNS * 2 + 3)).toBe(`${((3 / 7) * 100).toFixed(4)}% 50%`);
  });

  it("put a one-row group at the top of its sheet", () => {
    const cell = document.createElement("span");
    showSheetCell(cell, 2, 3);
    expect(cell.style.backgroundPosition).toBe(`${((2 / 7) * 100).toFixed(4)}% 0%`);
  });

  it("give the grid its sheet and row count", () => {
    const grid = document.createElement("div");
    useSheet(grid, "/s.webp", SHEET_COLUMNS * 3 + 1);
    expect(grid.style.getPropertyValue("--ep-sheet")).toBe('url("/s.webp")');
    expect(grid.style.getPropertyValue("--ep-sheet-rows")).toBe("4");
  });
});
