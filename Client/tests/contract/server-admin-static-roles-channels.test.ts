// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// AO-5, Roles and Channels: the rank ladder, the new-role placement warning,
// the permission descriptions a keyboard user can read, the typed-name delete
// confirmation, and the channel access drawer's three tabs. Controls are
// driven through their data-action wiring where the DOM allows it, so a
// broken registration fails here too.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const ADMIN_HTML_SOURCE = adminPanelHtml();

// Classic-script bindings never land on `window`; bridge the ones driven here.
const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  openRoleModal: openRoleModal,
  applyRolePreset: applyRolePreset,
  renderRoles: renderRoles,
  moveRole: moveRole,
  saveRole: saveRole,
  openDeleteChannel: openDeleteChannel,
  confirmDeleteChannel: confirmDeleteChannel,
  openDeleteRole: openDeleteRole,
  confirmDeleteRole: confirmDeleteRole,
  renderChannelPermsModal: renderChannelPermsModal,
  renderChannels: renderChannels
};
</script>`;
if (!ADMIN_HTML_SOURCE.includes("</body>")) {
  throw new Error("expected Server/admin/static/index.html to contain </body>");
}
const ADMIN_HTML = ADMIN_HTML_SOURCE.replace("</body>", `${BRIDGE}\n</body>`);

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

interface Bridge {
  state: any;
  openRoleModal: (id: number | null) => void;
  applyRolePreset: (id: string) => void;
  renderRoles: () => Promise<string>;
  moveRole: (id: number, delta: number) => Promise<void>;
  saveRole: (id: number | null) => Promise<void>;
  openDeleteChannel: (id: number, name: string) => void;
  confirmDeleteChannel: (id: number, name: string) => Promise<void>;
  openDeleteRole: (id: number) => void;
  confirmDeleteRole: (id: number) => Promise<void>;
  renderChannelPermsModal: () => void;
  renderChannels: () => Promise<string>;
}

const ADMINISTRATOR = 0x40000000;
const MANAGE_ROLES = 0x1000000;

// The four seeded roles (Server/migrations/001_initial_schema.sql).
const SEEDED = [
  { id: 1, name: "Owner", position: 100, permissions: 0x7fffffff, member_count: 1 },
  { id: 2, name: "Admin", position: 80, permissions: 0x3fffffff, member_count: 0 },
  { id: 3, name: "Moderator", position: 60, permissions: 0xfffff, member_count: 0 },
  { id: 4, name: "Member", position: 40, permissions: 0x663, member_count: 0, is_default: true },
];

async function boot(
  calls: FetchCall[],
  respond: (p: string, method: string) => unknown = () => ({}),
  status: (p: string, method: string) => number = () => 200,
): Promise<{ dom: JSDOM; bridge: Bridge; doc: Document }> {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const p = String(input).replace(/^\/admin\/api/, "");
        const body = typeof opts.body === "string" ? JSON.parse(opts.body) : undefined;
        calls.push({ method, path: p, body });
        const json = p === "/setup/status" ? { needs_setup: false } : respond(p, method);
        const code = status(p, method);
        return { ok: code < 400, status: code, json: async () => json ?? {} } as Response;
      }) as typeof fetch;
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  calls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true };
  bridge.state.roleList = SEEDED.map((r) => ({ ...r }));
  return { dom, bridge, doc: dom.window.document };
}

/** Sets a field the way typing does, so its data-input-action runs. */
function type(doc: Document, id: string, value: string): void {
  const el = doc.getElementById(id) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new doc.defaultView!.Event("input", { bubbles: true }));
}

describe("Server/admin/static — Roles and Channels", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("warns before Create that the default placement outranks Admin and Moderator (U13)", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openRoleModal(null);
    // The prefill is still the server's walk-down (OC-0367)...
    expect((doc.getElementById("rolePos") as HTMLInputElement).value).toBe("99");
    // ...and the line under it says what that means.
    const line = doc.getElementById("rolePlacement")!;
    expect(line.className).toContain("is-warn");
    expect(line.textContent).toContain("This role will outrank Admin and Moderator.");
    expect(line.textContent).toContain("Sits between Owner (100) and Admin (80).");
    // The default role is not "outranked": every role sits above it by design.
    expect(line.textContent).not.toMatch(/outrank[^.]*Member/);

    // One click moves it to the everyday slot just above the default role.
    const place = line.querySelector('[data-action="placeRoleAboveDefault"]') as HTMLButtonElement;
    expect(place.textContent).toBe("Place just above Member (41)");
    place.click();
    expect((doc.getElementById("rolePos") as HTMLInputElement).value).toBe("41");
    expect(line.className).not.toContain("is-warn");
    expect(line.textContent).toBe("Sits between Moderator (60) and Member (40).");

    // Typing a position updates the line live.
    type(doc, "rolePos", "70");
    expect(line.textContent).toContain("This role will outrank Moderator.");
    expect(line.textContent).toContain("Sits between Admin (80) and Moderator (60).");

    (doc.getElementById("roleName") as HTMLInputElement).value = "Helper";
    await bridge.saveRole(null);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/roles",
      body: {
        name: "Helper",
        color: "",
        permissions: 0,
        position: 70,
        hoist: false,
        mentionable: false,
      },
    });
  });

  it("offers hoist and mentionable on the create form and sends both", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openRoleModal(null);
    const hoist = doc.getElementById("roleHoist") as HTMLInputElement;
    const mention = doc.getElementById("roleMentionable") as HTMLInputElement;
    expect(hoist.type).toBe("checkbox");
    expect(mention.type).toBe("checkbox");
    expect(hoist.checked).toBe(false);
    expect(mention.checked).toBe(false);
    expect(doc.querySelector('label[for="roleHoist"]')!.textContent).toContain("separately");
    expect(doc.querySelector('label[for="roleMentionable"]')!.textContent).toContain("@mention");

    (doc.getElementById("roleName") as HTMLInputElement).value = "Helper";
    hoist.checked = true;
    mention.checked = true;
    await bridge.saveRole(null);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/roles",
      body: { hoist: true, mentionable: true },
    });
  });

  it("loads each flag into the edit form and sends the changed one", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const { bridge, doc } = booted;
    bridge.state.roleList[2].hoist = true; // Moderator is hoisted, not mentionable

    bridge.openRoleModal(3);
    const hoist = doc.getElementById("roleHoist") as HTMLInputElement;
    const mention = doc.getElementById("roleMentionable") as HTMLInputElement;
    expect(hoist.checked).toBe(true);
    expect(mention.checked).toBe(false);

    mention.checked = true;
    await bridge.saveRole(3);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "/roles/3",
      body: { hoist: true, mentionable: true },
    });
  });

  it("sends the mask it loaded with a role edit", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openRoleModal(3); // Moderator, loaded with 0xfffff
    // The roster moves under the editor: the sent value is the loaded one.
    bridge.state.roleList[2].permissions = 0x1;
    (doc.querySelector('input[data-permbit="1"]') as HTMLInputElement).checked = false;
    await bridge.saveRole(3);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "/roles/3",
      body: { expected_permissions: 0xfffff },
    });
  });

  it("explains a refused edit and reloads the role instead of overwriting it", async () => {
    const calls: FetchCall[] = [];
    const latest = SEEDED.map((r) => (r.id === 3 ? { ...r, permissions: 0x3 } : { ...r }));
    const booted = await boot(
      calls,
      (_p, method) =>
        method === "GET"
          ? latest
          : {
              error: "ROLE_CONFLICT",
              message: "conflict: role permissions changed since it was loaded",
            },
      (_p, method) => (method === "PATCH" ? 409 : 200),
    );
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openRoleModal(3);
    await bridge.saveRole(3);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /roles/3", "GET /roles"]);
    expect(doc.getElementById("toast")!.textContent).toContain(
      "Someone else changed this role. The latest version is loaded; apply your change again.",
    );
    // The editor is open again on the latest mask, not closed on a lost edit.
    const bit1 = doc.querySelector('input[data-permbit="1"]') as HTMLInputElement;
    expect(bit1.checked).toBe(true);
    expect((doc.querySelector('input[data-permbit="131072"]') as HTMLInputElement).checked).toBe(
      false,
    );
    expect(bridge.state.roleEditLoadedPerms).toBe(0x3);
  });

  it("refuses a taken or out-of-reach position before sending it", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openRoleModal(null);
    (doc.getElementById("roleName") as HTMLInputElement).value = "Helper";
    const line = doc.getElementById("rolePlacement")!;

    type(doc, "rolePos", "60");
    expect(line.className).toContain("is-error");
    expect(line.textContent).toBe("Position 60 is already used by Moderator. Pick a free number.");
    await bridge.saveRole(null);

    type(doc, "rolePos", "100");
    expect(line.textContent).toBe("Must be below your own rank of 100.");
    await bridge.saveRole(null);

    expect(calls).toEqual([]);
    expect(doc.getElementById("toast")!.textContent).toContain(
      "Must be below your own rank of 100.",
    );
  });

  it("does not warn when editing a role at its current position", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openRoleModal(2); // Admin, at 80
    const line = doc.getElementById("rolePlacement")!;
    expect(line.className).toBe("rank-placement");
    expect(line.textContent).toBe("Sits between Owner (100) and Moderator (60).");
    expect(line.querySelector('[data-action="placeRoleAboveDefault"]')).toBeNull();
  });

  it("warns on edit only when the new position newly outranks a role, with no one-click move", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openRoleModal(3); // Moderator, at 60
    const line = doc.getElementById("rolePlacement")!;

    type(doc, "rolePos", "70");
    expect(line.className).toBe("rank-placement");
    expect(line.textContent).toBe("Sits between Admin (80) and Member (40).");

    type(doc, "rolePos", "90");
    expect(line.className).toContain("is-warn");
    expect(line.textContent).toContain("This role will outrank Admin.");
    expect(line.textContent).not.toMatch(/outrank[^.]*Moderator/);
    expect(line.querySelector('[data-action="placeRoleAboveDefault"]')).toBeNull();
  });

  it("does not paint the ladder over a page the user navigated to mid-reorder", async () => {
    let release!: (roles: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const booted = await boot([], (p) => (p === "/roles" ? pending : {}));
    dom = booted.dom;
    const { bridge, doc } = booted;
    bridge.state.section = "roles";
    const content = doc.getElementById("content")!;

    const move = bridge.moveRole(3, 1);
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
    bridge.state.section = "channels";
    content.innerHTML = "<p>Channels page</p>";
    release(SEEDED);
    await move;

    expect(content.textContent).toBe("Channels page");
  });

  it("shows every permission's description as readable text tied to its checkbox (U14)", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;
    // A role manager without Administrator: Administrator is locked for them.
    bridge.state.me = { id: 5, permissions: MANAGE_ROLES, role_position: 90 };

    bridge.openRoleModal(null);
    const boxes = [...doc.querySelectorAll<HTMLInputElement>("#modalInner input[data-permbit]")];
    expect(boxes.length).toBe(30);
    for (const box of boxes) {
      const name = doc.getElementById(box.getAttribute("aria-labelledby")!);
      const desc = doc.getElementById(box.getAttribute("aria-describedby")!);
      expect(name?.textContent, box.dataset.permbit).toBeTruthy();
      expect(desc?.textContent?.length, box.dataset.permbit).toBeGreaterThan(8);
      expect(box.closest(".perm-item")!.hasAttribute("title")).toBe(false);
    }
    const admin = doc.querySelector<HTMLInputElement>(`input[data-permbit="${ADMINISTRATOR}"]`)!;
    expect(admin.disabled).toBe(true);
    expect(doc.getElementById(admin.getAttribute("aria-describedby")!)!.textContent).toContain(
      "Locked: your own role does not have this permission.",
    );
    // Each group is a named fieldset.
    const legends = [...doc.querySelectorAll("#modalInner fieldset.perm-group > legend")];
    expect(legends.map((l) => l.textContent)).toEqual([
      "General",
      "Text",
      "Voice",
      "Moderation",
      "Owner powers",
    ]);
  });

  // WP 8.4b: Move Members is owner/Administrator-only to change.
  it("greys the Move Members box with a reason unless the viewer is the owner or an Administrator", async () => {
    const MOVE_MEMBERS = 0x2000;
    const move = (doc: Document) =>
      doc.querySelector<HTMLInputElement>(`input[data-permbit="${MOVE_MEMBERS}"]`)!;
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;

    // A role manager who holds Move Members themself still cannot change it.
    bridge.state.me = { id: 5, permissions: MANAGE_ROLES | MOVE_MEMBERS, role_position: 90 };
    bridge.openRoleModal(null);
    expect(move(doc).disabled).toBe(true);
    expect(move(doc).title).toBe("Only the owner or an Administrator can change this");
    expect(doc.getElementById(`permDesc${MOVE_MEMBERS}`)!.textContent).toContain(
      "Only the owner or an Administrator can change this.",
    );
    // Another locked box keeps its own reason and has no such title.
    const admin = doc.querySelector<HTMLInputElement>(`input[data-permbit="${ADMINISTRATOR}"]`)!;
    expect(admin.title).toBe("");

    // An Administrator can.
    bridge.state.me = { id: 2, permissions: ADMINISTRATOR, role_position: 80 };
    bridge.openRoleModal(null);
    expect(move(doc).disabled).toBe(false);
    expect(move(doc).title).toBe("");

    // So can the owner.
    bridge.state.me = { id: 1, permissions: MANAGE_ROLES, role_position: 100, is_owner: true };
    bridge.openRoleModal(null);
    expect(move(doc).disabled).toBe(false);
  });

  // WP 8.4c: Manage Backups is owner/Administrator-only to change, like Move Members.
  it("greys the Manage Backups box unless the viewer is the owner or an Administrator", async () => {
    const MANAGE_BACKUPS = 0x4000;
    const box = (doc: Document) =>
      doc.querySelector<HTMLInputElement>(`input[data-permbit="${MANAGE_BACKUPS}"]`)!;
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.state.me = { id: 5, permissions: MANAGE_ROLES | MANAGE_BACKUPS, role_position: 90 };
    bridge.openRoleModal(null);
    expect(box(doc).disabled).toBe(true);
    expect(box(doc).title).toBe("Only the owner or an Administrator can change this");
    expect(doc.getElementById(`permDesc${MANAGE_BACKUPS}`)!.textContent).toContain(
      "only the owner can grant",
    );

    bridge.state.me = { id: 2, permissions: ADMINISTRATOR, role_position: 80 };
    bridge.openRoleModal(null);
    expect(box(doc).disabled).toBe(false);

    bridge.state.me = { id: 1, permissions: MANAGE_ROLES, role_position: 100, is_owner: true };
    bridge.openRoleModal(null);
    expect(box(doc).disabled).toBe(false);
    expect(doc.getElementById("modalInner")!.textContent).toContain(
      "Owner powers start with nobody: the owner grants each one by hand.",
    );
  });

  // WP 8.4d: the five owner-tier bits are the owner's alone to change; an
  // Administrator sees them locked. View Diagnostics / Erase Accounts keep the
  // owner-or-Administrator rule.
  it("locks the owner-tier boxes for everyone but the owner, and the Administrator tier for non-admins", async () => {
    const OWNER_TIER = [0x8000, 0x4, 0x8, 0x10, 0x80];
    const ADMIN_TIER = [0x100, 0x10000000];
    const box = (doc: Document, bit: number) =>
      doc.querySelector<HTMLInputElement>(`input[data-permbit="${bit}"]`)!;
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.state.me = { id: 2, permissions: ADMINISTRATOR, role_position: 80 };
    bridge.openRoleModal(null);
    for (const bit of OWNER_TIER) {
      expect(box(doc, bit).disabled).toBe(true);
      expect(box(doc, bit).title).toBe("Only the owner can change this");
    }
    for (const bit of ADMIN_TIER) expect(box(doc, bit).disabled).toBe(false);

    bridge.state.me = { id: 5, permissions: MANAGE_ROLES, role_position: 90 };
    bridge.openRoleModal(null);
    for (const bit of [...OWNER_TIER, ...ADMIN_TIER]) expect(box(doc, bit).disabled).toBe(true);

    bridge.state.me = { id: 1, permissions: MANAGE_ROLES, role_position: 100, is_owner: true };
    bridge.openRoleModal(null);
    for (const bit of [...OWNER_TIER, ...ADMIN_TIER]) expect(box(doc, bit).disabled).toBe(false);
  });

  const ticked = (doc: Document): number[] =>
    [...doc.querySelectorAll<HTMLInputElement>("#modalInner input[data-permbit]")]
      .filter((b) => b.checked)
      .map((b) => Number(b.dataset.permbit))
      .sort((a, b) => a - b);
  const maskOf = (...bits: number[]): number[] => [...bits].sort((a, b) => a - b);
  const BASE = [0x1, 0x2, 0x20, 0x40, 0x200, 0x400, 0x800, 0x1000];

  it("offers four role presets that replace the ticked boxes and leave name and colour alone", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;
    bridge.openRoleModal(null);

    const buttons = [...doc.querySelectorAll<HTMLButtonElement>('[data-action="applyRolePreset"]')];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Super admin",
      "Server manager",
      "Moderator",
      "Voice moderator",
    ]);
    type(doc, "roleName", "Night shift");
    (doc.getElementById("roleNoColor") as HTMLInputElement).checked = false;
    type(doc, "roleColor", "#112233");
    const click = (label: string) => buttons.find((b) => b.textContent === label)!.click();

    click("Super admin");
    expect(ticked(doc)).toEqual(maskOf(...BASE, ADMINISTRATOR));
    // A second preset REPLACES the first one's boxes.
    click("Server manager");
    expect(ticked(doc)).toEqual(
      maskOf(...BASE, 0x2000000, 0x20000, 0x4000000, 0x8000000), // server, channels, invites, audit
    );
    click("Moderator");
    expect(ticked(doc)).toEqual(
      maskOf(...BASE, 0x10000, 0x40000, 0x80000, 0x100000, 0x400000, 0x800000, 0x8000000),
    );
    click("Voice moderator");
    expect(ticked(doc)).toEqual(maskOf(...BASE, 0x100000, 0x2000));

    expect((doc.getElementById("roleName") as HTMLInputElement).value).toBe("Night shift");
    expect((doc.getElementById("roleColor") as HTMLInputElement).value).toBe("#112233");
    expect((doc.getElementById("roleNoColor") as HTMLInputElement).checked).toBe(false);
    expect(doc.getElementById("rolePresetNote")!.textContent).not.toContain("Not applied");

    // Still editable afterwards.
    const send = doc.querySelector<HTMLInputElement>('input[data-permbit="1"]')!;
    send.checked = false;
    expect(ticked(doc)).not.toContain(1);
  });

  it("keeps a locked ticked box the preset would clear and names it", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;
    // Edit Moderator (0xfffff, carries Manage Backups at 0x4000) as a role
    // manager who is not the owner: the box is locked and ticked.
    bridge.state.me = { id: 5, permissions: MANAGE_ROLES | 0x1 | 0x2, role_position: 90 };
    bridge.openRoleModal(3);
    expect(ticked(doc)).toContain(0x4000);
    bridge.applyRolePreset("voice");
    expect(ticked(doc)).toContain(0x4000);
    const note = doc.getElementById("rolePresetNote")!.textContent!;
    expect(note).toContain("Kept: ");
    expect(note).toContain("Manage Backups (only the owner can change it)");
  });

  it("leaves bits the viewer cannot grant unticked and names them", async () => {
    const MANAGE_SERVER = 0x2000000;
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;
    // A role manager who holds Manage Server and Move Members but is neither
    // the owner nor an Administrator.
    bridge.state.me = {
      id: 5,
      permissions: MANAGE_ROLES | MANAGE_SERVER | 0x2000 | 0x100000 | 0x1 | 0x2,
      role_position: 90,
    };
    bridge.openRoleModal(null);

    bridge.applyRolePreset("voice");
    expect(ticked(doc)).toEqual(maskOf(0x1, 0x2, 0x100000));
    const note = doc.getElementById("rolePresetNote")!.textContent!;
    expect(note).toContain("Not applied: ");
    expect(note).toContain("Move Members (only the owner can grant)");

    bridge.applyRolePreset("super");
    expect(ticked(doc)).toEqual(maskOf(0x1, 0x2));
    expect(doc.getElementById("rolePresetNote")!.textContent).toContain(
      "Administrator (your own role does not have it)",
    );
  });

  it("hints under Move Members that giving it to the default role locks role changes to the owner", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;
    const hint = () => doc.getElementById("permHint8192");

    bridge.openRoleModal(4); // Member, the default role
    expect(hint()?.textContent).toBe(
      "Giving this to the default role means only the owner or an Administrator can change members' roles.",
    );
    bridge.openRoleModal(3); // Moderator
    expect(hint()).toBeNull();
    bridge.openRoleModal(null);
    expect(hint()).toBeNull();
  });

  it("draws roles as a ladder split at the caller's own rank", async () => {
    const booted = await boot([], (p) => (p === "/roles" ? SEEDED : {}));
    dom = booted.dom;
    const { bridge, doc } = booted;
    bridge.state.me = { id: 2, permissions: ADMINISTRATOR, role_position: 80 };

    const holder = doc.createElement("div");
    holder.innerHTML = await bridge.renderRoles();
    const items = [...holder.querySelectorAll("ol.rank-ladder > li")];
    expect(items.map((li) => li.className)).toEqual([
      "rank-rung is-above",
      "rank-rung is-above",
      "rank-divider",
      "rank-rung",
      "rank-rung",
    ]);
    expect(items[1]!.textContent).toContain("your role");
    expect(items[0]!.textContent).toContain("above you");
    expect(items[2]!.textContent).toContain("Your rank · 80");
    expect(items[3]!.textContent).toContain("20 of 30 permissions");
    expect(items[0]!.textContent).toContain("Administrator: every permission");
    const moves = [...items[3]!.querySelectorAll('[data-action="moveRole"]')];
    expect(moves.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Move Moderator up",
      "Move Moderator down",
    ]);
    // Moderator is the top of the manageable slice, so it cannot move up.
    expect((moves[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("deletes a channel only after its name is typed", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openDeleteChannel(5, "general");
    const btn = doc.getElementById("typedConfirmBtn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await bridge.confirmDeleteChannel(5, "general");
    type(doc, "typedConfirm", "genera");
    expect(btn.disabled).toBe(true);
    type(doc, "typedConfirm", "General");
    expect(btn.disabled).toBe(true);
    expect(calls).toEqual([]);

    type(doc, "typedConfirm", "general");
    expect(btn.disabled).toBe(false);
    btn.click();
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
    expect(calls[0]).toEqual({ method: "DELETE", path: "/channels/5", body: undefined });
  });

  it("deletes a role only after its name is typed", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openDeleteRole(3);
    expect(doc.getElementById("typedConfirmBtn")!.hasAttribute("disabled")).toBe(true);
    await bridge.confirmDeleteRole(3);
    expect(calls).toEqual([]);

    type(doc, "typedConfirm", "Moderator");
    await bridge.confirmDeleteRole(3);
    expect(calls[0]).toEqual({ method: "DELETE", path: "/roles/3", body: undefined });
  });

  it("opens channel access as a drawer whose tabs keep unsaved edits", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;
    const win = dom.window;

    bridge.state.permChannel = {
      id: 42,
      name: "general",
      roles: [{ role_id: 4, role_name: "Member", permissions: 0x663, allow: 0, deny: 0 }],
      users: [],
      allUsers: [{ id: 7, username: "alice" }],
      tab: "access",
    };
    bridge.renderChannelPermsModal();
    expect(doc.querySelector("#modalInner > .drawer")).toBeTruthy();

    const tabs = [...doc.querySelectorAll<HTMLElement>('#modalInner [role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["Access", "Overrides", "Explain"]);
    const shown = () =>
      [...doc.querySelectorAll<HTMLElement>('#modalInner [role="tabpanel"]')]
        .filter((p) => !p.hidden)
        .map((p) => p.id);
    expect(shown()).toEqual(["chPanel-access"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);

    (doc.getElementById("permRole4") as HTMLInputElement).checked = false;

    const key = (el: HTMLElement, k: string) =>
      el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }));
    tabs[0]!.focus();
    key(tabs[0]!, "ArrowRight");
    expect(shown()).toEqual(["chPanel-overrides"]);
    expect(doc.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    key(tabs[1]!, "End");
    expect(shown()).toEqual(["chPanel-explain"]);
    key(tabs[2]!, "ArrowRight");
    expect(shown()).toEqual(["chPanel-access"]);
    tabs[1]!.click();
    expect(shown()).toEqual(["chPanel-overrides"]);
    key(tabs[1]!, "Home");
    expect(shown()).toEqual(["chPanel-access"]);

    // The Access edit made before switching tabs is still there to save.
    expect((doc.getElementById("permRole4") as HTMLInputElement).checked).toBe(false);
  });
  // UX clarity: channels read like the client sidebar, grouped under their
  // category with the type as a named icon; Archived shows only on a channel
  // that is, and the lock says what it opens.
  it("groups channels by category with type icons and an archived-only badge", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls, (p) =>
      p === "/channels"
        ? [
            { id: 1, name: "rules", type: "announcement", category: "Info" },
            { id: 2, name: "lobby", type: "text", category: "" },
            { id: 3, name: "hangout", type: "voice", category: "", archived: true },
            { id: 4, name: "faq", type: "text", category: "Info" },
            { id: 5, name: "stage", type: "voice", category: "Voice" },
            { id: 6, name: "offtopic", type: "text", category: "" },
          ]
        : {},
    );
    dom = booted.dom;
    const { bridge, doc } = booted;
    const host = doc.createElement("div");
    host.innerHTML = await bridge.renderChannels();

    const rows = [...host.querySelectorAll(".ch-tbl tbody tr")].map((r) =>
      r.classList.contains("ch-cat")
        ? `[${r.textContent}]`
        : r.querySelector("strong")?.textContent,
    );
    // The client's getChannelsByCategory: an uncategorised voice channel joins
    // the Voice group, and groups follow their first channel's order.
    expect(rows).toEqual([
      "[Info]",
      "rules",
      "faq",
      "[No category]",
      "lobby",
      "offtopic",
      "[Voice]",
      "hangout",
      "stage",
    ]);

    const row = (id: number) => host.querySelector(`tr[data-channel="${id}"]`)!;
    expect(row(3).querySelector(".ch-type .sr-only")?.textContent).toBe("Voice channel");
    expect(row(1).querySelector(".ch-type .sr-only")?.textContent).toBe("Announcement channel");
    expect(row(3).querySelector(".badge")?.textContent).toBe("Archived");
    expect(row(2).querySelector(".badge")).toBeNull();
    expect(
      row(2).querySelector('[data-action="openChannelPermsModal"]')?.getAttribute("aria-label"),
    ).toBe("Who can see #lobby");
    expect([...host.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "Channel",
      "Actions",
    ]);
  });

  // Category names are free text, so one named after an Object.prototype key
  // groups like any other, and each group is its own row group.
  it("groups any category name, each under a rowgroup heading", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls, (p) =>
      p === "/channels"
        ? [
            { id: 1, name: "a", type: "text", category: "constructor" },
            { id: 2, name: "b", type: "text", category: "__proto__" },
            { id: 3, name: "c", type: "text", category: "constructor" },
          ]
        : {},
    );
    dom = booted.dom;
    const { bridge, doc } = booted;
    const host = doc.createElement("div");
    host.innerHTML = await bridge.renderChannels();

    const groups = [...host.querySelectorAll(".ch-tbl tbody")].map((tb) => {
      const th = tb.querySelector("tr.ch-cat th")!;
      return {
        heading: th.textContent,
        scope: th.getAttribute("scope"),
        rows: [...tb.querySelectorAll("strong")].map((s) => s.textContent),
      };
    });
    expect(groups).toEqual([
      { heading: "constructor", scope: "rowgroup", rows: ["a", "c"] },
      { heading: "__proto__", scope: "rowgroup", rows: ["b"] },
    ]);
    expect(bridge.state.channelCategories).toEqual(["__proto__", "constructor"]);
  });
});
