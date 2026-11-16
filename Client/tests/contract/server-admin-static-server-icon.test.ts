// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// The Settings page's Server icon control, driven against the real admin
// scripts in jsdom.
import { describe, it, expect } from "vitest";
import type { JSDOM } from "jsdom";
import {
  adminHtmlWithBridge,
  bootAdminPanel,
  mountSettings,
  type FetchCall,
  type PanelReply as Reply,
} from "../helpers/adminPanelFetch";

const ADMIN_HTML = adminHtmlWithBridge(`<script>
window.__test = { renderSettings: renderSettings, saveSettings: saveSettings };
</script>`);

interface Bridge {
  renderSettings: () => Promise<string>;
  saveSettings: () => Promise<void>;
}

const HASH = "0123456789abcdef";

function responder(icon: string) {
  return (path: string, method: string): Reply => {
    if (path === "/settings" && method === "GET") {
      return { json: { server_name: "T", registration_mode: "invite", server_icon: icon } };
    }
    if (path === "/settings" && method === "PATCH") return { json: {} };
    if (path === "/server-icon") return { json: { icon: method === "PUT" ? HASH : "" } };
    return { json: {} };
  };
}

/** What jsdom lacks for the crop: an image decoder and a canvas that can draw and encode. */
function stubCanvas(window: JSDOM["window"]): void {
  const w = window as unknown as Record<string, unknown>;
  w["createImageBitmap"] = () => Promise.resolve({ width: 200, height: 100, close() {} });
  window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as never;
  window.HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new window.Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
  };
}

describe("Server/admin/static — Server icon control", () => {
  it("offers a picture picker and no Remove button while there is no icon", async () => {
    const calls: FetchCall[] = [];
    const b = await bootAdminPanel<Bridge>(ADMIN_HTML, calls, responder(""));
    await mountSettings(b.bridge, b.doc);
    const row = b.doc.getElementById("serverIconRow");
    expect(row?.querySelector("img")).toBeNull();
    expect(row?.querySelector("button[data-action='removeServerIcon']")).toBeNull();
    const picker = b.doc.getElementById("serverIconFile") as HTMLInputElement;
    expect(picker.accept).toBe("image/*");
    expect(picker.getAttribute("data-change-action")).toBe("filePicked");
  });

  it("shows the current icon by its hash and removes it with DELETE", async () => {
    const calls: FetchCall[] = [];
    const b = await bootAdminPanel<Bridge>(ADMIN_HTML, calls, responder(HASH));
    await mountSettings(b.bridge, b.doc);
    const img = b.doc.querySelector<HTMLImageElement>("#serverIconRow img");
    expect(img?.getAttribute("src")).toBe(`/api/v1/server-icon?v=${HASH}`);

    b.doc.querySelector<HTMLElement>("button[data-action='removeServerIcon']")?.click();
    await new Promise((resolve) => b.doc.defaultView?.setTimeout(resolve, 0));
    expect(calls.some((c) => c.path === "/server-icon" && c.method === "DELETE")).toBe(true);
    expect(b.doc.querySelector("#serverIconRow img")).toBeNull();
    expect(b.doc.querySelector("button[data-action='removeServerIcon']")).toBeNull();
  });

  it("uploads the cropped PNG with PUT and shows the new icon", async () => {
    const calls: FetchCall[] = [];
    const b = await bootAdminPanel<Bridge>(ADMIN_HTML, calls, responder(""), stubCanvas);
    await mountSettings(b.bridge, b.doc);
    const input = b.doc.getElementById("serverIconFile") as HTMLInputElement;
    const file = new b.dom.window.File([new Uint8Array(8)], "wide.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new b.dom.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => b.doc.defaultView?.setTimeout(resolve, 20));

    expect(calls.some((c) => c.path === "/server-icon" && c.method === "PUT")).toBe(true);
    expect(b.doc.querySelector("#serverIconRow img")?.getAttribute("src")).toBe(
      `/api/v1/server-icon?v=${HASH}`,
    );
  });

  it("clears the file input after a failed upload so the same file can be chosen again", async () => {
    const calls: FetchCall[] = [];
    const b = await bootAdminPanel<Bridge>(ADMIN_HTML, calls, responder(""), (window) => {
      stubCanvas(window);
      (window as unknown as Record<string, unknown>)["createImageBitmap"] = () =>
        Promise.reject(new Error("not an image"));
    });
    await mountSettings(b.bridge, b.doc);
    const input = b.doc.getElementById("serverIconFile") as HTMLInputElement;
    const cleared: string[] = [];
    Object.defineProperty(input, "files", {
      value: [new b.dom.window.File([new Uint8Array(1)], "x.png")],
      configurable: true,
    });
    Object.defineProperty(input, "value", {
      get: () => "C:\\fakepath\\x.png",
      set: (v: string) => {
        cleared.push(v);
      },
      configurable: true,
    });
    input.dispatchEvent(new b.dom.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => b.doc.defaultView?.setTimeout(resolve, 20));

    expect(cleared).toContain("");
    expect(calls.some((c) => c.path === "/server-icon")).toBe(false);
  });

  it("never sends server_icon from the Save bar", async () => {
    const calls: FetchCall[] = [];
    const b = await bootAdminPanel<Bridge>(ADMIN_HTML, calls, responder(HASH));
    await mountSettings(b.bridge, b.doc);
    const name = b.doc.getElementById("s-server_name") as HTMLInputElement;
    name.value = "Renamed";
    (b.doc.getElementById("saveSettingsBtn") as HTMLButtonElement).disabled = false;
    await b.bridge.saveSettings();

    const patch = calls.find((c) => c.path === "/settings" && c.method === "PATCH");
    expect(patch?.body).toEqual({ server_name: "Renamed" });
  });
});
