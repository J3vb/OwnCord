import { existsSync, readdirSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { dirname, resolve } from "path";
import { twemojiFileName, twemojiPacks } from "./scripts/twemoji-names.mjs";

const CHANGELOG_ID = "virtual:owncord-changelog";
// Walk up rather than "../": Stryker runs the suite from a copy of Client/
// inside Client/.stryker-tmp/sandbox-*, one level deeper than the real package.
function findChangelog(start: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = resolve(dir, "CHANGELOG.md");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return resolve(start, "../CHANGELOG.md");
  }
}

const CHANGELOG_PATH = findChangelog(resolve(import.meta.dirname, ".."));

/**
 * The repository's CHANGELOG.md as a module exporting its text, for the About
 * tab and the "What's new" dialog. A virtual module rather than a `?raw`
 * import: the file sits outside this package, where the dev server serves
 * `/@fs/` paths as plain files instead of transforming them.
 */
export function changelogModule(): Plugin {
  return {
    name: "owncord-changelog",
    resolveId(id) {
      return id === CHANGELOG_ID ? "\0" + CHANGELOG_ID : undefined;
    },
    load(id) {
      if (id !== "\0" + CHANGELOG_ID) return undefined;
      this.addWatchFile(CHANGELOG_PATH);
      return `export default ${JSON.stringify(readFileSync(CHANGELOG_PATH, "utf8"))};`;
    },
  };
}

const TWEMOJI_PACKAGE = resolve(import.meta.dirname, "node_modules/@discordapp/twemoji");

/** Where the Twemoji SVGs are served: versioned, because assets are cached as immutable. */
export function twemojiDir(): string {
  const { version } = JSON.parse(readFileSync(resolve(TWEMOJI_PACKAGE, "package.json"), "utf8"));
  return `assets/twemoji/${version}/`;
}

/**
 * The Twemoji SVGs that messages, reactions and the `:` popup show, packed into
 * a few JSON files of neighbouring names (scripts/twemoji-names.mjs) plus an
 * index of each pack's first name, and served from `twemojiDir()`. A few large
 * files instead of 4,009 small ones: the desktop build compresses every bundled
 * file on its own, and small SVGs compress badly alone.
 */
export function twemojiAssets(): Plugin {
  const svgDir = resolve(TWEMOJI_PACKAGE, "dist/svg");
  const files = (): Map<string, string> => {
    const svgs = new Map<string, string>();
    for (const f of readdirSync(svgDir)) {
      if (f.endsWith(".svg")) {
        svgs.set(twemojiFileName(f.slice(0, -4)), readFileSync(resolve(svgDir, f), "utf8"));
      }
    }
    const { starts, packs } = twemojiPacks(svgs);
    const out = new Map<string, string>([["index.json", JSON.stringify(starts)]]);
    packs.forEach((pack, i) => out.set(`pack-${i}.json`, JSON.stringify(pack)));
    return out;
  };
  return {
    name: "owncord-twemoji",
    configureServer(server) {
      const prefix = `/${twemojiDir()}`;
      let byName: Map<string, string> | undefined;
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith(prefix)) return next();
        byName ??= files();
        const body = byName.get(url.slice(prefix.length));
        if (body === undefined) return next();
        res.setHeader("Content-Type", "application/json");
        res.end(body);
      });
    },
    generateBundle() {
      const dir = twemojiDir();
      for (const [name, source] of files()) {
        this.emitFile({ type: "asset", fileName: dir + name, source });
      }
    },
  };
}

/**
 * Target-neutral config. Settings that exist only because the Tauri desktop
 * shell is the consumer live in `vite.config.desktop.ts`; nothing here may
 * assume a target. Plain `vite build` on this file is the non-desktop build.
 */
export default defineConfig({
  plugins: [changelogModule(), twemojiAssets()],
  // The desktop build, `vite dev` and the e2e prod build are all not-web;
  // `vite.config.web.ts` overrides this. Always defined, so no build can ship
  // an unresolved identifier.
  define: { __OWNCORD_WEB__: false },
  build: {
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // Keep the ~1.3 MB LiveKit SDK in its own chunk, out of the entry.
        // Rolldown (Vite 8) only supports the function form of manualChunks.
        manualChunks(id) {
          if (id.includes("node_modules/livekit-client/")) return "livekit";
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@lib": resolve(import.meta.dirname, "src/lib"),
      "@stores": resolve(import.meta.dirname, "src/stores"),
      "@pages": resolve(import.meta.dirname, "src/pages"),
      "@styles": resolve(import.meta.dirname, "src/styles"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
