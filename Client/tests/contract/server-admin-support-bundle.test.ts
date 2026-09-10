// Execute the server-owned panel: previewing must never download, and only a
// separate confirmation may export the frozen ID/hash the administrator saw.
import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(
  path.resolve(__dirname, "../../../Server/admin/static/index.html"),
  "utf8",
);
const html = source.replace(
  "</body>",
  `<script>window.bundleTest={state,renderDiagnostics,previewSupportBundle,downloadSupportBundle,doLogout};</script></body>`,
);

const preview = {
  preview_id: "frozen-preview",
  sha256: "a".repeat(64),
  byte_size: 1234,
  expires_at: "2099-01-01T12:00:00Z",
  items: [{ name: "events.json", byte_size: 80, sha256: "b".repeat(64) }],
  redactions: [
    {
      item: "events.json",
      rule: "fixed event codes only",
      omitted: "raw messages and credentials omitted",
    },
  ],
};

interface Panel {
  state: {
    token: string;
    section: string;
    me: { permissions: number } | null;
    supportPreview: typeof preview | null;
  };
  renderDiagnostics(): string;
  previewSupportBundle(): Promise<void>;
  downloadSupportBundle(): Promise<void>;
  doLogout(): void;
}

let dom: JSDOM | undefined;
afterEach(() => {
  dom?.window.close();
  dom = undefined;
});

async function boot(
  respond: (url: string) => Promise<Response> = async (url) =>
    new Response(JSON.stringify(url.endsWith("preview") ? preview : {})),
) {
  const calls: { url: string; body: unknown; authorization: string | undefined }[] = [];
  const downloads: string[] = [];
  dom = new JSDOM(html, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = (async (input: string, init: RequestInit = {}) => {
        const url = String(input);
        if (url.includes("support-bundles"))
          calls.push({
            url,
            body: JSON.parse(String(init.body)),
            authorization: (init.headers as Record<string, string>).Authorization,
          });
        if (url.endsWith("download"))
          return new Response("frozen ZIP", { headers: { "Content-Type": "application/zip" } });
        if (url.endsWith("/setup/status"))
          return new Response(JSON.stringify({ needs_setup: false }));
        return respond(url);
      }) as typeof fetch;
      window.URL.createObjectURL = () => "blob:download";
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {
        downloads.push(this.download);
      };
    },
  });
  await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
  const panel = (dom.window as unknown as { bundleTest: Panel }).bundleTest;
  panel.state.token = "current-session";
  panel.state.me = { permissions: 0x40000000 };
  panel.state.section = "diagnostics";
  const content = dom.window.document.getElementById("content")!;
  content.innerHTML = panel.renderDiagnostics();
  return { panel, calls, downloads, content };
}

describe("admin support bundle preview and confirmation", () => {
  it("shows exact size, hashes and omission rules before a separate confirmed download", async () => {
    const { panel, calls, downloads, content } = await boot();
    expect(content.querySelector("#support-confirm")).toBeNull();
    await panel.previewSupportBundle();
    expect(calls).toHaveLength(1);
    expect(downloads).toEqual([]);
    expect(content.textContent).toContain("1234 bytes");
    expect(content.textContent).toContain(preview.sha256);
    expect(content.textContent).toContain("raw messages and credentials omitted");
    expect(content.querySelector("#support-confirm")?.textContent).toBe("Confirm download");
    await panel.downloadSupportBundle();
    expect(calls[1]).toEqual({
      url: "/admin/api/support-bundles/download",
      body: { preview_id: preview.preview_id, sha256: preview.sha256 },
      authorization: "Bearer current-session",
    });
    expect(downloads).toEqual(["owncord-support.zip"]);
    expect(panel.state.supportPreview).toBeNull();
    await panel.downloadSupportBundle();
    expect(calls).toHaveLength(2);
  });

  it("discarding the preview never downloads", async () => {
    const { panel, calls, downloads, content } = await boot();
    await panel.previewSupportBundle();
    const discard = [...content.querySelectorAll("button")].find(
      (button) => button.textContent === "Discard preview",
    )!;
    discard.click();
    await panel.downloadSupportBundle();
    expect(panel.state.supportPreview).toBeNull();
    expect(calls).toHaveLength(1);
    expect(downloads).toEqual([]);
  });

  it("ignores a preview response that belongs to a signed-out session", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const { panel, downloads } = await boot(async () => pending);
    const request = panel.previewSupportBundle();
    panel.doLogout();
    resolve(new Response(JSON.stringify(preview)));
    await request;
    expect(panel.state.token).toBe("");
    expect(panel.state.supportPreview).toBeNull();
    expect(downloads).toEqual([]);
  });
});
