import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createOcLogo } from "./ocLogo";

describe("createOcLogo", () => {
  it("keeps one sharp logo and a separate glow svg under it", () => {
    const stack = createOcLogo({ idSuffix: "-x", width: 70, height: 42 });
    const [glow, sharp] = Array.from(stack.children);
    expect(glow?.getAttribute("class")).toBe("oc-glow-svg");
    expect(sharp?.getAttribute("class")).toBe("oc-logo");
    expect(stack.querySelectorAll("svg.oc-logo")).toHaveLength(1);
    expect(glow?.querySelector("text")?.getAttribute("filter")).toBe("url(#oc-glow-x)");
    expect(sharp?.querySelector("text")?.getAttribute("filter")).toBeNull();
  });

  it("gives each svg its own gradient so a hidden one cannot break the other", () => {
    const stack = createOcLogo({ idSuffix: "", width: 80, height: 48 });
    const ids = Array.from(stack.querySelectorAll("linearGradient")).map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("glowPulse keyframes", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/login.css"), "utf8");

  it("animate opacity only, never filter", () => {
    const body = /@keyframes glowPulse\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(body).toContain("opacity");
    expect(body).not.toContain("filter");
  });

  it("stay switched off under reduced motion", () => {
    const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(reduced).toMatch(/\.oc-glow-svg\s*\{\s*animation:\s*none !important/);
  });
});
