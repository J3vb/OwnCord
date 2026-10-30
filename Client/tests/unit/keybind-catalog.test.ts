import { describe, it, expect } from "vitest";
import { KEYBIND_GROUPS } from "../../src/lib/prefs/keybindCatalog";
import { settingsText as t } from "../../src/i18n/settings";

describe("keybind catalog", () => {
  it("lists Navigation, Communication, Messages in that order", () => {
    expect(KEYBIND_GROUPS.map((g) => g.id)).toEqual(["navigation", "communication", "messages"]);
    expect(KEYBIND_GROUPS.map((g) => t(g.title))).toEqual([
      "Navigation",
      "Communication",
      "Messages",
    ]);
  });

  it("resolves every action and combo key to real text", () => {
    for (const group of KEYBIND_GROUPS) {
      expect(group.rows.length).toBeGreaterThan(0);
      for (const row of group.rows) {
        for (const key of [row.action, row.combo]) {
          const text = t(key);
          expect(text.length, key).toBeGreaterThan(0);
          // An unknown key echoes back as "settings.<key>".
          expect(text, key).not.toBe(`settings.${key}`);
        }
      }
    }
  });

  it("has the Ctrl + / row in Navigation, after Open Settings", () => {
    const nav = KEYBIND_GROUPS[0]!.rows.map((r) => `${t(r.action)}|${t(r.combo)}`);
    const settings = nav.indexOf("Open Settings|Ctrl + ,");
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(nav[settings + 1]).toBe("Show Keyboard Shortcuts|Ctrl + /");
  });

  it("keeps the fixed rows the Keybinds tab has always shown", () => {
    const rows = KEYBIND_GROUPS.flatMap((g) => g.rows.map((r) => `${t(r.action)}|${t(r.combo)}`));
    expect(rows).toContain("Quick Switcher|Ctrl + K");
    expect(rows).toContain("Toggle Camera|Ctrl + Shift + V");
    expect(rows).toContain("Underline|Ctrl + U");
    expect(rows).toHaveLength(18);
  });
});
