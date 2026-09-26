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
  renderRoles: renderRoles,
  saveRole: saveRole,
  openDeleteChannel: openDeleteChannel,
  confirmDeleteChannel: confirmDeleteChannel,
  openDeleteRole: openDeleteRole,
  confirmDeleteRole: confirmDeleteRole,
  renderChannelPermsModal: renderChannelPermsModal
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
  renderRoles: () => Promise<string>;
  saveRole: (id: number | null) => Promise<void>;
  openDeleteChannel: (id: number, name: string) => void;
  confirmDeleteChannel: (id: number, name: string) => Promise<void>;
  openDeleteRole: (id: number) => void;
  confirmDeleteRole: (id: number) => Promise<void>;
  renderChannelPermsModal: () => void;
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
  respond: (p: string) => unknown = () => ({}),
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
        const json = p === "/setup/status" ? { needs_setup: false } : respond(p);
        return { ok: true, status: 200, json: async () => json ?? {} } as Response;
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

describe("Server/admin/static — Roles and Channels (AO-5)", () => {
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
      body: { name: "Helper", color: "", permissions: 0, position: 70 },
    });
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

  it("does not count the role being edited against itself", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;

    bridge.openRoleModal(2); // Admin, at 80
    const line = doc.getElementById("rolePlacement")!;
    expect(line.className).not.toContain("is-error");
    expect(line.textContent).toContain("This role will outrank Moderator.");
    expect(line.textContent).not.toContain("outrank Admin");
  });

  it("shows every permission's description as readable text tied to its checkbox (U14)", async () => {
    const booted = await boot([]);
    dom = booted.dom;
    const { bridge, doc } = booted;
    // A role manager without Administrator: Administrator is locked for them.
    bridge.state.me = { id: 5, permissions: MANAGE_ROLES, role_position: 90 };

    bridge.openRoleModal(null);
    const boxes = [...doc.querySelectorAll<HTMLInputElement>("#modalInner input[data-permbit]")];
    expect(boxes.length).toBe(20);
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
    expect(legends.map((l) => l.textContent)).toEqual(["General", "Text", "Voice", "Moderation"]);
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
    expect(items[3]!.textContent).toContain("12 of 20 permissions");
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
});
