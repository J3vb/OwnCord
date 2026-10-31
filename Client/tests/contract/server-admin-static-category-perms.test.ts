// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine. See docs/contributing.md#testing.
//
// WP 6.5d: the admin panel's category permission matrix, the "Synced with
// category" badge and the "Sync now" button. Loads the real panel into a
// scripted jsdom window and drives it the way a browser would.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import {
  adminHtmlWithBridge,
  loadAdminPanel as loadPanel,
  type FetchCall,
  type PanelReply,
} from "../helpers/adminPanelFetch";

const BRIDGE = `<script>
window.__test = {
  state: state,
  renderChannels: renderChannels,
  openCategoryPermsModal: openCategoryPermsModal,
  renderPermMatrix: renderPermMatrix,
  saveCategoryPerms: saveCategoryPerms,
  clearPermOverride: clearPermOverride,
  syncChannelPerms: syncChannelPerms,
  ACTIONS: ACTIONS
};
</script>`;
const ADMIN_HTML = adminHtmlWithBridge(BRIDGE);

const CHANNELS = [
  {
    id: 1,
    name: "alpha",
    type: "text",
    category: "Games",
    category_id: 7,
    permissions_synced: true,
    archived: false,
  },
  {
    id: 2,
    name: "beta",
    type: "text",
    category: "Games",
    category_id: 7,
    permissions_synced: false,
    archived: false,
  },
  {
    id: 3,
    name: "loose",
    type: "text",
    category: "",
    category_id: 0,
    permissions_synced: false,
    archived: false,
  },
];

function respond(p: string, method: string): PanelReply {
  if (p === "/channels") return { json: CHANNELS };
  if (p === "/channels/categories") return { json: [{ id: 7, name: "Games", position: 0 }] };
  if (p === "/channels/categories/7/permissions") {
    return {
      json: {
        category_id: 7,
        roles: [{ role_id: 5, role_name: "Member", permissions: 0, allow: 0, deny: 0 }],
        users: [],
      },
    };
  }
  if (p.startsWith("/users") || p === "/roles") return { json: [] };
  if (method === "DELETE") return { status: 204, text: "" };
  return {};
}

function loadAdminPanel(fetchCalls: FetchCall[]): JSDOM {
  return loadPanel(ADMIN_HTML, fetchCalls, respond);
}

type Bridge = {
  state: any;
  renderChannels: () => Promise<string>;
  openCategoryPermsModal: (id: number, name: string) => Promise<void>;
  renderPermMatrix: () => void;
  saveCategoryPerms: () => Promise<void>;
  clearPermOverride: () => Promise<void>;
  syncChannelPerms: (id: number, name: string) => Promise<void>;
  ACTIONS: Record<string, unknown>;
};

describe("Server/admin/static — category permissions", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  async function boot(): Promise<{ window: JSDOM["window"]; bridge: Bridge; calls: FetchCall[] }> {
    const calls: FetchCall[] = [];
    dom = loadAdminPanel(calls);
    const { window } = dom;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    calls.length = 0;
    const bridge = (window as unknown as { __test: Bridge }).__test;
    expect(bridge).toBeTruthy();
    return { window, bridge, calls };
  }

  it("registers the new controls as actions (the CSP allows no inline handlers)", async () => {
    const { bridge } = await boot();
    for (const name of [
      "openCategoryPermsModal",
      "openCategoryPermsPicker",
      "saveCategoryPerms",
      "syncChannelPerms",
    ]) {
      expect(typeof bridge.ACTIONS[name], name).toBe("function");
    }
  });

  it("shows the synced badge on a synced channel and a Sync now button on an unsynced categorized one", async () => {
    const { window, bridge } = await boot();
    const html = await bridge.renderChannels();
    const doc = new window.DOMParser().parseFromString(html, "text/html");
    const rowOf = (id: number) => doc.querySelector(`tr[data-channel="${id}"]`)!;

    expect(rowOf(1).textContent).toContain("Synced with category");
    expect(rowOf(1).querySelector('[data-action="syncChannelPerms"]')).toBeNull();

    expect(rowOf(2).textContent).not.toContain("Synced with category");
    const syncBtn = rowOf(2).querySelector('[data-action="syncChannelPerms"]');
    expect(syncBtn?.textContent).toBe("Sync now");

    // An uncategorized channel has nothing to sync with.
    expect(rowOf(3).textContent).not.toContain("Synced with category");
    expect(rowOf(3).querySelector('[data-action="syncChannelPerms"]')).toBeNull();

    // The category header and the picker both open its permission matrix.
    expect(doc.querySelector('[data-action="openCategoryPermsModal"]')).toBeTruthy();
    expect(doc.getElementById("catPermPick")).toBeTruthy();
  });

  it("Sync now posts to the channel's sync route", async () => {
    const { bridge, calls } = await boot();
    await bridge.syncChannelPerms(2, "beta");
    expect(
      calls.some((c) => c.method === "POST" && c.path === "/channels/2/permissions/sync"),
    ).toBe(true);
  });

  it("edits the category template through the category routes, not the channel ones", async () => {
    const { window, bridge, calls } = await boot();
    await bridge.openCategoryPermsModal(7, "Games");
    expect(
      calls.some((c) => c.method === "GET" && c.path === "/channels/categories/7/permissions"),
    ).toBe(true);

    const doc = window.document;
    // The category matrix has no per-channel "preview" (it is a channel route).
    const select = doc.getElementById("permTarget") as HTMLSelectElement;
    select.value = "r:5";
    bridge.renderPermMatrix();
    expect(doc.querySelector('[data-action="previewPermChange"]')).toBeNull();
    expect(doc.querySelector('[data-action="clearPermOverride"]')).toBeTruthy();

    // Deny "Read Messages" (bit 0x2) for Member and save.
    const deny = doc.querySelector('input[data-ovrbit="2"][value="deny"]') as HTMLInputElement;
    deny.checked = true;
    calls.length = 0;
    await bridge.saveCategoryPerms();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/channels/categories/7/permissions/5");
    expect(put?.body).toEqual({ allow: 0, deny: 2 });
  });

  it("an all-inherit row is a delete, and Clear override deletes through the category route", async () => {
    const { window, bridge, calls } = await boot();
    await bridge.openCategoryPermsModal(7, "Games");
    const select = window.document.getElementById("permTarget") as HTMLSelectElement;
    select.value = "r:5";
    bridge.renderPermMatrix();

    calls.length = 0;
    await bridge.saveCategoryPerms();
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(
      "/channels/categories/7/permissions/5",
    );

    await bridge.openCategoryPermsModal(7, "Games");
    (window.document.getElementById("permTarget") as HTMLSelectElement).value = "r:5";
    bridge.renderPermMatrix();
    calls.length = 0;
    await bridge.clearPermOverride();
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(
      "/channels/categories/7/permissions/5",
    );
  });
});
