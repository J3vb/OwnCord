// The web build swaps the desktop platform registry for the browser one. Vite
// gives plugins `/`-separated ids even on Windows, where `path.resolve` uses
// `\`, so the swap must match either spelling (a Windows `build:web` once
// shipped the desktop registry because of this).
import path from "node:path";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";

interface WebConfig {
  browserPlatform: () => Plugin;
  isDesktopRegistry: (id: string) => boolean;
}

// Loaded by a non-literal path: the Vite configs sit outside this tsconfig.
const webConfigPath = "../../vite.config.web.ts";
const { browserPlatform, isDesktopRegistry } = (await import(webConfigPath)) as WebConfig;

const clientRoot = path.resolve(__dirname, "../..");
const desktopIndex = path.resolve(clientRoot, "src/platform/desktop/index.ts");
const browserIndex = path.resolve(clientRoot, "src/platform/browser/index.ts");
const slashed = desktopIndex.replaceAll("\\", "/");
const backslashed = desktopIndex.replaceAll("/", "\\");

type ResolveIdHook = (
  this: { resolve: () => Promise<{ id: string } | null> },
  source: string,
  importer: string | undefined,
  options: object,
) => Promise<string | undefined>;

async function swap(source: string, resolvedId: string | null): Promise<string | undefined> {
  const plugin: Plugin = browserPlatform();
  const hook = plugin.resolveId as unknown as ResolveIdHook;
  const ctx = {
    resolve: async () => (resolvedId === null ? null : { id: resolvedId }),
  };
  return hook.call(ctx, source, path.join(clientRoot, "src/main.ts"), {});
}

describe("web build platform swap", () => {
  it("matches the desktop registry with / or \\ separators", () => {
    expect(isDesktopRegistry(slashed)).toBe(true);
    expect(isDesktopRegistry(backslashed)).toBe(true);
    expect(isDesktopRegistry(desktopIndex)).toBe(true);
  });

  it("does not match a desktop submodule or the browser registry", () => {
    expect(isDesktopRegistry(slashed.replace(/index\.ts$/, "storage.ts"))).toBe(false);
    expect(isDesktopRegistry(browserIndex)).toBe(false);
  });

  it("redirects the registry to the browser one for either separator", async () => {
    await expect(swap("./platform/desktop", slashed)).resolves.toBe(browserIndex);
    await expect(swap("../platform/desktop/index", backslashed)).resolves.toBe(browserIndex);
  });

  it("leaves other imports alone", async () => {
    await expect(swap("./lib/ws", null)).resolves.toBeUndefined();
    await expect(swap("./platform/desktop", null)).resolves.toBeUndefined();
    await expect(
      swap("./platform/desktop", slashed.replace(/index\.ts$/, "other.ts")),
    ).resolves.toBeUndefined();
  });
});
