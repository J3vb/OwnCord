// The server-owned admin panel (Server/admin/static) is index.html plus a
// stylesheet and classic scripts it loads by absolute /admin/ path. jsdom loads
// no external resources, so the contract tests read the document through this
// helper, which inlines each <link rel="stylesheet"> and <script src> in place.
// Inlined, the scripts still run in index.html's order and share one global
// scope, exactly as the browser runs them — so a bridge <script> added before
// </body> can still reach their top-level bindings.
import { readFileSync } from "node:fs";
import path from "node:path";

const ADMIN_STATIC = path.resolve(__dirname, "../../../Server/admin/static");

function asset(href: string): string {
  if (!href.startsWith("/admin/")) throw new Error(`unexpected admin asset path ${href}`);
  return readFileSync(path.join(ADMIN_STATIC, href.slice("/admin/".length)), "utf8");
}

/** index.html with its stylesheet and scripts inlined. */
export function adminPanelHtml(): string {
  const html = readFileSync(path.join(ADMIN_STATIC, "index.html"), "utf8");
  // Replacer functions, not replacement strings: the scripts contain `$&`.
  const inlined = html
    .replace(
      /<link rel="stylesheet" href="([^"]+)">/g,
      (_, href: string) => `<style>${asset(href)}</style>`,
    )
    .replace(
      /<script src="([^"]+)"><\/script>/g,
      (_, src: string) => `<script>${asset(src)}</script>`,
    );
  if (!/<script>/.test(inlined) || /<script src=/.test(inlined)) {
    throw new Error("expected Server/admin/static/index.html to load its scripts by <script src>");
  }
  return inlined;
}
