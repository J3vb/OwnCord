// Test-only WebView configuration. Elevated Windows runners ignore WebView2
// environment overrides, so pass browser arguments through Tauri's API config.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function nativeTestConfig() {
  const base = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  return {
    identifier: "com.owncord.e2e",
    productName: "OwnCord E2E",
    app: {
      windows: base.app.windows.map((window) => ({
        ...window,
        // Relative to this test application's own data directory.
        dataDirectory: "e2e-webview",
        additionalBrowserArgs: `${window.additionalBrowserArgs ?? ""} --remote-debugging-port=9222 --use-fake-device-for-media-stream`,
      })),
    },
    plugins: { "deep-link": { desktop: { schemes: ["owncord-e2e"] } } },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== "win32" || !process.env.CI)
    throw new Error("Native test builds run in Windows CI only");
  await mkdir("tests/e2e/.bin", { recursive: true });
  await writeFile("tests/e2e/.bin/tauri.native.json", JSON.stringify(await nativeTestConfig()));
}
