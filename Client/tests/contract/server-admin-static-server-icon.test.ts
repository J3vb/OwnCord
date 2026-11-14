// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// The Settings page's Server icon control, driven against the real admin
// scripts in jsdom.
import { describe, it, expect } from "vitest";
import {
  adminHtmlWithBridge,
  bootAdminPanel,
  mountSettings,
  type FetchCall,
  type PanelReply as Reply,
} from "../helpers/adminPanelFetch";

const ADMIN_HTML = adminHtmlWithBridge(`<script>
window.__test = { renderSettings: renderSettings };
</script>`);

interface Bridge {
  renderSettings: () => Promise<string>;
}

const HASH = "0123456789abcdef";

function responder(icon: string) {
  return (path: string, method: string): Reply => {
    if (path === "/settings" && method === "GET") {
      return { json: { server_name: "T", registration_mode: "invite", server_icon: icon } };
    }
    if (path === "/server-icon") return { json: { icon: "" } };
    return { json: {} };
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
});
