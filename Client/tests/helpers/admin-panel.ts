// The server-owned admin panel (Server/admin/static) is index.html plus a
// stylesheet and classic scripts it loads by absolute /admin/ path. jsdom loads
// no external resources, so the contract tests read the document through this
// helper, which inlines each <link rel="stylesheet"> and <script src> in place.
// Inlined, the scripts still run in index.html's order and share one global
// scope, exactly as the browser runs them — so a bridge <script> added before
// </body> can still reach their top-level bindings.
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const ADMIN_STATIC = path.resolve(__dirname, "../../../Server/admin/static");

function asset(href: string): string {
  if (!href.startsWith("/admin/")) throw new Error(`unexpected admin asset path ${href}`);
  return readFileSync(path.join(ADMIN_STATIC, href.slice("/admin/".length)), "utf8");
}

/** index.html exactly as the server serves it. */
export function adminIndexHtml(): string {
  return readFileSync(path.join(ADMIN_STATIC, "index.html"), "utf8");
}

/** index.html with its stylesheet and scripts inlined. */
export function adminPanelHtml(): string {
  // Rewritten through a parsed DOM, not regexes over the markup. jsdom does not
  // run the scripts here: runScripts is off by default.
  const dom = new JSDOM(adminIndexHtml());
  const doc = dom.window.document;
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const style = doc.createElement("style");
    style.textContent = asset(link.getAttribute("href") ?? "");
    link.replaceWith(style);
  }
  const scripts = doc.querySelectorAll<HTMLScriptElement>("script[src]");
  if (scripts.length === 0) {
    throw new Error("expected Server/admin/static/index.html to load its scripts by <script src>");
  }
  for (const script of scripts) {
    script.textContent = asset(script.getAttribute("src") ?? "");
    script.removeAttribute("src");
  }
  return dom.serialize();
}
