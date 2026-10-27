// WP 6.13b: the web build target. Runs a real vite build with the web config
// into a temp directory and checks what lands in it: no native host code, and
// the public worklets under assets/ (the portal serves only `/` and `/assets/*`).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const clientRoot = path.resolve(__dirname, "../..");
const PUBLIC_FILES = [
  "rnnoise.wasm",
  "rnnoise-worklet.js",
  "vad-worklet.js",
  "app-audio-worklet.js",
  "pcm-capture-worklet.js",
];

let outDir = "";

function textFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(js|css|html|map)$/.test(f))
    .map((f) => path.join(dir, f));
}

beforeAll(async () => {
  outDir = mkdtempSync(path.join(tmpdir(), "owncord-web-build-"));
  await build({
    root: clientRoot,
    configFile: path.join(clientRoot, "vite.config.web.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  });
}, 300_000);

afterAll(() => {
  if (outDir !== "") rmSync(outDir, { recursive: true, force: true });
});

describe("web build target", () => {
  it("emits an index.html and bundles", () => {
    expect(existsSync(path.join(outDir, "index.html"))).toBe(true);
    expect(existsSync(path.join(outDir, "assets"))).toBe(true);
  });

  it("contains no native host code", () => {
    const files = textFiles(outDir);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Import specifiers only: the bundled changelog may name the package in prose.
      expect(text, file).not.toMatch(/(from\s*|import\s*\(\s*)["'`]@tauri-apps\//);
      expect(text, file).not.toMatch(/\binvoke\(/);
    }
  });

  it("serves the public worklets and wasm from assets/, not the root", () => {
    for (const name of PUBLIC_FILES) {
      expect(existsSync(path.join(outDir, "assets", name)), `assets/${name}`).toBe(true);
      expect(existsSync(path.join(outDir, name)), `root ${name}`).toBe(false);
    }
  });

  it("fetches the public files from /assets/", () => {
    const bundled = textFiles(path.join(outDir, "assets"))
      .filter((f) => f.endsWith(".js") && !PUBLIC_FILES.includes(path.basename(f)))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(bundled).toMatch(/\/assets\//);
    for (const name of PUBLIC_FILES) {
      expect(bundled, name).toMatch(new RegExp("[\"'`(]" + name.replace(".", "\\.") + "[\"'`)]"));
    }
    expect(bundled).not.toMatch(/["'`]\/(vad-worklet|rnnoise-worklet|app-audio-worklet)\.js/);
    expect(bundled).not.toMatch(/["'`]\/rnnoise\.wasm/);
  });
});
