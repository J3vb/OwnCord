import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTextImagesTab } from "../../../../src/features/settings/TextImagesTab";
import { SETTINGS_SEARCH_INDEX } from "../../../../src/features/settings/settingsSearch";
import { loadPref } from "../../../../src/lib/prefs/preferences";
import { Disposable } from "../../../../src/lib/disposable";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../../helpers/androidHost";

let owner: Disposable;
beforeEach(() => {
  owner = new Disposable();
  hostAndroidApp();
});
afterEach(() => {
  owner.destroy();
  clearHost();
  localStorage.clear();
});

describe("Android data saver setting", () => {
  it("defaults to Off and persists each of the three choices", () => {
    const tab = buildTextImagesTab(owner.signal);
    const select = tab.querySelector<HTMLSelectElement>('select[aria-label="Data saver"]')!;
    expect([...select.options].map((option) => option.text)).toEqual([
      "Off",
      "On mobile data",
      "Always",
    ]);
    expect(select.value).toBe("off");
    for (const choice of ["mobile", "always", "off"]) {
      select.value = choice;
      select.dispatchEvent(new Event("change"));
      expect(loadPref("dataSaver", "")).toBe(choice);
      expect(
        buildTextImagesTab(owner.signal).querySelector<HTMLSelectElement>(
          'select[aria-label="Data saver"]',
        )?.value,
      ).toBe(choice);
    }
    expect(SETTINGS_SEARCH_INDEX["Text & Images"]()).toContain("Data saver");
  });

  it("omits both the row and its search entry on desktop", () => {
    hostDesktopApp();
    expect(
      buildTextImagesTab(owner.signal).querySelector('select[aria-label="Data saver"]'),
    ).toBeNull();
    expect(SETTINGS_SEARCH_INDEX["Text & Images"]()).not.toContain("Data saver");
  });
});
