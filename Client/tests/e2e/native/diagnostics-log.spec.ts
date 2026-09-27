/**
 * Native E2E: the client diagnostic trail (CLI-03).
 *
 * The Rust log deleted itself at every 10 MB rollover (tauri-plugin-log's
 * default KeepOne), so a bundle exported right after a rotation had no
 * history. `rotation_strategy(KeepSome(2))` keeps the previous file, and the
 * support bundle now carries it plus the app.json environment facts.
 *
 * The scenario seeds an oversized `owncord-client.log` before launch so the
 * plugin's first write rotates it, then exports the real support bundle to a
 * path the test chooses by answering the OS save dialog's IPC call.
 *
 * Not covered here: the "frontend not ready" watchdog line. Producing it needs
 * the initial document's module script to fail before `frontend_ready` is
 * sent, and neither route reaches that window — an elevated WebView2 ignores
 * runtime browser-argument env overrides (they are baked into the test config
 * at build time), and a CDP `context.route` can only be installed after
 * Playwright attaches, by which point the app has already loaded and called
 * `frontend_ready` (observed in CI: "[startup] frontend ready after 1434 ms").
 * The watchdog and its exact wording are pinned by a Rust unit test
 * (`diagnostics::tests::not_ready_warning_names_the_condition`) instead.
 */

import { test, expect } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { startNativeApp, withNativeArtifacts, type NativeApp } from "../support/native-app";
import { startTestServer } from "../support/server";
import { configureNativeServer, nativeLoginAndReady } from "./helpers";
import { openSettings, switchSettingsTab } from "../helpers";

const APP_LOG_DIR = join(process.env.LOCALAPPDATA ?? "", "com.owncord.e2e", "logs");

/** Wait until `predicate` sees the file text, polling so a late flush settles. */
async function readWhen(
  name: string,
  predicate: (text: string) => boolean,
  timeout = 20_000,
): Promise<string> {
  let last = "";
  await expect
    .poll(
      async () => {
        last = await readFile(join(APP_LOG_DIR, name), "utf8").catch(() => "");
        return predicate(last);
      },
      { timeout },
    )
    .toBe(true);
  return last;
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
test("a Rust log rollover keeps the previous file, and the bundle carries the native log", async ({}, info) => {
  test.setTimeout(180_000);
  const server = await startTestServer({ tls: true });
  let app: NativeApp | undefined;
  try {
    configureNativeServer(server.origin);
    process.env.OWNCORD_SERVER_URL = server.origin.replace("https://", "");
    process.env.OWNCORD_TEST_USER = "alice";
    process.env.OWNCORD_TEST_PASS = "OwnCord-E2E-pass-123!";
    // Well above the plugin's 10 MB max_file_size, so the plugin rotates on its
    // first write at startup (RotatingFile::new checks current_size >= max_size).
    app = await startNativeApp(undefined, { seedActiveLogBytes: 11_000_000 });
    await withNativeArtifacts(
      app,
      async () => {
        const page = app!.page;
        // The seeded log rotated into a dated file; the active file was
        // recreated with this session's `[startup]` line.
        const rotated = (await readdir(APP_LOG_DIR)).filter(
          (name) => name.startsWith("owncord-client_") && name.endsWith(".log"),
        );
        expect(rotated.length).toBeGreaterThan(0);
        await readWhen("owncord-client.log", (text) => text.includes("[startup]"));

        await nativeLoginAndReady(page);
        await openSettings(page);
        await switchSettingsTab(page, "Logs");

        // Choose the bundle's destination by answering the OS save dialog's IPC
        // call ourselves. Tauri seals `__TAURI_INTERNALS__`, but the IPC
        // transport is a `window.fetch` to `ipc.localhost`, which is writable.
        // The path must sit under `$APPLOG/**` (the fs capability's write
        // scope): a faked dialog response does not add the chosen path to the
        // fs scope the way the real dialog does.
        const destination = join(APP_LOG_DIR, "owncord-support.zip");
        await page.evaluate((path) => {
          const nativeFetch = window.fetch;
          window.fetch = async (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes(encodeURIComponent("plugin:dialog|save"))) {
              return new Response(JSON.stringify(path), {
                status: 200,
                headers: { "Tauri-Response": "ok", "content-type": "application/json" },
              });
            }
            return nativeFetch(input, init);
          };
        }, destination);

        await page.getByTestId("export-support-bundle").click();
        await expect(page.getByTestId("support-bundle-status")).toHaveText("Support bundle saved.");

        const zip = await readFile(destination);
        expect(zip.length).toBeGreaterThan(0);
        // The zip is store-only, so every entry's bytes (including the JSON
        // documents) appear verbatim in the archive.
        const names = zip.toString("latin1");
        expect(names).toContain("logs/owncord-client.log");
        // The Rust log the bundle now carries is the active file the plugin
        // recreated after rotating the seeded one: its `[startup]` line is in
        // the archive.
        expect(names).toContain("[startup]");
        // app.json carries the environment facts CLI-03 added. The server
        // version is null in this export because the bundle makes no server
        // call (decision 7), with the reason recorded beside it.
        expect(names).toContain('"os"');
        expect(names).toContain('"userAgent"');
        expect(names).toContain('"serverVersion": null');
        expect(names).toContain("bundle makes no server call");
      },
      info,
    );
  } finally {
    try {
      await app?.close();
    } finally {
      await server.close();
    }
  }
});
