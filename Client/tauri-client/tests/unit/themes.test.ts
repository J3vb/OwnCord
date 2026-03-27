import { describe, it, expect, beforeEach } from "vitest";
import {
  applyThemeByName,
  getActiveThemeName,
  listThemeNames,
  saveCustomTheme,
  loadCustomTheme,
  deleteCustomTheme,
  exportTheme,
  type OwnCordTheme,
} from "@lib/themes";

describe("themes", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
  });

  it("lists built-in theme names", () => {
    const names = listThemeNames();
    expect(names).toContain("dark");
    expect(names).toContain("neon-glow");
    expect(names).toContain("midnight");
    expect(names).toContain("light");
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

  it("saves and loads a custom theme", () => {
    const custom: OwnCordTheme = {
      name: "my-red",
      author: "TestUser",
      version: "1.0.0",
      colors: { "--accent-primary": "#ff0000" },
    };
    saveCustomTheme(custom);
    const loaded = loadCustomTheme("my-red");
    expect(loaded).toEqual(custom);
  });

  it("deletes a custom theme", () => {
    const custom: OwnCordTheme = {
      name: "temp",
      author: "",
      version: "1.0.0",
      colors: {},
    };
    saveCustomTheme(custom);
    deleteCustomTheme("temp");
    expect(loadCustomTheme("temp")).toBeNull();
  });

  it("exports a theme as JSON", () => {
    const custom: OwnCordTheme = {
      name: "export-test",
      author: "User",
      version: "1.0.0",
      colors: { "--accent-primary": "#00ff00" },
    };
    const json = exportTheme(custom);
    const parsed = JSON.parse(json) as OwnCordTheme;
    expect(parsed.name).toBe("export-test");
  });

  it("persists active theme name", () => {
    applyThemeByName("neon-glow");
    expect(getActiveThemeName()).toBe("neon-glow");
  });
});
