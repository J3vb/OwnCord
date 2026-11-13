// The shared dialog shell lives in login.css, outside app.css, so this parses
// that file with Lightning CSS and checks that a tall dialog scrolls its body
// between a fixed header and footer instead of pushing the actions off screen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "lightningcss";
import { describe, expect, it } from "vitest";

const css = transform({
  filename: "login.css",
  code: readFileSync(join(process.cwd(), "src/styles/login.css")),
  minify: true,
})
  .code.toString()
  // Only the top-level rules: drop every @media block.
  .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

/** The declarations of every top-level rule whose selector list includes `selector`. */
function declarations(selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(",").includes(selector)) out.push(m[2]!);
  }
  return out.join(";");
}

describe("the shared modal shell", () => {
  it("lays the dialog out as a column capped below the window height", () => {
    const modal = declarations(".modal");
    expect(modal).toContain("display:flex");
    expect(modal).toContain("flex-direction:column");
    expect(modal).toContain("max-height:80vh");
  });

  it("scrolls the body and keeps the header and footer in view", () => {
    const body = declarations(".modal-body");
    expect(body).toContain("min-height:0");
    expect(body).toContain("overflow-y:auto");
    expect(declarations(".modal-footer")).toContain("flex:none");
    expect(declarations(".modal-header")).toContain("flex:none");
  });
});
