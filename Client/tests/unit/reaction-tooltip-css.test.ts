// jsdom never lays out messages.css, so this pins the CSS *source*.
//
// The tooltip is absolutely positioned inside the reaction pill, so without
// an explicit width it shrinks to the pill's width and, with
// `overflow-wrap: anywhere`, broke names mid-word ("LordJ / ebus").
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `expected a \`${selector} { ... }\` rule in messages.css`).not.toBeNull();
  return match![1]!;
}

describe(".reaction-tooltip", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/app/messages.css"), "utf8");

  it("sizes to its text, not the narrow pill it sits in", () => {
    const body = rule(css, ".reaction-tooltip");
    expect(body).toMatch(/(?<![-\w])width\s*:\s*max-content/);
    expect(body).toMatch(/max-width\s*:/);
  });

  it("never breaks a name mid-word", () => {
    const body = rule(css, ".reaction-tooltip-names");
    expect(body).not.toMatch(/overflow-wrap\s*:\s*anywhere/);
    expect(body).not.toMatch(/word-break\s*:\s*break-all/);
  });
});
