// CONTRACT TEST. The artifact under test is owned by Server/admin; see
// server-admin-static-roles-channels.test.ts for why the runner lives here.
//
// The channel dialogs pick a category from the ones that exist and never ask
// for a position number: a new channel goes last in its category and the
// Channels page reorders with up and down. The upload pages share one themed
// file control.
import { describe, it, expect } from "vitest";
import { adminHtmlWithBridge, loadAdminPanel, type FetchCall } from "../helpers/adminPanelFetch";

const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  renderChannels: renderChannels, openChannelModal: openChannelModal,
  createChannel: createChannel, openChannelEditModal: openChannelEditModal,
  saveChannelEdit: saveChannelEdit, moveChannel: moveChannel, pickFile: pickFile,
  actions: ACTIONS
};
</script>`;
const ADMIN_HTML = adminHtmlWithBridge(BRIDGE);

interface Panel {
  state: { me: unknown; section: string };
  renderChannels: () => Promise<string>;
  openChannelModal: () => void;
  createChannel: () => Promise<void>;
  openChannelEditModal: (id: number) => void;
  saveChannelEdit: (id: number) => Promise<void>;
  moveChannel: (id: number, delta: number) => Promise<void>;
  pickFile: (id: string, accept: string, label: string, opts?: { after?: string }) => string;
  actions: Record<string, (...args: unknown[]) => unknown>;
}

const CHANNELS = [
  { id: 1, name: "rules", type: "text", category: "Info", category_id: 7, position: 0 },
  { id: 2, name: "faq", type: "text", category: "Info", category_id: 7, position: 0 },
  { id: 3, name: "news", type: "text", category: "Info", category_id: 7, position: 4 },
  { id: 4, name: "lobby", type: "text", category: "", position: 2 },
];
const CATEGORIES = [
  { id: 7, name: "Info" },
  { id: 8, name: "Empty one" },
];

async function open(calls: FetchCall[]) {
  const dom = loadAdminPanel(ADMIN_HTML, calls, (p) => ({
    json: p === "/channels" ? CHANNELS : p === "/channels/categories" ? CATEGORIES : {},
  }));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  const panel = (dom.window as unknown as { __test: Panel }).__test;
  panel.state.me = { id: 1, permissions: 0x40000000, role_position: 100, is_owner: true };
  panel.state.section = "channels";
  const doc = dom.window.document;
  doc.getElementById("content")!.innerHTML = await panel.renderChannels();
  calls.length = 0;
  return { dom, doc, panel };
}

const patches = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "PATCH").map((c) => [c.path, c.body]);

describe("Server/admin/static — channel dialogs", () => {
  it("creates a channel from a category list, last in that category, with no position field", async () => {
    const calls: FetchCall[] = [];
    const { doc, panel } = await open(calls);
    panel.openChannelModal();
    const modal = doc.getElementById("modalInner")!;
    expect(modal.querySelector('input[type="number"]')).toBeNull();
    const cat = modal.querySelector<HTMLSelectElement>("select#chCat")!;
    expect([...cat.options].map((o) => o.textContent)).toEqual([
      "No category",
      "Info",
      "Empty one",
      "New category…",
    ]);

    doc.querySelector<HTMLInputElement>("#chName")!.value = "help";
    cat.value = "Info";
    await panel.createChannel();
    const post = calls.find((c) => c.method === "POST" && c.path === "/channels");
    expect(post?.body).toMatchObject({ name: "help", category: "Info", position: 5 });
  });

  it("asks for a name after 'New category…' and sends it", async () => {
    const calls: FetchCall[] = [];
    const { dom, doc, panel } = await open(calls);
    panel.openChannelModal();
    const cat = doc.querySelector<HTMLSelectElement>("#chCat")!;
    const fresh = doc.querySelector<HTMLInputElement>("#chCatNew")!;
    expect(fresh.hidden).toBe(true);
    cat.value = " new";
    cat.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(fresh.hidden).toBe(false);

    doc.querySelector<HTMLInputElement>("#chName")!.value = "clips";
    await panel.createChannel();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fresh.value = "Media";
    await panel.createChannel();
    const post = calls.find((c) => c.method === "POST" && c.path === "/channels");
    expect(post?.body).toMatchObject({ name: "clips", category: "Media", position: 0 });
  });

  it("edits without a position and sends the category only when it changed", async () => {
    const calls: FetchCall[] = [];
    const { doc, panel } = await open(calls);
    panel.openChannelEditModal(2);
    const modal = doc.getElementById("modalInner")!;
    expect(modal.querySelector("#chEditPos")).toBeNull();
    expect(modal.querySelector<HTMLSelectElement>("#chEditCat")!.value).toBe("Info");

    await panel.saveChannelEdit(2);
    const [, body] = patches(calls)[0]!;
    expect(body).not.toHaveProperty("category");
    expect(body).not.toHaveProperty("position");

    calls.length = 0;
    panel.openChannelEditModal(2);
    doc.querySelector<HTMLSelectElement>("#chEditCat")!.value = "";
    await panel.saveChannelEdit(2);
    expect(patches(calls)[0]![1]).toMatchObject({ category: "" });
  });

  // Equal positions are made distinct within the group only; other groups
  // keep theirs, and a channel whose position is already right is not sent.
  it("moves a channel within its category with up and down", async () => {
    const calls: FetchCall[] = [];
    const { doc, panel } = await open(calls);
    const row = (id: number) => doc.querySelector(`tr[data-channel="${id}"]`)!;
    expect(row(1).querySelector<HTMLButtonElement>('[data-focus="chup-1"]')!.disabled).toBe(true);
    expect(row(3).querySelector<HTMLButtonElement>('[data-focus="chdown-3"]')!.disabled).toBe(true);

    await panel.moveChannel(1, 1);
    // rules and faq share position 0: faq keeps it, rules goes to 1.
    expect(patches(calls)).toEqual([["/channels/1", { position: 1 }]]);
    expect(calls.some((c) => c.path === "/channels/4" && c.method === "PATCH")).toBe(false);
  });
});

describe("Server/admin/static — shared file picker", () => {
  it("hides the native input behind a button and names the chosen file", async () => {
    const calls: FetchCall[] = [];
    const { dom, doc, panel } = await open(calls);
    let chosen = 0;
    panel.actions.testFileChosen = () => {
      chosen++;
    };
    const host = doc.createElement("div");
    host.innerHTML = panel.pickFile("probeFile", ".zip", "Probe file", { after: "testFileChosen" });
    doc.body.appendChild(host);
    const input = host.querySelector<HTMLInputElement>("input#probeFile")!;
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".zip");
    expect(input.getAttribute("aria-label")).toBe("Probe file");
    expect(host.querySelector('label[for="probeFile"]')?.textContent).toContain("Choose file");
    expect(host.querySelector("#probeFileName")?.textContent).toBe("No file chosen");

    const file = new dom.window.File(["x"], "plugin.zip");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(host.querySelector("#probeFileName")?.textContent).toBe("plugin.zip");
    expect(chosen).toBe(1);
  });
});
