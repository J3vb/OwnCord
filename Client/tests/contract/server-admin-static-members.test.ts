// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// AO-4, the Members page: search, the role filter and the Banned tab go to the
// server; the tabs and the row overflow menu work from the keyboard; and the
// page never offers an action on your own account or on anyone at or above
// your rank. Server/admin/members_test.go pins the server half of both.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  renderUsers: renderUsers,
  closeModal: closeModal
};
</script>`;
const ADMIN_HTML = adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`);

const ADMINISTRATOR = 0x40000000;
const MANAGE_ROLES = 0x1000000;
const BAN_MEMBERS = 0x80000;

type Responder = (path: string, method: string) => unknown;

interface Bridge {
  state: any;
  renderUsers: () => Promise<string>;
  closeModal: () => void;
}

let dom: JSDOM | undefined;

async function boot(calls: string[], respond: Responder) {
  dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const p = String(input).replace(/^\/admin\/api/, "");
        calls.push(`${method} ${p}`);
        const json = p === "/setup/status" ? { needs_setup: false } : ((await respond(p, method)) ?? {});
        return { ok: true, status: 200, json: async () => json } as Response;
      }) as typeof fetch;
    },
  });
  const settle = (ms = 0) => new Promise((resolve) => dom!.window.setTimeout(resolve, ms));
  await settle();
  calls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  const doc = dom.window.document;
  const show = async (me: Record<string, unknown>) => {
    bridge.state.me = me;
    bridge.state.section = "users";
    doc.getElementById("content")!.innerHTML = await bridge.renderUsers();
  };
  const key = (el: Element, k: string) =>
    el.dispatchEvent(new dom!.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  return { bridge, doc, settle, show, key };
}

const ROLES = [
  { id: 1, name: "Owner", position: 100 },
  { id: 2, name: "Admin", position: 80 },
  { id: 3, name: "Moderator", position: 60 },
  { id: 4, name: "Member", position: 40 },
];

afterEach(() => {
  dom?.window?.close();
  dom = undefined;
});

describe("Server/admin/static — Members (AO-4)", () => {
  it("searches, filters by role and lists bans on the server, keeping focus in the search box", async () => {
    const calls: string[] = [];
    const { doc, settle, show, key } = await boot(calls, (p) => {
      if (p === "/registrations")
        return [{ id: 9, username: "applicant", created_at: "2026-09-01 10:00:00" }];
      if (p === "/roles") return ROLES;
      if (p.startsWith("/users?"))
        return p.includes("q=ali")
          ? [{ id: 5, username: "alice", role_id: 4, role_position: 40 }]
          : [
              { id: 5, username: "alice", role_id: 4, role_position: 40 },
              { id: 6, username: "bob", role_id: 4, role_position: 40 },
            ];
      return {};
    });
    await show({ id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true });
    const users = () => calls.filter((c) => c.startsWith("GET /users?"));

    // Unfiltered: the plain over-fetch, nothing appended.
    expect(users()).toEqual(["GET /users?limit=51&offset=0"]);
    expect(doc.getElementById("membersSummary")!.textContent).toBe("2 members");
    const tabs = [...doc.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["All", "Pending1", "Banned"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");

    // Typing searches the server after a pause and replaces only the list.
    const search = doc.getElementById("membersSearch") as HTMLInputElement;
    search.focus();
    search.value = "ali";
    search.dispatchEvent(new dom!.window.Event("input", { bubbles: true }));
    await settle(300);
    expect(users().at(-1)).toBe("GET /users?limit=51&offset=0&q=ali");
    expect(doc.activeElement).toBe(search);
    expect(doc.querySelectorAll("#membersList tbody tr")).toHaveLength(1);
    expect(doc.getElementById("membersSummary")!.textContent).toBe("1 member match");

    // The role filter is a query parameter too, and goes back to page 1.
    const role = doc.getElementById("membersRole") as HTMLSelectElement;
    expect([...role.options].map((o) => o.textContent)).toEqual([
      "All roles",
      "Owner",
      "Admin",
      "Moderator",
      "Member",
    ]);
    role.value = "3";
    role.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));
    await settle();
    expect(users().at(-1)).toBe("GET /users?limit=51&offset=0&q=ali&role_id=3");

    // Banned is a server filter, not a hidden column; focus stays on the tab.
    (doc.getElementById("membersTab-banned") as HTMLElement).click();
    await settle();
    expect(users().at(-1)).toBe("GET /users?limit=51&offset=0&q=ali&role_id=3&banned=1");
    expect(doc.activeElement?.id).toBe("membersTab-banned");
    expect(doc.getElementById("membersPanel")!.getAttribute("aria-labelledby")).toBe(
      "membersTab-banned",
    );

    // Arrow keys move between tabs (ARIA tabs); Pending lists the applications.
    key(doc.activeElement!, "ArrowLeft");
    await settle();
    expect(doc.activeElement?.id).toBe("membersTab-pending");
    expect(doc.getElementById("membersSearch")).toBeNull();
    expect(doc.getElementById("membersPanel")!.textContent).toContain("applicant");
    expect(doc.querySelector('[data-action="decideRegistration"]')!.textContent).toBe(
      "Approve applicant",
    );
  });

  it("hides the Pending tab from a principal who cannot decide registrations", async () => {
    const calls: string[] = [];
    const { doc, show } = await boot(calls, (p) => (p.startsWith("/users?") ? [] : {}));
    await show({ id: 1, permissions: BAN_MEMBERS, role_position: 60 });
    expect([...doc.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
      "All",
      "Banned",
    ]);
    expect(calls).not.toContain("GET /registrations");
    expect(doc.getElementById("membersSummary")!.textContent).toBe("No members yet");
  });

  it("offers no action on your own account or on anyone at or above your rank", async () => {
    const calls: string[] = [];
    const { doc, settle, show } = await boot(calls, (p) => {
      if (p === "/roles") return ROLES;
      if (p.startsWith("/users?"))
        return [
          { id: 1, username: "me", role_id: 2, role_position: 80 },
          { id: 2, username: "boss", role_id: 1, role_position: 100 },
          { id: 3, username: "peer", role_id: 2, role_position: 80 },
          { id: 4, username: "member", role_id: 4, role_position: 40 },
        ];
      return {};
    });
    // An admin (position 80), not the owner.
    await show({ id: 1, permissions: ADMINISTRATOR, role_position: 80, is_owner: false });

    const more = (id: number) =>
      doc.querySelector(
        `[data-action="toggleMemberMenu"][data-args="[${id}]"]`,
      ) as HTMLButtonElement;
    expect(more(1).disabled).toBe(true);
    expect(more(1).getAttribute("aria-label")).toMatch(/your account/);
    expect(more(2).disabled).toBe(true);
    expect(more(2).getAttribute("aria-label")).toMatch(/at or above yours/);
    expect(more(3).disabled).toBe(true);
    expect(more(4).disabled).toBe(false);
    // Every row keeps its one visible Manage button, so the columns line up.
    expect(doc.querySelectorAll('[data-action="openEditUser"]')).toHaveLength(4);
    expect(doc.querySelector("tbody tr")!.textContent).toContain("You");

    const manage = async (id: number) => {
      (
        doc.querySelector(`[data-action="openEditUser"][data-args^="[${id},"]`) as HTMLElement
      ).click();
      await settle();
      const body = doc.getElementById("modalInner")!;
      const out = { select: !!body.querySelector("#editRoleSelect"), text: body.textContent ?? "" };
      dom!.window.document.getElementById("modal")!.classList.remove("visible");
      return out;
    };
    for (const id of [1, 2, 3]) {
      const m = await manage(id);
      expect(m.select, `row ${id}`).toBe(false);
      expect(m.text, `row ${id}`).toMatch(/cannot/);
    }
    expect((await manage(4)).select).toBe(true);

    // The lower-ranked row's menu is gated like the routes: no recovery
    // credential for a non-owner, erasure behind a separator.
    more(4).click();
    const items = [...doc.querySelectorAll("#memberMenu [role=menuitem]")].map((b) =>
      b.getAttribute("data-action"),
    );
    expect(items).toEqual(["forceLogout", "openBanUser", "openEraseUser"]);
  });

  it("drives the overflow menu from the keyboard and returns focus to its button", async () => {
    const { bridge, doc, settle, show, key } = await boot([], (p) => {
      if (p.startsWith("/users?"))
        return [{ id: 4, username: "member", role_id: 4, role_position: 40 }];
      if (p === "/roles") return ROLES;
      return {};
    });
    await show({
      id: 1,
      permissions: ADMINISTRATOR | MANAGE_ROLES,
      role_position: 100,
      is_owner: true,
    });
    const more = doc.querySelector('[data-action="toggleMemberMenu"]') as HTMLButtonElement;
    const menu = doc.getElementById("memberMenu")!;

    more.focus();
    more.click();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(menu.getAttribute("aria-label")).toBe("Actions for member");
    const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
    expect(items.map((i) => i.textContent)).toEqual([
      "Force logout",
      "Issue recovery credential",
      "Ban",
      "Erase account permanently",
    ]);
    expect(doc.activeElement).toBe(items[0]);
    key(doc.activeElement!, "ArrowDown");
    expect(doc.activeElement).toBe(items[1]);
    key(doc.activeElement!, "ArrowUp");
    key(doc.activeElement!, "ArrowUp");
    expect(doc.activeElement).toBe(items[3]);
    key(doc.activeElement!, "Home");
    expect(doc.activeElement).toBe(items[0]);

    // Escape closes the menu only (no dialog is open) and restores focus.
    key(doc.activeElement!, "Escape");
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement).toBe(more);

    // Choosing an item closes the menu, opens its dialog, and closing the
    // dialog lands back on the menu button, not on a detached item.
    more.click();
    (menu.querySelector('[data-action="openBanUser"]') as HTMLElement).click();
    await settle();
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("modal")!.classList.contains("visible")).toBe(true);
    expect(doc.getElementById("modalInner")!.textContent).toContain("Ban member from the server?");
    bridge.closeModal();
    expect(doc.activeElement).toBe(more);

    // A click elsewhere closes an open menu.
    more.click();
    doc.body.click();
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  it("ignores a late, superseded list response instead of swapping the rows the menus act on", async () => {
    const held: Record<string, (rows: unknown) => void> = {};
    const hold = (q: string) => new Promise((resolve) => (held[q] = resolve));
    const ALL = [
      { id: 5, username: "alice", role_id: 4, role_position: 40 },
      { id: 6, username: "bob", role_id: 4, role_position: 40 },
    ];
    const { doc, settle, show } = await boot([], (p) => {
      if (p === "/roles") return ROLES;
      if (p.includes("banned=1"))
        return [{ id: 7, username: "tempbanned", role_id: 4, role_position: 40, banned: true }];
      if (p.includes("q=zz")) return hold("zz");
      if (p.includes("q=spam")) return hold("spam");
      if (p.startsWith("/users?")) return ALL;
      return {};
    });
    await show({ id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true });
    const search = (v: string) => {
      const box = doc.getElementById("membersSearch") as HTMLInputElement;
      box.value = v;
      box.dispatchEvent(new dom!.window.Event("input", { bubbles: true }));
    };
    const menuOpensFor = (id: number) => {
      const more = doc.querySelector(
        `[data-action="toggleMemberMenu"][data-args="[${id}]"]`,
      ) as HTMLButtonElement;
      more.click();
      const open = !doc.getElementById("memberMenu")!.classList.contains("hidden");
      doc.body.click();
      return open;
    };

    // Search "zz", clear it, and let the "zz" response land last.
    search("zz");
    await settle(300);
    search("");
    await settle(300);
    held.zz!([]);
    await settle();
    expect(doc.querySelectorAll("#membersList tbody tr")).toHaveLength(2);
    expect(menuOpensFor(5)).toBe(true);

    // Search "spam", switch to Banned, and let the search response land last.
    search("spam");
    await settle(300);
    (doc.getElementById("membersTab-banned") as HTMLElement).click();
    await settle();
    held.spam!([]);
    await settle();
    expect(doc.getElementById("membersList")!.textContent).toContain("tempbanned");
    expect(menuOpensFor(7)).toBe(true);
  });
});
