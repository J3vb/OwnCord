// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because the Go module carries no JavaScript engine. See
// docs/contributing.md#testing for the membership rule.
//
// The Storage page: what fills the disk, every upload with filters, bulk
// delete with a confirmation, leftover files, and on the Members page each
// member's usage and own upload limit. Server/admin/handlers_storage_test.go
// pins the server half.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  get nav(){return NAV},
  renderStorage, renderUsers, closeModal
};
</script>`;
const ADMIN_HTML = adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`);

const ADMINISTRATOR = 0x40000000;
const MANAGE_SERVER = 0x2000000;
const KICK_MEMBERS = 0x40000;

type Responder = (path: string, method: string) => unknown;
type Sent = { call: string; body: unknown };

interface Bridge {
  state: { token: string; me: unknown; section: string };
  nav: { id?: string; allowed?: () => boolean }[];
  renderStorage: () => Promise<string>;
  renderUsers: () => Promise<string>;
  closeModal: () => void;
}

let dom: JSDOM | undefined;

async function boot(respond: Responder, sent: Sent[] = [], calls: string[] = []) {
  dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const p = String(input).replace(/^\/admin\/api/, "");
        calls.push(`${method} ${p}`);
        if (typeof opts.body === "string")
          sent.push({ call: `${method} ${p}`, body: JSON.parse(opts.body) });
        const json =
          p === "/setup/status" ? { needs_setup: false } : ((await respond(p, method)) ?? {});
        return {
          ok: true,
          status: 200,
          json: async () => json,
          text: async () => JSON.stringify(json),
        } as Response;
      }) as typeof fetch;
    },
  });
  const settle = (ms = 0) => new Promise((resolve) => dom!.window.setTimeout(resolve, ms));
  await settle();
  calls.length = 0;
  dom.window.document.getElementById("adminShell")!.classList.remove("hidden");
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  const doc = dom.window.document;
  bridge.state.token = "tok";
  const show = async (section: "storage" | "users", me: Record<string, unknown>) => {
    bridge.state.me = me;
    bridge.state.section = section;
    doc.getElementById("content")!.innerHTML =
      section === "storage" ? await bridge.renderStorage() : await bridge.renderUsers();
    await settle();
    await settle();
  };
  return { bridge, doc, settle, show };
}

const SUMMARY = {
  uploads: [
    { kind: "image", count: 3, bytes: 3 * 1048576 },
    { kind: "video", count: 1, bytes: 2 * 1073741824 },
  ],
  upload_bytes: 2 * 1073741824 + 3 * 1048576,
  upload_count: 4,
  database_bytes: 5 * 1048576,
  backup_bytes: 0,
  disk_free_bytes: 10 * 1073741824,
  user_quota_bytes: 0,
};

const FILES = {
  items: [
    {
      attachment: {
        id: "vid",
        filename: "raid-night.mp4",
        size: 2 * 1073741824,
        mime: "video/mp4",
      },
      uploaded_at: "2026-03-12 10:00:00",
      uploader_id: 7,
      uploader: "kobe",
      channel_id: 3,
      channel_name: "clips",
      channel_type: "text",
      message_id: 11,
      state: "message",
      removable: true,
    },
    {
      attachment: { id: "ava", filename: "me.png", size: 1048576, mime: "image/png" },
      uploaded_at: "2026-03-01 10:00:00",
      uploader_id: 8,
      uploader: "mila",
      channel_id: null,
      message_id: null,
      state: "avatar",
      removable: false,
    },
  ],
  next_cursor: "next",
};

afterEach(() => {
  dom?.window?.close();
  dom = undefined;
});

describe("Server/admin/static — Storage", () => {
  it("is a Manage Server page", async () => {
    const { bridge } = await boot(() => ({}));
    const item = bridge.nav.find((n) => n.id === "storage")!;
    bridge.state.me = { id: 1, permissions: KICK_MEMBERS, role_position: 60 };
    expect(item.allowed!()).toBe(false);
    bridge.state.me = { id: 1, permissions: MANAGE_SERVER, role_position: 60 };
    expect(item.allowed!()).toBe(true);
  });

  it("shows what fills the disk, filters the list, and deletes the ticked files", async () => {
    const sent: Sent[] = [];
    const calls: string[] = [];
    const { doc, settle, show } = await boot(
      (p, m) => {
        if (p === "/storage/summary") return SUMMARY;
        if (p === "/storage/leftovers" && m === "GET") return { count: 2, bytes: 4096 };
        if (p === "/retention/channels") return [{ id: 3, name: "clips" }];
        if (p.startsWith("/storage/files?")) return FILES;
        if (p === "/storage/files/delete")
          return {
            deleted: ["vid"],
            already_gone: [],
            in_use: [],
            failed: [],
            freed_bytes: 2 * 1073741824,
            files_kept: 1,
          };
        return {};
      },
      sent,
      calls,
    );
    await show("storage", {
      id: 1,
      permissions: ADMINISTRATOR,
      role_position: 100,
      is_owner: true,
    });

    const text = doc.getElementById("content")!.textContent ?? "";
    expect(text).toContain("Uploads 2.00 GB");
    expect(text).toContain("Database 5.0 MB");
    expect(text).toContain("Free 10.00 GB");
    expect(text).toContain("2 leftover files");
    expect(calls).toContain("GET /storage/files?sort=largest&limit=50");

    const boxes = [...doc.querySelectorAll<HTMLInputElement>("#storageList input[type=checkbox]")];
    expect(boxes).toHaveLength(2);
    expect(boxes[1]!.disabled).toBe(true);
    expect(doc.getElementById("storageList")!.textContent).toContain("Profile picture");

    (doc.querySelector('[data-action="filterStorageUploader"]') as HTMLElement).click();
    await settle();
    expect(calls).toContain("GET /storage/files?sort=largest&limit=50&uploader=7");
    expect(doc.getElementById("storageUploader")!.textContent).toContain("kobe");

    const tick = doc.querySelector<HTMLInputElement>(
      "#storageList input[type=checkbox]:not([disabled])",
    )!;
    tick.checked = true;
    tick.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));
    const del = doc.querySelector<HTMLButtonElement>('[data-action="confirmStorageDelete"]')!;
    expect(del.disabled).toBe(false);
    expect(doc.querySelector(".storage-foot")!.textContent).toContain("1 selected · 2.00 GB");
    del.click();
    expect(doc.getElementById("modalInner")!.textContent).toContain("cannot be undone");
    (doc.querySelector('[data-action="deleteStorageFiles"]') as HTMLElement).click();
    await settle();
    await settle();
    expect(sent).toContainEqual({ call: "POST /storage/files/delete", body: { ids: ["vid"] } });
    expect(doc.getElementById("toast")!.textContent).toContain("1 stayed on disk");
  });

  it("drops a list answer that a newer filter superseded", async () => {
    let release: (() => void) | undefined;
    const { doc, settle, show } = await boot((p) => {
      if (p === "/storage/summary") return SUMMARY;
      if (p.startsWith("/storage/files?") && p.includes("kind=video"))
        return { items: [FILES.items[0]] };
      if (p.startsWith("/storage/files?") && p.includes("kind=image"))
        return new Promise((resolve) => {
          release = () => resolve({ items: [FILES.items[1]] });
        });
      if (p.startsWith("/storage/files?")) return FILES;
      return {};
    });
    await show("storage", {
      id: 1,
      permissions: ADMINISTRATOR,
      role_position: 100,
      is_owner: true,
    });
    const kind = doc.getElementById("storageKind") as HTMLSelectElement;
    kind.value = "image";
    kind.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));
    kind.value = "video";
    kind.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));
    await settle();
    release!();
    await settle();
    const list = doc.getElementById("storageList")!.textContent ?? "";
    expect(list).toContain("raid-night.mp4");
    expect(list).not.toContain("me.png");
  });

  it("shows each member's usage and saves their own upload limit", async () => {
    const sent: Sent[] = [];
    const { doc, settle, show } = await boot((p) => {
      if (p.startsWith("/users?"))
        return [{ id: 4, username: "member", role_id: 4, role_position: 40 }];
      if (p.startsWith("/storage/members?ids=4"))
        return {
          members: [{ user_id: 4, bytes_used: 3 * 1048576, quota_mb: null }],
          user_quota_bytes: 10 * 1048576,
        };
      if (p === "/users/4/upload-limit")
        return { user_id: 4, bytes_used: 3 * 1048576, quota_mb: 50 };
      return [];
    }, sent);
    await show("users", { id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true });
    expect(doc.getElementById("mstore-4")!.textContent).toBe("3.0 MB of 10.0 MB");

    (doc.querySelector('[data-action="toggleMemberMenu"]') as HTMLElement).click();
    (doc.querySelector('#memberMenu [data-action="openUploadLimit"]') as HTMLElement).click();
    (
      doc.querySelector('input[name="uploadLimitMode"][value="custom"]') as HTMLInputElement
    ).checked = true;
    (doc.getElementById("uploadLimitMB") as HTMLInputElement).value = "50";
    (doc.querySelector('[data-action="saveUploadLimit"]') as HTMLElement).click();
    await settle();
    expect(sent).toContainEqual({ call: "PATCH /users/4/upload-limit", body: { quota_mb: 50 } });
    expect(doc.getElementById("mstore-4")!.textContent).toContain("3.0 MB of 50.0 MB");
    expect(doc.getElementById("mstore-4")!.textContent).toContain("own limit");
  });
});
