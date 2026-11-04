// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because the Go module carries no JavaScript engine. See
// docs/contributing.md#testing for the membership rule.
//
// WP 8.8: the Stickers page. Upload checks that mirror the server's limits, the
// list with previews, rename, delete with a confirmation, and the server's own
// error messages (409 name taken, 413, the 60-sticker limit) shown as sent.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import {
  adminHtmlWithBridge,
  loadPanelWithFetch,
  scriptedPanelFetch,
  settlePanel,
} from "../helpers/adminPanelFetch";

const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  get nav(){return NAV},
  renderStickers, uploadSticker, openRenameSticker, saveSticker,
  confirmDeleteSticker, deleteSticker, stickerFileProblem, stickerNameProblem
};
</script>`;
const HTML = adminHtmlWithBridge(BRIDGE);

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}
interface Bridge {
  state: { token: string; me: unknown };
  nav: { id?: string; allowed?: () => boolean }[];
  renderStickers: () => Promise<string>;
  uploadSticker: () => Promise<void>;
  openRenameSticker: (id: number, name: string, emoji: string) => void;
  saveSticker: (id: number) => Promise<void>;
  confirmDeleteSticker: (id: number, name: string) => void;
  deleteSticker: (id: number) => Promise<void>;
  stickerFileProblem: (f: { type: string; size: number } | null) => string;
  stickerNameProblem: (n: string) => string;
}

const LIST = [
  { id: 1, name: "Wave", emoji: "👋", url: "/api/v1/stickers/1/image" },
  { id: 2, name: "Party Blob", emoji: null, url: "/api/v1/stickers/2/image" },
];

const STICKERS_URL = "/api/v1/stickers";

type Reply = { status?: number; json?: unknown; text?: string };

async function boot(
  calls: Call[],
  reply: (method: string, path: string) => Reply = () => ({ json: LIST }),
): Promise<{ dom: JSDOM; bridge: Bridge; doc: Document }> {
  const stickerPath = (url: string) =>
    url.startsWith(STICKERS_URL) ? url.slice(STICKERS_URL.length) || "/" : null;
  const dom = loadPanelWithFetch(
    HTML,
    scriptedPanelFetch(
      ({ method, url, body, headers }) => {
        const path = stickerPath(url);
        if (path !== null) calls.push({ method, path, body, headers });
      },
      (path, method) => {
        if (path === "/setup/status") return { json: { needs_setup: false } };
        const stickers = stickerPath(path);
        if (stickers === null) return { json: {} };
        const r = reply(method, stickers);
        return {
          status: r.status,
          text: r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json)),
        };
      },
    ),
  );
  const bridge = await settlePanel<Bridge>(dom);
  calls.length = 0;
  bridge.state.token = "tok";
  (bridge.state as unknown as { me: unknown }).me = {
    id: 1,
    permissions: 0x40000000,
    role_position: 100,
    is_owner: true,
  };
  return { dom, bridge, doc: dom.window.document };
}

function fill(doc: Document, id: string, value: string): void {
  (doc.getElementById(id) as HTMLInputElement).value = value;
}
function pickFile(
  dom: JSDOM,
  doc: Document,
  file: { name: string; type: string; size: number },
): void {
  const f = new dom.window.File([new Uint8Array(file.size)], file.name, { type: file.type });
  const input = doc.getElementById("stickerFile") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [f], configurable: true });
}
const toast = (doc: Document): string => doc.getElementById("toast")?.textContent ?? "";

describe("Server/admin/static — Stickers", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("is a navigation entry gated on MANAGE_SERVER, next to Emoji", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const ids = booted.bridge.nav.map((n) => n.id);
    expect(ids.indexOf("stickers")).toBe(ids.indexOf("emoji") + 1);
    expect(booted.bridge.nav.find((n) => n.id === "stickers")?.allowed?.()).toBe(true);
    (booted.bridge.state as unknown as { me: unknown }).me = {
      id: 2,
      permissions: 0,
      role_position: 1,
    };
    expect(booted.bridge.nav.find((n) => n.id === "stickers")?.allowed?.()).toBe(false);
  });

  it("lists the stickers with a preview, name and related emoji, using the session token", async () => {
    const calls: Call[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const html = await booted.bridge.renderStickers();
    expect(calls[0]).toMatchObject({ method: "GET", path: "/" });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(html).toContain("Installed (2)");
    expect(html).toContain('data-sticker-url="/api/v1/stickers/1/image"');
    expect(html).toContain("Party Blob");
    expect(html).toContain("👋");
    expect(html).toContain('data-action="openRenameSticker"');
    expect(html).toContain('data-action="confirmDeleteSticker"');
  });

  it("shows an empty line when there are no stickers", async () => {
    const booted = await boot([], () => ({ json: [] }));
    dom = booted.dom;
    expect(await booted.bridge.renderStickers()).toContain("No stickers yet");
  });

  it("shows the server's message when the list cannot load", async () => {
    const booted = await boot([], () => ({
      status: 403,
      json: { message: "Manage Server required" },
    }));
    dom = booted.dom;
    expect(await booted.bridge.renderStickers()).toContain("Manage Server required");
  });

  describe("client-side checks match the server's limits", () => {
    it("name: 2-30 of letters, digits, space, underscore, hyphen", async () => {
      const booted = await boot([]);
      dom = booted.dom;
      const { stickerNameProblem: p } = booted.bridge;
      expect(p("ab")).toBe("");
      expect(p("A".repeat(30))).toBe("");
      expect(p("Party Blob_2-x")).toBe("");
      expect(p("a")).not.toBe("");
      expect(p("A".repeat(31))).not.toBe("");
      expect(p("no:colons")).not.toBe("");
    });

    it("file: PNG/GIF/WebP, at most 512 KiB", async () => {
      const booted = await boot([]);
      dom = booted.dom;
      const { stickerFileProblem: p } = booted.bridge;
      expect(p({ type: "image/png", size: 512 * 1024 })).toBe("");
      expect(p({ type: "image/gif", size: 10 })).toBe("");
      expect(p({ type: "image/webp", size: 10 })).toBe("");
      expect(p({ type: "image/png", size: 512 * 1024 + 1 })).toContain("512 KB");
      expect(p({ type: "image/jpeg", size: 10 })).toContain("PNG, GIF or WebP");
      expect(p(null)).toContain("Choose an image");
    });

    it("an invalid upload never reaches the network", async () => {
      const calls: Call[] = [];
      const booted = await boot(calls);
      dom = booted.dom;
      const { bridge, doc } = booted;
      doc.getElementById("content")!.innerHTML = await bridge.renderStickers();
      calls.length = 0;

      fill(doc, "stickerName", "x");
      pickFile(booted.dom, doc, { name: "a.png", type: "image/png", size: 10 });
      await bridge.uploadSticker();
      expect(toast(doc)).toContain("Name must be 2-30");

      fill(doc, "stickerName", "Wave");
      pickFile(booted.dom, doc, { name: "a.png", type: "image/png", size: 600 * 1024 });
      await bridge.uploadSticker();
      expect(toast(doc)).toContain("512 KB");
      expect(calls).toEqual([]);
    });
  });

  describe("upload", () => {
    async function ready(reply: (m: string, p: string) => Reply) {
      const calls: Call[] = [];
      const booted = await boot(calls, reply);
      dom = booted.dom;
      booted.doc.getElementById("content")!.innerHTML = await booted.bridge.renderStickers();
      calls.length = 0;
      return { calls, ...booted };
    }

    it("posts multipart with the name, emoji and file", async () => {
      const {
        calls,
        bridge,
        doc,
        dom: d,
      } = await ready((m) => (m === "POST" ? { status: 201, json: LIST[0] } : { json: LIST }));
      fill(doc, "stickerName", " Wave ");
      fill(doc, "stickerEmoji", "👋");
      pickFile(d, doc, { name: "wave.png", type: "image/png", size: 100 });
      await bridge.uploadSticker();
      const post = calls.find((c) => c.method === "POST")!;
      const body = post.body as FormData;
      expect(body.get("name")).toBe("Wave");
      expect(body.get("emoji")).toBe("👋");
      expect((body.get("file") as File).name).toBe("wave.png");
      expect(post.headers["Content-Type"]).toBeUndefined();
      expect(toast(doc)).toContain("Added sticker Wave");
    });

    it.each([
      [409, "that sticker name is already taken"],
      [413, "request body too large"],
      [400, "sticker limit reached (60)"],
    ])("shows the server's message for a %i", async (status, message) => {
      const {
        bridge,
        doc,
        dom: d,
      } = await ready((m) => (m === "POST" ? { status, json: { message } } : { json: LIST }));
      fill(doc, "stickerName", "Wave");
      pickFile(d, doc, { name: "wave.png", type: "image/png", size: 100 });
      await bridge.uploadSticker();
      expect(toast(doc)).toContain(message);
    });

    it("explains a bare 413 from the body-size guard", async () => {
      const {
        bridge,
        doc,
        dom: d,
      } = await ready((m) => (m === "POST" ? { status: 413, text: "" } : { json: LIST }));
      fill(doc, "stickerName", "Wave");
      pickFile(d, doc, { name: "wave.png", type: "image/png", size: 100 });
      await bridge.uploadSticker();
      expect(toast(doc)).toContain("too large");
    });
  });

  describe("rename", () => {
    it("PATCHes the name and emoji and closes the dialog", async () => {
      const calls: Call[] = [];
      const booted = await boot(calls, (m) => (m === "PATCH" ? { json: LIST[0] } : { json: LIST }));
      dom = booted.dom;
      const { bridge, doc } = booted;
      bridge.openRenameSticker(1, "Wave", "👋");
      expect((doc.getElementById("stickerRenameName") as HTMLInputElement).value).toBe("Wave");
      fill(doc, "stickerRenameName", "Big Wave");
      fill(doc, "stickerRenameEmoji", "");
      await bridge.saveSticker(1);
      const patch = calls.find((c) => c.method === "PATCH")!;
      expect(patch.path).toBe("/1");
      expect(patch.body).toEqual({ name: "Big Wave", emoji: "" });
      expect(patch.headers["Content-Type"]).toBe("application/json");
      expect(toast(doc)).toContain("Sticker updated");
    });

    it("refuses a bad name locally and shows a 409 from the server", async () => {
      const calls: Call[] = [];
      const booted = await boot(calls, (m) =>
        m === "PATCH" ? { status: 409, json: { message: "name already taken" } } : { json: LIST },
      );
      dom = booted.dom;
      const { bridge, doc } = booted;
      bridge.openRenameSticker(1, "Wave", "");
      fill(doc, "stickerRenameName", "x");
      await bridge.saveSticker(1);
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
      expect(toast(doc)).toContain("Name must be 2-30");

      fill(doc, "stickerRenameName", "Party Blob");
      await bridge.saveSticker(1);
      expect(toast(doc)).toContain("name already taken");
    });
  });

  describe("delete", () => {
    it("asks first, then deletes", async () => {
      const calls: Call[] = [];
      const booted = await boot(calls, (m) => (m === "DELETE" ? { status: 204 } : { json: LIST }));
      dom = booted.dom;
      const { bridge, doc } = booted;
      bridge.confirmDeleteSticker(2, "Party Blob");
      expect(calls).toEqual([]);
      const modal = doc.getElementById("modalInner")!.textContent ?? "";
      expect(modal).toContain("Party Blob");
      expect(modal).toContain("Deleted sticker");
      await bridge.deleteSticker(2);
      expect(calls.find((c) => c.method === "DELETE")?.path).toBe("/2");
      expect(toast(doc)).toContain("Sticker deleted");
    });

    it("shows the server's message when the delete fails", async () => {
      const booted = await boot([], (m) =>
        m === "DELETE" ? { status: 404, json: { message: "sticker not found" } } : { json: LIST },
      );
      dom = booted.dom;
      await booted.bridge.deleteSticker(9);
      expect(toast(booted.doc)).toContain("sticker not found");
    });
  });
});
