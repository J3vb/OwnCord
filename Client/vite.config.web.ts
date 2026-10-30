import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, mergeConfig, type Plugin } from "vite";
import shared from "./vite.config.ts";

/**
 * Web (browser) overlay (WP 6.13b). Builds the same app for a plain browser:
 * the desktop platform registry is swapped for the inert browser one, and
 * `public/` lands under `assets/`, because the server portal serves only `/`
 * and `/assets/*`. Output goes to `dist-web/`; the desktop build is untouched.
 */

const root = import.meta.dirname;
const DESKTOP_INDEX = resolve(root, "src/platform/desktop/index.ts");
const BROWSER_INDEX = resolve(root, "src/platform/browser/index.ts");
const PUBLIC_DIR = resolve(root, "public");
/** The release version, checked equal to the native shell's by release.yml. */
const APP_VERSION: string = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

/**
 * Vite hands plugins `/`-separated ids on every OS, while `resolve()` on
 * Windows returns `\\`-separated paths, so compare with both sides on `/`.
 */
export function isDesktopRegistry(id: string): boolean {
  return id.replaceAll("\\", "/") === DESKTOP_INDEX.replaceAll("\\", "/");
}

/**
 * Redirect the desktop registry to the browser one. Matches on the resolved
 * absolute path, so `../platform/desktop`, `../../platform/desktop/index` and
 * any alias spelling are all caught. Imports of a desktop submodule are left
 * alone: nothing outside `src/platform` reaches one.
 */
export function browserPlatform(): Plugin {
  return {
    name: "owncord-browser-platform",
    enforce: "pre",
    async resolveId(source, importer, options) {
      // Cheap pre-filter: only a specifier ending in `desktop` or `desktop/index`
      // can name the registry.
      if (!/(^|\/)desktop(\/index(\.ts)?)?$/.test(source)) return undefined;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved !== null && isDesktopRegistry(resolved.id) ? BROWSER_INDEX : undefined;
    },
  };
}

/** Emit every file in `public/` as `assets/<name>`. Used with `publicDir: false`. */
export function publicUnderAssets(): Plugin {
  return {
    name: "owncord-public-under-assets",
    generateBundle() {
      for (const entry of readdirSync(PUBLIC_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const name = entry.name;
        this.emitFile({
          type: "asset",
          fileName: `assets/${name}`,
          source: readFileSync(resolve(PUBLIC_DIR, name)),
        });
      }
    },
  };
}

export default mergeConfig(
  shared,
  defineConfig({
    plugins: [browserPlatform(), publicUnderAssets()],
    define: {
      __OWNCORD_WEB__: true,
      "import.meta.env.OWNCORD_APP_VERSION": JSON.stringify(APP_VERSION),
    },
    publicDir: false,
    build: { outDir: "dist-web" },
  }),
);
