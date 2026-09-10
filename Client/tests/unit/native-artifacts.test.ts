import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ConsoleMessage, TestInfo } from "@playwright/test";
import { withNativeArtifacts, type NativeApp } from "../e2e/support/native-app";

const outputDir = mkdtempSync(join(tmpdir(), "native-artifacts-"));
afterAll(() => rmSync(outputDir, { recursive: true, force: true }));

function fixture() {
  const page = Object.assign(new EventEmitter(), { isClosed: () => true });
  const tracing = { start: vi.fn(), stop: vi.fn() };
  const app = {
    page,
    context: { tracing },
    log: () => "fixture process output",
  } as unknown as NativeApp;
  const attach = vi.fn();
  const info = {
    status: "passed",
    expectedStatus: "passed",
    outputPath: (name: string) => join(outputDir, name),
    attach,
  } as unknown as TestInfo;
  const emitConsole = (type: string, text: string) =>
    page.emit("console", { type: () => type, text: () => text } as ConsoleMessage);
  return { page, app, info, tracing, attach, emitConsole };
}

const artifact = (name: string) => join(outputDir, name);

describe("native artifact failure gate", () => {
  it("fails and preserves evidence for observed HTTP cleanup errors", async () => {
    const run = fixture();
    await expect(
      withNativeArtifacts(
        run.app,
        async () => {
          run.emitConsole(
            "error",
            "Failed to release Tauri HTTP resource http:allow-fetch-cancel-body not allowed",
          );
        },
        run.info,
      ),
    ).rejects.toThrow("WebView2 runtime or HTTP cleanup errors");
    expect(run.tracing.stop).toHaveBeenCalledWith({ path: artifact("native-trace.zip") });
    expect(run.attach).toHaveBeenCalledWith("native-process", {
      path: artifact("native-process.log"),
      contentType: "text/plain",
    });
    expect(readFileSync(artifact("native-process.log"), "utf8")).toBe("fixture process output");
    expect(run.attach).toHaveBeenCalledWith("native-webview", {
      path: artifact("native-webview.log"),
      contentType: "text/plain",
    });
    expect(readFileSync(artifact("native-webview.log"), "utf8")).toContain(
      "[error] Failed to release Tauri HTTP resource",
    );
    expect(run.page.listenerCount("console")).toBe(0);
    expect(run.page.listenerCount("pageerror")).toBe(0);
  });

  it("preserves evidence when the test body itself fails", async () => {
    // Playwright only marks `info.status` after the body's rejection has
    // propagated, so the helper must notice the throw on its own.
    const run = fixture();
    await expect(
      withNativeArtifacts(
        run.app,
        async () => {
          throw new Error("assertion inside the body");
        },
        run.info,
      ),
    ).rejects.toThrow("assertion inside the body");
    expect(run.tracing.stop).toHaveBeenCalledWith({ path: artifact("native-trace.zip") });
    expect(run.attach).toHaveBeenCalledWith("native-process", {
      path: artifact("native-process.log"),
      contentType: "text/plain",
    });
  });

  it("keeps page errors fatal while allowing ordinary fixture console messages", async () => {
    const normal = fixture();
    await withNativeArtifacts(
      normal.app,
      async () => {
        normal.emitConsole("error", "Expected fixture network interruption");
      },
      normal.info,
    );
    expect(normal.tracing.stop).toHaveBeenCalledWith();
    expect(normal.attach).not.toHaveBeenCalled();

    const broken = fixture();
    await expect(
      withNativeArtifacts(
        broken.app,
        async () => {
          broken.page.emit("pageerror", new Error("late read rejected"));
        },
        broken.info,
      ),
    ).rejects.toThrow("WebView2 runtime or HTTP cleanup errors");
  });
});
