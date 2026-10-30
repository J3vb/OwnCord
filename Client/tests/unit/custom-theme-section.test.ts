import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { showToast, pickSaveLocation, writeFile } = vi.hoisted(() => ({
  showToast: vi.fn(),
  pickSaveLocation: vi.fn<(name: string) => Promise<string | null>>(),
  writeFile: vi.fn<(path: string, data: Uint8Array) => Promise<void>>(),
}));

vi.mock("@lib/ui/toast", () => ({ showToast }));
vi.mock("../../src/platform/desktop", () => ({
  desktop: { fileSaver: { pickSaveLocation, writeFile } },
}));

import { expectConsole } from "../helpers/console";
import {
  buildCustomThemeSection,
  themeFileName,
} from "../../src/features/custom-themes/customThemeSection";
import {
  MAX_CUSTOM_THEMES,
  getActiveCustomThemeId,
  loadCustomThemes,
  saveCustomThemes,
  setActiveCustomTheme,
} from "../../src/features/custom-themes/customTheme";

function q<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el;
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  if (btn === undefined) throw new Error(`no button ${text}`);
  return btn;
}

function painted(): HTMLStyleElement | null {
  return document.getElementById("owncord-custom-theme") as HTMLStyleElement | null;
}

describe("custom theme section", () => {
  let owner: AbortController;
  let section: HTMLElement;

  function mount(): void {
    section = buildCustomThemeSection(owner.signal);
    document.body.appendChild(section);
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    owner = new AbortController();
  });

  afterEach(() => {
    owner.abort();
    section.remove();
    painted()?.remove();
    document
      .querySelectorAll("[data-testid='custom-theme-delete-dialog']")
      .forEach((d) => d.remove());
  });

  it("shows an empty list and creates a theme from the editor", () => {
    mount();
    expect(section.textContent).toContain("No custom themes yet.");
    buttonByText(section, "New theme").click();
    q<HTMLInputElement>(section, "[data-testid='custom-theme-name']").value = " Sunrise ";
    q<HTMLTextAreaElement>(section, "[data-testid='custom-theme-css']").value =
      ":root { --bg-primary: #222; }";
    q<HTMLButtonElement>(section, "[data-testid='custom-theme-save']").click();

    expect(loadCustomThemes()).toMatchObject([
      { name: "Sunrise", css: ":root { --bg-primary: #222; }" },
    ]);
    expect(section.querySelectorAll("[data-testid='custom-theme-row']")).toHaveLength(1);
    expect(q<HTMLElement>(section, ".custom-theme-editor").hidden).toBe(true);
  });

  it("refuses to save CSS that loads a file, and says which line", () => {
    mount();
    buttonByText(section, "New theme").click();
    q<HTMLInputElement>(section, "[data-testid='custom-theme-name']").value = "Bad";
    q<HTMLTextAreaElement>(section, "[data-testid='custom-theme-css']").value =
      ".a {}\nbody { background: url(https://example.com/x.png); }";
    q<HTMLButtonElement>(section, "[data-testid='custom-theme-save']").click();

    expect(loadCustomThemes()).toEqual([]);
    expect(q(section, "[data-testid='custom-theme-error']").textContent).toBe(
      "Line 2 uses url(. Themes cannot load outside files.",
    );
  });

  it("asks for a name", () => {
    mount();
    buttonByText(section, "New theme").click();
    q<HTMLButtonElement>(section, "[data-testid='custom-theme-save']").click();
    expect(q(section, "[data-testid='custom-theme-error']").textContent).toBe(
      "Give the theme a name.",
    );
  });

  it("will not bring back a theme deleted while it was open in the editor", () => {
    saveCustomThemes([{ id: "a1", name: "One", css: "" }]);
    mount();
    buttonByText(section, "Edit").click();
    saveCustomThemes([]);
    q<HTMLButtonElement>(section, "[data-testid='custom-theme-save']").click();
    expect(loadCustomThemes()).toEqual([]);
    expect(q(section, "[data-testid='custom-theme-error']").textContent).toBe(
      "This theme was deleted. Cancel and make a new one.",
    );
  });

  it("Use paints the theme and Turn off removes it", () => {
    saveCustomThemes([{ id: "a1", name: "One", css: ".x { color: red; }" }]);
    mount();
    buttonByText(section, "Use").click();
    expect(getActiveCustomThemeId()).toBe("a1");
    expect(painted()).not.toBeNull();
    expect(section.textContent).toContain("In use");

    buttonByText(section, "Turn off").click();
    expect(getActiveCustomThemeId()).toBeNull();
    expect(painted()).toBeNull();
  });

  it("re-paints the active theme when it is edited", () => {
    saveCustomThemes([{ id: "a1", name: "One", css: ".x { color: red; }" }]);
    setActiveCustomTheme("a1");
    mount();
    buttonByText(section, "Edit").click();
    q<HTMLTextAreaElement>(section, "[data-testid='custom-theme-css']").value =
      ".x { color: blue; }";
    q<HTMLButtonElement>(section, "[data-testid='custom-theme-save']").click();
    expect(painted()?.textContent).toContain("blue");
  });

  it("follows a change made outside the section (the escape shortcut)", () => {
    saveCustomThemes([{ id: "a1", name: "One", css: "" }]);
    setActiveCustomTheme("a1");
    mount();
    expect(section.textContent).toContain("In use");
    setActiveCustomTheme(null);
    expect(section.textContent).not.toContain("In use");
  });

  it("deletes after confirming and turns the theme off", () => {
    saveCustomThemes([{ id: "a1", name: "One", css: "" }]);
    setActiveCustomTheme("a1");
    mount();
    buttonByText(section, "Delete").click();
    q<HTMLButtonElement>(document, "[data-testid='custom-theme-delete-confirm']").click();
    expect(loadCustomThemes()).toEqual([]);
    expect(getActiveCustomThemeId()).toBeNull();
  });

  it("imports a .css file under its file name", async () => {
    mount();
    const input = q<HTMLInputElement>(section, "[data-testid='custom-theme-file']");
    const file = new File(["\ufeff.a { color: red; }"], "Night Owl.css", { type: "text/css" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(loadCustomThemes()).toHaveLength(1));
    expect(loadCustomThemes()[0]).toMatchObject({ name: "Night Owl", css: ".a { color: red; }" });
    expect(showToast).toHaveBeenCalledWith("Imported Night Owl", "success");
  });

  it("refuses an imported file that loads something", async () => {
    mount();
    const input = q<HTMLInputElement>(section, "[data-testid='custom-theme-file']");
    const file = new File(["@import 'https://x/t.css';"], "evil.css");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(loadCustomThemes()).toEqual([]);
    expect(showToast).toHaveBeenCalledWith(
      "Line 1 uses @import. Themes cannot load outside files.",
      "error",
    );
  });

  it("exports the CSS through the file saver", async () => {
    saveCustomThemes([{ id: "a1", name: "Night Owl!", css: ".a{}" }]);
    pickSaveLocation.mockResolvedValue("/tmp/night-owl.css");
    writeFile.mockResolvedValue();
    mount();
    buttonByText(section, "Export").click();
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalled());
    expect(pickSaveLocation).toHaveBeenCalledWith("night-owl.css");
    expect(new TextDecoder().decode(writeFile.mock.calls[0]?.[1])).toBe(".a{}");
  });

  it("shows a toast when the export fails", async () => {
    saveCustomThemes([{ id: "a1", name: "One", css: "" }]);
    pickSaveLocation.mockRejectedValue(new Error("denied"));
    mount();
    buttonByText(section, "Export").click();
    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Could not save the theme file", "error"),
    );
    expectConsole("error", "Export custom theme failed");
  });

  it("disables New and Import at the limit", () => {
    saveCustomThemes(
      Array.from({ length: MAX_CUSTOM_THEMES }, (_, i) => ({
        id: `t${i}`,
        name: `T${i}`,
        css: "",
      })),
    );
    mount();
    expect(buttonByText(section, "New theme").disabled).toBe(true);
    expect(buttonByText(section, "Import .css").disabled).toBe(true);
  });
});

describe("themeFileName", () => {
  it("makes a safe file name", () => {
    expect(themeFileName("Night Owl!")).toBe("night-owl.css");
    expect(themeFileName("../../etc")).toBe("etc.css");
    expect(themeFileName("☀️")).toBe("theme.css");
  });
});
