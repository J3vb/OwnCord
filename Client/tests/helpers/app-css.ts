// jsdom never applies stylesheets, so the CSS-source tests read the text.
// app.css is an @import manifest; this inlines each fragment in manifest
// (cascade) order, so a test sees the same rules the bundle does.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readAppCss(): string {
  const dir = join(process.cwd(), "src/styles");
  return readFileSync(join(dir, "app.css"), "utf8").replace(
    /^@import "([^"]+)";$/gm,
    (_, path: string) => readFileSync(join(dir, path), "utf8"),
  );
}
