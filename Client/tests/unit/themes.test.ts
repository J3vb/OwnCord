import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  applyAccent,
  applyTheme,
  applyThemeByName,
  applyThemeChoice,
  getActiveThemeName,
  onSystemThemePainted,
  readableRoleColor,
  resolveSystemTheme,
  restoreTheme,
} from "@lib/prefs/themes";

describe("themes", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
  });

  it("applies neon-glow theme class to body", () => {
    applyThemeByName("neon-glow");
    expect(document.body.classList.contains("theme-neon-glow")).toBe(true);
  });

  it("removes previous theme class when switching", () => {
    applyThemeByName("neon-glow");
    applyThemeByName("dark");
    expect(document.body.classList.contains("theme-neon-glow")).toBe(false);
    expect(document.body.classList.contains("theme-dark")).toBe(true);
  });

  it("persists active theme name", () => {
    applyThemeByName("neon-glow");
    expect(getActiveThemeName()).toBe("neon-glow");
  });

  it("migrates the legacy settings theme key to the active theme key", () => {
    localStorage.setItem("owncord:settings:theme", JSON.stringify("midnight"));

    expect(getActiveThemeName()).toBe("midnight");
    expect(localStorage.getItem("owncord:theme:active")).toBe("midnight");
  });

  it("ignores an invalid active theme when a valid legacy theme exists", () => {
    localStorage.setItem("owncord:theme:active", "stale-theme");
    localStorage.setItem("owncord:settings:theme", JSON.stringify("midnight"));

    expect(getActiveThemeName()).toBe("midnight");
    expect(localStorage.getItem("owncord:theme:active")).toBe("midnight");
  });
});

describe("restoreTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
    for (let i = document.body.style.length - 1; i >= 0; i--) {
      document.body.style.removeProperty(document.body.style.item(i));
    }
    for (let i = document.documentElement.style.length - 1; i >= 0; i--) {
      document.documentElement.style.removeProperty(document.documentElement.style.item(i));
    }
  });

  it("should apply saved theme name from localStorage", () => {
    localStorage.setItem("owncord:theme:active", "midnight");
    restoreTheme();
    expect(document.body.classList.contains("theme-midnight")).toBe(true);
  });

  it("should apply saved accent color on document", () => {
    localStorage.setItem("owncord:settings:accentColor", JSON.stringify("#00ff00"));
    restoreTheme();
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#00ff00");
    expect(document.body.style.getPropertyValue("--accent")).toBe("#00ff00");
  });

  it("should reject accent color that is not valid hex", () => {
    localStorage.setItem("owncord:settings:accentColor", JSON.stringify("url(evil)"));
    restoreTheme();
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("should handle corrupted localStorage gracefully", () => {
    localStorage.setItem("owncord:settings:accentColor", "NOT VALID JSON {{{");
    // Should not throw
    expect(() => restoreTheme()).not.toThrow();
    // No accent should be set
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("should default to neon-glow when no saved theme", () => {
    restoreTheme();
    expect(document.body.classList.contains("theme-neon-glow")).toBe(true);
  });
});

describe("applyAccent", () => {
  const html = document.documentElement.style;
  const body = document.body.style;

  function clearInline(): void {
    for (const style of [html, body]) {
      for (let i = style.length - 1; i >= 0; i--) style.removeProperty(style.item(i));
    }
  }

  /** The dark theme's surfaces, as inline tokens the contrast check reads back. */
  function setDarkSurfaces(): void {
    body.setProperty("--bg-primary", "#313338");
    body.setProperty("--bg-secondary", "#2b2d31");
    body.setProperty("--bg-tertiary", "#1e1f22");
    body.setProperty("--bg-input", "#383a40");
  }

  beforeEach(clearInline);

  it("honours a readable accent for fills, text and focus, and derives the rest", () => {
    setDarkSurfaces();
    applyAccent("#3ba55d");
    for (const style of [html, body]) {
      expect(style.getPropertyValue("--accent")).toBe("#3ba55d");
      expect(style.getPropertyValue("--on-accent")).toBe("#000000");
      expect(style.getPropertyValue("--accent-hover")).toBe("#58b375");
      expect(style.getPropertyValue("--accent-active")).toBe("#76c08e");
    }
    // 3.64:1 at worst: a focus ring (>= 3:1) but not text (< 4.5:1).
    expect(body.getPropertyValue("--accent-text")).toBe("");
    expect(body.getPropertyValue("--focus-ring")).toBe("#3ba55d");

    applyAccent("#57f287"); // 7.3:1 at worst: both uses
    expect(body.getPropertyValue("--accent-text")).toBe("#57f287");
    expect(body.getPropertyValue("--focus-ring")).toBe("#57f287");
  });

  it("keeps the theme's text and focus colours when the accent reads below 3:1", () => {
    setDarkSurfaces();
    // A tested theme value on documentElement (the light theme writes one there).
    html.setProperty("--accent-text", "#4752c4");
    applyAccent("#57f287");
    applyAccent("#5865f2"); // 2.74:1 on #313338
    expect(body.getPropertyValue("--accent")).toBe("#5865f2");
    expect(body.getPropertyValue("--accent-text")).toBe("");
    expect(body.getPropertyValue("--focus-ring")).toBe("");
    expect(html.getPropertyValue("--accent-text")).toBe("#4752c4");
  });

  it("falls back for text and focus when the surfaces cannot be read", () => {
    applyAccent("#ffffff");
    expect(body.getPropertyValue("--accent")).toBe("#ffffff");
    expect(body.getPropertyValue("--accent-text")).toBe("");
  });

  it("applies nothing for a value that is not a colour", () => {
    applyAccent("url(evil)");
    expect(html.length).toBe(0);
    expect(body.length).toBe(0);
  });
});

describe("readableRoleColor (B9 Q13 role clamp)", () => {
  const html = document.documentElement.style;

  function setSurfaces(surfaces: readonly [string, string, string, string]): void {
    for (const [i, token] of [
      "--bg-primary",
      "--bg-secondary",
      "--bg-tertiary",
      "--bg-input",
    ].entries()) {
      html.setProperty(token, surfaces[i]!);
    }
    // A theme switch is what re-reads the surfaces and empties the cache.
    applyThemeByName("dark");
  }
  const DARK = ["#313338", "#2b2d31", "#1e1f22", "#383a40"] as const;
  const LIGHT = ["#ffffff", "#f2f3f5", "#e3e5e8", "#ebedef"] as const;

  beforeEach(() => {
    document.body.replaceChildren();
    for (let i = html.length - 1; i >= 0; i--) html.removeProperty(html.item(i));
  });

  it("keeps a role colour that reads at 4.5:1 on every surface", () => {
    setSurfaces(DARK);
    expect(readableRoleColor("#57f287")).toBe("#57f287");
    expect(readableRoleColor("rgb(87, 242, 135)")).toBe("#57f287");
  });

  it("falls back to --text-normal below 4.5:1, like --accent-text", () => {
    setSurfaces(LIGHT);
    expect(readableRoleColor("#ff0000")).toBe("var(--text-normal)"); // 4.00:1 on white
    expect(readableRoleColor("#57f287")).toBe("var(--text-normal)");
    setSurfaces(DARK);
    expect(readableRoleColor("#ff0000")).toBe("var(--text-normal)"); // 2.9:1 on #383a40
  });

  it("never hands back the raw server string", () => {
    setSurfaces(DARK);
    const out = readableRoleColor("#57f287; background: url(https://example.invalid/x)");
    expect(out).toMatch(/^(#[0-9a-f]{6}|var\(--text-normal\))$/);
  });

  it("re-clamps rendered names when the theme changes", () => {
    setSurfaces(DARK);
    const name = document.createElement("span");
    name.dataset["roleColor"] = "#57f287";
    name.style.color = readableRoleColor("#57f287");
    document.body.appendChild(name);
    expect(name.style.color).toBe("rgb(87, 242, 135)");

    setSurfaces(LIGHT);
    expect(name.style.color).toBe("var(--text-normal)");
    setSurfaces(DARK);
    expect(name.style.color).toBe("rgb(87, 242, 135)");
  });
});

describe("system theme", () => {
  let matches = true;
  let listeners: Array<() => void> = [];
  let removed = 0;

  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
    matches = true;
    listeners = [];
    removed = 0;
    vi.stubGlobal("matchMedia", (media: string) => ({
      get matches() {
        return matches;
      },
      media,
      addEventListener: (_t: string, fn: () => void, opts?: { signal?: AbortSignal }) => {
        listeners.push(fn);
        opts?.signal?.addEventListener("abort", () => {
          listeners = listeners.filter((l) => l !== fn);
          removed++;
        });
      },
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    applyTheme("neon-glow");
    vi.unstubAllGlobals();
  });

  const flip = (dark: boolean): void => {
    matches = dark;
    for (const l of listeners) l();
  };

  it("is a valid stored choice and resolves to the dark theme", () => {
    applyThemeChoice("system");
    expect(getActiveThemeName()).toBe("system");
    expect(document.body.classList.contains("theme-dark")).toBe(true);
  });

  it("resolves to the light theme when the computer is light", () => {
    matches = false;
    applyThemeChoice("system");
    expect(getActiveThemeName()).toBe("system");
    expect(document.body.classList.contains("theme-light")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe("#ffffff");
  });

  it("follows a live change and keeps system as the stored choice", () => {
    applyThemeChoice("system");
    flip(false);
    expect(document.body.classList.contains("theme-light")).toBe(true);
    flip(true);
    expect(document.body.classList.contains("theme-dark")).toBe(true);
    expect(getActiveThemeName()).toBe("system");
  });

  it("re-applies the saved accent after a live change", () => {
    localStorage.setItem("owncord:settings:accentColor", JSON.stringify("#123456"));
    applyThemeChoice("system");
    flip(false);
    expect(document.body.style.getPropertyValue("--accent")).toBe("#123456");
  });

  it("stops following once a concrete theme is chosen, and never stacks listeners", () => {
    applyThemeChoice("system");
    applyThemeChoice("system");
    expect(listeners).toHaveLength(1);
    applyThemeChoice("midnight");
    expect(listeners).toHaveLength(0);
    expect(removed).toBe(2);
    flip(false);
    expect(document.body.classList.contains("theme-midnight")).toBe(true);
    expect(getActiveThemeName()).toBe("midnight");
  });

  it("falls back to dark without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    applyThemeChoice("system");
    expect(document.body.classList.contains("theme-dark")).toBe(true);
  });

  it("restoreTheme re-resolves a stored system choice", () => {
    localStorage.setItem("owncord:theme:active", "system");
    matches = false;
    restoreTheme();
    expect(document.body.classList.contains("theme-light")).toBe(true);
    expect(getActiveThemeName()).toBe("system");
  });

  it("keeps the default neon-glow", () => {
    expect(getActiveThemeName()).toBe("neon-glow");
  });
});

describe("themes with unusable storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function blockStorage(): void {
    const blocked = (): never => {
      throw new DOMException("storage blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);
  }

  it("reads the default theme instead of throwing at startup", () => {
    blockStorage();
    expect(getActiveThemeName()).toBe("neon-glow");
  });

  it("still paints a chosen theme when it cannot be remembered", () => {
    blockStorage();
    expect(() => applyTheme("midnight")).not.toThrow();
    expect(document.body.classList.contains("theme-midnight")).toBe(true);
    expect(() => applyThemeChoice("system")).not.toThrow();
  });
});

describe("applyThemeByName leaves unrelated state alone", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
    for (let i = document.body.style.length - 1; i >= 0; i--) {
      document.body.style.removeProperty(document.body.style.item(i));
    }
  });

  it("keeps classes that are not theme classes", () => {
    document.body.className = "sidebar-open theme-dark compact";
    applyThemeByName("midnight");
    expect(document.body.classList.contains("sidebar-open")).toBe(true);
    expect(document.body.classList.contains("compact")).toBe(true);
    expect(document.body.classList.contains("theme-dark")).toBe(false);
    expect(document.body.classList.contains("theme-midnight")).toBe(true);
  });

  it("clears inline custom properties, even a lone one, but not ordinary styles", () => {
    document.body.style.setProperty("--accent", "#123456");
    applyThemeByName("dark");
    expect(document.body.style.getPropertyValue("--accent")).toBe("");

    document.body.style.setProperty("color", "red");
    document.body.style.setProperty("--first", "1");
    document.body.style.setProperty("--second", "2");
    document.body.style.setProperty("--third", "3");
    applyThemeByName("dark");
    expect(document.body.style.getPropertyValue("color")).toBe("red");
    expect(document.body.style.getPropertyValue("--first")).toBe("");
    expect(document.body.style.getPropertyValue("--second")).toBe("");
    expect(document.body.style.getPropertyValue("--third")).toBe("");
  });

  it("adds no class for a name that is not a built-in theme", () => {
    applyThemeByName("not-a-theme");
    expect(document.body.className).toBe("");
  });

  it("forgets a stored name it does not know and falls back to the default", () => {
    localStorage.setItem("owncord:theme:active", "stale-theme");
    expect(getActiveThemeName()).toBe("neon-glow");
    expect(localStorage.getItem("owncord:theme:active")).toBeNull();
  });
});

describe("system theme and the OS setting", () => {
  let darkMatches = true;
  let registered: Array<{ type: string; fn: () => void }> = [];

  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
    darkMatches = true;
    registered = [];
    // Only the dark-scheme query answers with the OS setting; any other query is "no".
    vi.stubGlobal("matchMedia", (media: string) => ({
      get matches() {
        return media === "(prefers-color-scheme: dark)" ? darkMatches : false;
      },
      media,
      addEventListener: (type: string, fn: () => void, opts?: { signal?: AbortSignal }) => {
        const entry = { type, fn };
        registered.push(entry);
        opts?.signal?.addEventListener("abort", () => {
          registered = registered.filter((r) => r !== entry);
        });
      },
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    applyTheme("neon-glow");
    document.body.style.removeProperty("--accent");
    vi.unstubAllGlobals();
  });

  const flip = (dark: boolean): void => {
    darkMatches = dark;
    for (const r of registered.filter((e) => e.type === "change")) r.fn();
  };

  it("asks the OS for the dark colour scheme when resolving", () => {
    expect(resolveSystemTheme()).toBe("dark");
    darkMatches = false;
    expect(resolveSystemTheme()).toBe("light");
    applyThemeChoice("system");
    expect(document.body.classList.contains("theme-light")).toBe(true);
  });

  it("resolves to dark when the browser cannot answer", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveSystemTheme()).toBe("dark");
  });

  it("listens for change events only", () => {
    applyThemeChoice("system");
    expect(registered.map((r) => r.type)).toEqual(["change"]);
  });

  it("paints the saved accent as soon as system is chosen", () => {
    localStorage.setItem("owncord:settings:accentColor", JSON.stringify("#123456"));
    applyThemeChoice("system");
    expect(document.body.style.getPropertyValue("--accent")).toBe("#123456");
  });

  it("tells painted-theme listeners after a flip, with the accent already restored", () => {
    localStorage.setItem("owncord:settings:accentColor", JSON.stringify("#123456"));
    applyThemeChoice("system");
    const accentSeen: string[] = [];
    const ctl = new AbortController();
    onSystemThemePainted(() => {
      accentSeen.push(document.body.style.getPropertyValue("--accent"));
    }, ctl.signal);
    flip(false);
    flip(true);
    ctl.abort();
    expect(accentSeen).toEqual(["#123456", "#123456"]);
  });

  it("stops telling a listener once its signal aborts", () => {
    applyThemeChoice("system");
    const cb = vi.fn();
    const ctl = new AbortController();
    onSystemThemePainted(cb, ctl.signal);
    flip(false);
    expect(cb).toHaveBeenCalledTimes(1);
    ctl.abort();
    flip(true);
    flip(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("never registers a listener whose signal is already aborted", () => {
    applyThemeChoice("system");
    const cb = vi.fn();
    const ctl = new AbortController();
    ctl.abort();
    onSystemThemePainted(cb, ctl.signal);
    flip(false);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("readableRoleColor probing", () => {
  const html = document.documentElement.style;

  beforeEach(() => {
    document.body.replaceChildren();
    for (let i = html.length - 1; i >= 0; i--) html.removeProperty(html.item(i));
    for (const [token, value] of [
      ["--bg-primary", "#313338"],
      ["--bg-secondary", "#2b2d31"],
      ["--bg-tertiary", "#1e1f22"],
      ["--bg-input", "#383a40"],
    ]) {
      html.setProperty(token!, value!);
    }
    // A theme switch empties the cache of earlier tests.
    applyThemeByName("dark");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (let i = html.length - 1; i >= 0; i--) html.removeProperty(html.item(i));
  });

  /** Spy on computed-style reads of spans, recording whether each was in the page. */
  function watchSpanReads(): boolean[] {
    const reads: boolean[] = [];
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (el: Element, pseudo?: string | null) => {
        if (el instanceof HTMLSpanElement) reads.push(el.isConnected);
        return real(el, pseudo);
      },
    );
    return reads;
  }

  it("reads the colour from an element that is in the page, and cleans it up", () => {
    const reads = watchSpanReads();
    expect(readableRoleColor("#57f287")).toBe("#57f287");
    expect(reads).toEqual([true]);
    expect(document.body.querySelector("span")).toBeNull();
  });

  it("works a colour out once and reuses the answer until the theme changes", () => {
    const reads = watchSpanReads();
    readableRoleColor("#57f287");
    readableRoleColor("#57f287");
    expect(reads).toHaveLength(1);
    applyThemeByName("dark");
    readableRoleColor("#57f287");
    expect(reads).toHaveLength(2);
  });
});
