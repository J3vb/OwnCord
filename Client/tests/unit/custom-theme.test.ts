import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_THEMES,
  MAX_THEME_CSS_CHARS,
  applyStoredCustomTheme,
  checkThemeCss,
  cleanThemeName,
  getActiveCustomThemeId,
  installCustomThemeEscape,
  loadCustomThemes,
  onCustomThemeChange,
  paintCustomTheme,
  saveCustomThemes,
  setActiveCustomTheme,
} from "@lib/customTheme";

const LIST_KEY = "owncord:theme:custom:list";
const ACTIVE_KEY = "owncord:theme:custom:active";

function painted(): HTMLStyleElement | null {
  return document.getElementById("owncord-custom-theme") as HTMLStyleElement | null;
}

describe("checkThemeCss", () => {
  it("accepts plain token and selector CSS", () => {
    expect(checkThemeCss(":root { --bg-primary: #101010; }\n.sidebar { color: red; }")).toBeNull();
    expect(checkThemeCss("")).toBeNull();
  });

  it.each([
    ["url(", "body { background: url(https://example.com/a.png); }"],
    ["url(", "body { background: URL('x.png'); }"],
    ["@import", '@import "https://example.com/t.css";'],
    ["@import", "@IMPORT 'x.css';"],
    ["image-set(", 'body { background: image-set("a.png" 1x); }'],
    ["image-set(", 'body { background: -webkit-image-set("a.png" 1x); }'],
    ["@font-face", "@font-face { font-family: x; src: local(Arial); }"],
    ["image(", 'body { background: image("a.png"); }'],
    ["cross-fade(", "body { background: cross-fade(50%, red); }"],
    ["src(", 'body { --x: src("a.png"); }'],
    ["@namespace", "@namespace svg 'http://www.w3.org/2000/svg';"],
  ])("refuses %s", (found, css) => {
    expect(checkThemeCss(css)).toMatchObject({ kind: "outsideLink", found });
  });

  it("decodes escapes before checking, so a disguised url( is refused", () => {
    expect(checkThemeCss("a { background: u\\72l(x.png); }")).toMatchObject({ found: "url(" });
    expect(checkThemeCss("a { background: \\75 rl(x.png); }")).toMatchObject({ found: "url(" });
    expect(checkThemeCss("a { background: \\000055RL(x.png); }")).toMatchObject({ found: "url(" });
    expect(checkThemeCss("\\@import 'x.css';")).toMatchObject({ found: "@import" });
    // A hex escape swallows one newline, and CR LF, CR and FF all count as one.
    expect(checkThemeCss("a { --x: u\\72\r\nl(x.png); }")).toMatchObject({ found: "url(" });
    expect(checkThemeCss("a { --x: u\\72\rl(x.png); }")).toMatchObject({ found: "url(" });
    expect(checkThemeCss("a { --x: u\\72\fl(x.png); }")).toMatchObject({ found: "url(" });
    expect(checkThemeCss("@im\\70\r\nort 'x.css';")).toMatchObject({ found: "@import" });
  });

  it("checks comments too, so a comment marker inside a string cannot hide a link", () => {
    const css = 'a { content: "/*"; } b { background: url(x.png); } c { content: "*/"; }';
    expect(checkThemeCss(css)).toMatchObject({ kind: "outsideLink", found: "url(" });
  });

  it("names the line the link is on", () => {
    expect(checkThemeCss(":root {}\n\nbody { background: url(x); }")).toEqual({
      kind: "outsideLink",
      found: "url(",
      line: 3,
    });
  });

  it("refuses a theme over the size limit", () => {
    expect(checkThemeCss("a".repeat(MAX_THEME_CSS_CHARS + 1))).toEqual({ kind: "tooBig" });
  });
});

describe("cleanThemeName", () => {
  it("trims, drops control characters and cuts to 40", () => {
    expect(cleanThemeName("  Sun\u0000rise\u200b ")).toBe("Sunrise\u200b");
    expect(cleanThemeName("x".repeat(60))).toHaveLength(40);
  });
});

describe("stored themes", () => {
  beforeEach(() => {
    localStorage.clear();
    painted()?.remove();
  });
  afterEach(() => painted()?.remove());

  it("round-trips the list", () => {
    const themes = [{ id: "a1", name: "One", css: ":root { --x: 1px; }" }];
    expect(saveCustomThemes(themes)).toBe(true);
    expect(loadCustomThemes()).toEqual(themes);
  });

  it("drops malformed entries and duplicate ids from a hand-edited list", () => {
    localStorage.setItem(
      LIST_KEY,
      JSON.stringify([
        { id: "ok", name: "Fine", css: "" },
        { id: "ok", name: "Duplicate", css: "" },
        { id: "BAD ID", name: "x", css: "" },
        { id: "n", name: 3, css: "" },
        { id: "e", name: "   ", css: "" },
        "junk",
        null,
      ]),
    );
    expect(loadCustomThemes()).toEqual([{ id: "ok", name: "Fine", css: "" }]);
  });

  it("reads a corrupt list as empty and caps a long one", () => {
    localStorage.setItem(LIST_KEY, "{not json");
    expect(loadCustomThemes()).toEqual([]);
    const many = Array.from({ length: MAX_CUSTOM_THEMES + 5 }, (_, i) => ({
      id: `t${i}`,
      name: `T${i}`,
      css: "",
    }));
    localStorage.setItem(LIST_KEY, JSON.stringify(many));
    expect(loadCustomThemes()).toHaveLength(MAX_CUSTOM_THEMES);
  });

  it("paints the active theme and removes it again", () => {
    saveCustomThemes([{ id: "a1", name: "One", css: ".x { color: red; }" }]);
    expect(setActiveCustomTheme("a1")).toBe(true);
    expect(localStorage.getItem(ACTIVE_KEY)).toBe("a1");
    expect(painted()?.textContent).toContain("color: red");
    expect(painted()?.hasAttribute("media")).toBe(false);

    expect(setActiveCustomTheme(null)).toBe(true);
    expect(painted()).toBeNull();
    expect(getActiveCustomThemeId()).toBeNull();
  });

  it("marks custom properties !important so they beat the built-in theme's inline tokens", () => {
    document.documentElement.style.setProperty("--bg-primary", "#313338");
    paintCustomTheme(":root { --bg-primary: #ff0000; }");
    expect(painted()?.textContent).toMatch(/--bg-primary:\s*#ff0000\s*!important/);
    expect(painted()?.textContent).toMatch(/^:root, body \{/);
    document.documentElement.style.removeProperty("--bg-primary");
  });

  it("at startup, never paints a stored theme that was edited to load a file", () => {
    localStorage.setItem(
      LIST_KEY,
      JSON.stringify([{ id: "evil", name: "Evil", css: "body { background: url(https://x) }" }]),
    );
    localStorage.setItem(ACTIVE_KEY, "evil");
    applyStoredCustomTheme();
    expect(painted()).toBeNull();
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it("at startup, clears an active id whose theme is gone", () => {
    localStorage.setItem(ACTIVE_KEY, "missing");
    applyStoredCustomTheme();
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
    expect(painted()).toBeNull();
  });

  it("replaces the painted theme rather than stacking a second one", () => {
    saveCustomThemes([
      { id: "a", name: "A", css: ".a { color: red; }" },
      { id: "b", name: "B", css: ".b { color: blue; }" },
    ]);
    setActiveCustomTheme("a");
    setActiveCustomTheme("b");
    expect(document.querySelectorAll("#owncord-custom-theme")).toHaveLength(1);
    expect(painted()?.textContent).toContain(".b");
  });

  it("tells listeners when the active theme changes", () => {
    const owner = new AbortController();
    let calls = 0;
    onCustomThemeChange(() => calls++, owner.signal);
    setActiveCustomTheme(null);
    owner.abort();
    setActiveCustomTheme(null);
    expect(calls).toBe(1);
  });
});

describe("installCustomThemeEscape", () => {
  let owner: AbortController;
  beforeEach(() => {
    localStorage.clear();
    owner = new AbortController();
    installCustomThemeEscape(owner.signal);
    saveCustomThemes([{ id: "a1", name: "One", css: "body { display: none; }" }]);
    setActiveCustomTheme("a1");
  });
  afterEach(() => {
    owner.abort();
    painted()?.remove();
  });

  it("Ctrl+Shift+Backspace turns the custom theme off", () => {
    const e = new KeyboardEvent("keydown", {
      code: "Backspace",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(painted()).toBeNull();
    expect(getActiveCustomThemeId()).toBeNull();
  });

  it("works even when a focused field stops the key", () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.addEventListener("keydown", (e) => e.stopPropagation());
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Backspace",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    field.remove();
    expect(painted()).toBeNull();
  });

  it("ignores Backspace without both modifiers", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Backspace", ctrlKey: true }));
    expect(getActiveCustomThemeId()).toBe("a1");
  });

  it("leaves the key alone when no custom theme is on", () => {
    setActiveCustomTheme(null);
    const e = new KeyboardEvent("keydown", {
      code: "Backspace",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
