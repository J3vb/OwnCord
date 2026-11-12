// WP 6.13b: the web build target. Runs a real vite build with the web config
// into a temp directory and checks what lands in it: no native host code, and
// the public files under assets/public-<content hash>/ (the portal serves only
// `/` and `/assets/*`, as immutable, so the folder must move when a file does).
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Loaded by a non-literal path: the Vite configs sit outside this tsconfig.
const webConfigPath = "../../vite.config.web.ts";
const { publicAssetsDir } = (await import(webConfigPath)) as {
  publicAssetsDir: (dir?: string) => string;
};

const clientRoot = path.resolve(__dirname, "../..");
const PUBLIC_FILES = [
  "rnnoise.wasm",
  "rnnoise-worklet.js",
  "vad-worklet.js",
  "app-audio-worklet.js",
  "pcm-capture-worklet.js",
  "silero-vad-worker.js",
];
// Loaded by the speech worker by relative URL, so they must sit beside it.
const WORKER_SIBLINGS = ["silero-vad.js", "silero-v5.1.2.bin"];
const PUBLIC_DIR = publicAssetsDir();

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

  it("serves the public files from assets/<content hash>/, not the root", () => {
    expect(PUBLIC_DIR).toMatch(/^public-[0-9a-f]{12}$/);
    for (const name of [...PUBLIC_FILES, ...WORKER_SIBLINGS]) {
      const hashed = path.join(outDir, "assets", PUBLIC_DIR, name);
      expect(existsSync(hashed), `assets/${PUBLIC_DIR}/${name}`).toBe(true);
      expect(existsSync(path.join(outDir, "assets", name)), `assets/${name}`).toBe(false);
      expect(existsSync(path.join(outDir, name)), `root ${name}`).toBe(false);
    }
  });

  it("fetches the public files from /assets/<content hash>/", () => {
    const bundled = readdirSync(path.join(outDir, "assets"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(path.join(outDir, "assets", f), "utf8"))
      .join("\n");
    expect(bundled).toContain(`/assets/${PUBLIC_DIR}/`);
    for (const name of PUBLIC_FILES) {
      expect(bundled, name).toMatch(new RegExp("[\"'`(]" + name.replace(".", "\\.") + "[\"'`)]"));
    }
    expect(bundled).not.toMatch(/["'`]\/(vad-worklet|rnnoise-worklet|app-audio-worklet)\.js/);
    expect(bundled).not.toMatch(/["'`]\/rnnoise\.wasm/);
    expect(bundled).not.toMatch(/["'`]\/assets\/["'`]/);
  });
});

describe("publicAssetsDir", () => {
  const publicSrc = path.join(clientRoot, "public");
  let copy = "";

  beforeAll(() => {
    copy = mkdtempSync(path.join(tmpdir(), "owncord-public-"));
    cpSync(publicSrc, copy, { recursive: true });
  });

  afterAll(() => {
    if (copy !== "") rmSync(copy, { recursive: true, force: true });
  });

  it("is stable for the same files and moves when any file changes", () => {
    expect(publicAssetsDir(copy)).toBe(PUBLIC_DIR);
    writeFileSync(path.join(copy, "silero-vad.js"), "export const changed = 1;\n", { flag: "a" });
    const changed = publicAssetsDir(copy);
    expect(changed).toMatch(/^public-[0-9a-f]{12}$/);
    expect(changed).not.toBe(PUBLIC_DIR);
  });

  it("moves when a file is added", () => {
    const before = publicAssetsDir(copy);
    writeFileSync(path.join(copy, "extra.js"), "");
    expect(publicAssetsDir(copy)).not.toBe(before);
  });
});
