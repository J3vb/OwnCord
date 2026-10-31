// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
// Continues the panel behaviour tests from authAndInvites.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminIndexHtml } from "../../helpers/admin-panel";
import {
  FetchCall,
  Responder,
  ADMINISTRATOR,
  boot,
  showShell,
  proposedPreview,
} from "../../helpers/serverAdminStaticPanelHarness";

describe("Server/admin/static — panel behaviour", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  // AO-2. The admin CSP is script-src 'self', so the browser refuses an on*=
  // attribute or an inline <script>, and the control it wires silently does
  // nothing. A control names its handler in data-action / data-input-action /
  // data-change-action instead, and core.js dispatches only names registered
  // in ACTIONS; an unregistered name is just as dead. So render what the
  // panel renders — the static document, the setup wizard, every section and
  // the dialogs their buttons open — and check the live DOM.
  it("renders every section and dialog without inline script, naming only registered actions", async () => {
    const served = new JSDOM(adminIndexHtml()).window.document.querySelectorAll("script");
    expect(served.length).toBeGreaterThan(0);
    for (const script of served) expect(script.getAttribute("src")).toBeTruthy();

    const roles = [
      { id: 1, name: "Owner", position: 100, permissions: ADMINISTRATOR },
      { id: 9, name: "Helper", position: 60, permissions: 0 },
      { id: 4, name: "Member", position: 40, permissions: 0, is_default: true },
    ];
    const respond: Responder = (p, method) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/users?"))
        return {
          json: [{ id: 2, username: "member", role_id: 4, status: "online", banned: false }],
        };
      if (p.startsWith("/registrations"))
        return { json: [{ id: 3, username: "applicant", created_at: "2026-09-01 10:00:00" }] };
      if (p === "/roles") return { json: roles };
      if (p === "/channels") return { json: [{ id: 5, name: "general", type: "text" }] };
      if (/^\/channels\/\d+\/permissions$/.test(p)) return { json: { roles: [], users: [] } };
      if (p.startsWith("/audit-log?"))
        return {
          json: [
            {
              id: 1,
              action: "channel_create",
              actor_id: 1,
              actor_name: "owner",
              target_type: "channel",
              target_id: 5,
              created_at: "2026-09-01 10:00:00",
            },
          ],
        };
      if (p === "/tokens")
        return {
          json: [{ id: 1, label: "ci", username: "owner", created_at: "2026-09-01 10:00:00" }],
        };
      if (p === "/backups")
        return { json: [{ name: "owncord.db", size: 4096, date: "2026-09-01T10:00:00Z" }] };
      if (p === "/updates")
        return { json: { current: "1.0.0", latest: "1.1.0", update_available: true } };
      if (p === "/settings") return { json: { server_name: "OwnCord" } };
      if (p === "/retention")
        return {
          json: { server_days: 30, revision: "revision-1", channels: [{ channel_id: 5, days: 0 }] },
        };
      if (p === "/retention/preview") return { json: method === "POST" ? proposedPreview : [] };
      if (p === "/retention/channels") return { json: [{ id: 5, name: "general" }] };
      if (p === "/stats") return { json: { user_count: 2 } };
      if (p === "/api/v1/admin/plugins/")
        return { json: [{ id: 1, name: "hello", version: "1.0.0", enabled: true }] };
      if (p === "/api/v1/emoji/") return { json: [{ id: 1, shortcode: "wave" }] };
      if (p === "/api/v1/invites/")
        return {
          json: [
            {
              id: 1,
              code: "invite-code-1",
              max_uses: 5,
              uses: 1,
              expires_at: null,
              revoked: false,
              created_at: "2026-09-01 10:00:00",
            },
          ],
        };
      if (p === "/api/v1/invites/invite-code-1/redemptions")
        return { json: [{ user_id: 2, username: "redeemer", redeemed_at: "2026-09-01 11:00:00" }] };
      return { json: {} };
    };
    const booted = await boot([], respond);
    dom = booted.dom;
    const { window } = booted.dom;
    const { bridge } = booted;
    const doc = window.document;
    bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true };
    (window as unknown as { EventSource: unknown }).EventSource = class {
      close() {}
    };
    const settle = () => new Promise((resolve) => window.setTimeout(resolve, 0));

    const inline: string[] = [];
    const names = new Set<string>();
    const scan = (where: string) => {
      for (const el of doc.querySelectorAll("*")) {
        for (const attr of el.getAttributeNames()) {
          if (attr.startsWith("on")) inline.push(`${where}: <${el.localName} ${attr}>`);
        }
        for (const attr of ["data-action", "data-input-action", "data-change-action"]) {
          const name = el.getAttribute(attr);
          if (name) names.add(name);
        }
      }
    };
    scan("document");

    for (let step = 0; step < bridge.wizStepCount; step++) {
      bridge.wiz.step = step;
      bridge.renderWizard();
      scan(`setup step ${step}`);
    }

    const content = doc.getElementById("content")!;
    const sections = bridge.nav
      .map((n) => n.id)
      .filter((id): id is string => !!id && id !== "logout");
    expect(sections.length).toBeGreaterThan(10);
    const opened = new Set<string>();
    for (const id of sections) {
      bridge.navigateTo(id);
      await settle();
      const title = content.querySelector(".page-title")?.textContent;
      expect(title, `section ${id}`).toBeTruthy();
      expect(title, `section ${id}`).not.toMatch(/^(Error|Loading\.\.\.)$/);
      scan(`section ${id}`);
      // Row overflow menus (Members) render their items when opened.
      for (const more of content.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]')) {
        more.click();
        scan(`menu in ${id}`);
      }

      const openers = new Set(
        [...content.querySelectorAll("[data-action]")]
          .map((el) => el.getAttribute("data-action")!)
          .filter((name) => /^open|^applyUpdate$/.test(name)),
      );
      for (const name of openers) {
        (content.querySelector(`[data-action="${name}"]`) as HTMLElement).click();
        await settle();
        expect(doc.getElementById("modal")!.classList.contains("visible"), name).toBe(true);
        opened.add(name);
        scan(`dialog ${name}`);
        bridge.closeModal();
      }
    }

    expect(inline).toEqual([]);
    expect([...opened]).toEqual(
      expect.arrayContaining([
        "openEditUser",
        "openBanUser",
        "openRoleModal",
        "openChannelModal",
        "applyUpdate",
        "openCreateTokenModal",
      ]),
    );
    expect(names.size).toBeGreaterThan(70);
    const unregistered = [...names].filter((n) => typeof bridge.actions[n] !== "function");
    expect(unregistered).toEqual([]);
  });

  it("dispatches a delegated click with its data-args", async () => {
    const calls: FetchCall[] = [];
    const users = Array.from({ length: 51 }, (_, i) => ({
      id: i + 2,
      username: "u" + (i + 2),
      role_id: 4,
    }));
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/users?")) return { json: users };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { bridge } = booted;
    bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };
    bridge.state.section = "users";
    const doc = dom.window.document;
    doc.getElementById("content")!.innerHTML = await bridge.renderUsers();
    calls.length = 0;

    // The icon inside the button is the event target; the listener resolves it
    // to the button through closest().
    const next = doc.querySelector('[data-action="turnUsersPage"][data-args="[1]"]')!;
    next.appendChild(doc.createElement("span")).click();
    expect(bridge.state.usersPage).toBe(2);
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
    expect(calls.some((c) => c.path === "/users?limit=51&offset=50")).toBe(true);

    // String arguments survive the attribute round trip, quotes included.
    const erase = doc.createElement("button");
    erase.setAttribute("data-action", "openEraseUser");
    erase.setAttribute("data-args", JSON.stringify([7, `o'brien "x"`]));
    doc.body.appendChild(erase).click();
    expect(doc.getElementById("modalInner")!.textContent).toContain(`o'brien "x"`);
  });

  // OC-0373. The option set is rebuilt from the fetched page while the filter
  // is global, so a filter whose action left the page used to vanish from the
  // control while still filtering the table.
  it("keeps the active action filter in the dropdown when the page no longer contains it", async () => {
    const calls: FetchCall[] = [];
    const entries = [{ id: 1, action: "message_delete", actor_id: 1, target_type: "message" }];
    const respond: Responder = (p, _method) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/audit-log?")) return { json: entries };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };
    booted.bridge.state.auditActionFilter = "channel_delete";

    const html = await booted.bridge.renderAudit();
    expect(html).toContain('<option value="channel_delete" selected>');
    // Selecting "All Actions" must therefore be a real value change.
    expect(html).toContain('<option value="all" >All Actions</option>');
    expect(calls.find((c) => c.path.startsWith("/audit-log?"))?.path).toContain("limit=51");
  });

  // Each label is written for the target the server records with it: a
  // self-target, a target without an id and a numbered object must all leave
  // a complete sentence.
  it("reads every recorded target shape as a complete sentence", async () => {
    const rowsIn: [string, string, number, string?][] = [
      ["session_revoke_all", "user", 1],
      ["setting_change", "setting", 0],
      ["registration_mode_change", "setting", 0],
      ["retention_policy_change", "setting", 0],
      ["role_reorder", "role", 0],
      ["role_create", "role", 5],
      ["message_delete", "message", 55],
      ["session_revoke", "session", 12],
      ["invite_create", "invite", 3],
      ["emoji_delete", "emoji", 5],
      ["api_token_create", "api_token", 3],
      ["api_token_revoke", "api_token", 0],
      ["appeal_assign", "appeal", 3],
      ["appeal_submit", "moderation_action", 4],
      ["permission_preview", "channel", 3],
      ["account_deleted", "user", 0],
      ["plugin_install", "plugin", 0],
      ["voice_mod_kick", "user", 9],
      ["backup_create", "server", 0],
      ["user_ban", "user", 0, "tok"],
    ];
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/audit-log?"))
        return {
          json: rowsIn.map(([action, target_type, target_id, subject_token], i) => ({
            id: rowsIn.length - i,
            action,
            actor_id: 1,
            actor_name: "owner",
            target_type,
            target_id,
            subject_token,
            detail: "",
            created_at: "2020-01-02 10:00:00",
          })),
        };
      return { json: {} };
    };
    const booted = await boot([], respond);
    dom = booted.dom;
    const doc = booted.dom.window.document;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };
    booted.bridge.state.section = "audit";
    doc.getElementById("content")!.innerHTML = await booted.bridge.renderAudit();

    expect(
      [...doc.querySelectorAll("#auditTbody tr.audit-row .audit-what")].map((r) => r.textContent),
    ).toEqual([
      "owner signed out all their sessions",
      "owner changed a server setting",
      "owner changed who can join",
      "owner changed the message retention policy",
      "owner reordered the roles",
      "owner created role #5",
      "owner deleted a message #55",
      "owner signed out a session #12",
      "owner created an invite #3",
      "owner removed an emoji #5",
      "owner created an API token #3",
      "owner revoked an API token",
      "owner took an appeal #3",
      "owner appealed a moderation action #4",
      "owner previewed permissions for channel #3",
      "owner deleted an account",
      "owner installed a plugin",
      "owner disconnected user #9",
      "owner took a backup",
      "owner banned an erased account",
    ]);
  });

  // No row may end on a dangling word, whatever target the server records:
  // an id of 0, an erased account, the actor themselves, a setting or the
  // server. Nor may an actor without a user row read as a bare number.
  it("completes every action's sentence for every target and actor shape", async () => {
    const booted = await boot([], (p) =>
      p === "/setup/status" ? { json: { needs_setup: false } } : { json: {} },
    );
    dom = booted.dom;
    const { bridge } = booted;
    const div = booted.dom.window.document.createElement("div");
    const text = (e: object) => {
      div.innerHTML = bridge.auditSentence(e);
      return div.textContent!;
    };
    const shapes = [
      { target_type: "user", target_id: 0 },
      { target_type: "user", target_id: 0, subject_token: "tok" },
      { target_type: "user", target_id: 1 },
      { target_type: "channel", target_id: 0 },
      { target_type: "role", target_id: 0 },
      { target_type: "setting", target_id: 0 },
      { target_type: "server", target_id: 0 },
      { target_type: "", target_id: 0 },
    ];
    const codes = Object.keys(bridge.actionLabels);
    expect(codes.length).toBeGreaterThan(50);
    for (const action of codes) {
      const label = bridge.actionLabels[action]!;
      for (const shape of shapes) {
        const sentence = text({ action, actor_id: 1, actor_name: "owner", ...shape });
        expect(sentence, action).not.toMatch(/[{}]|\b(of|to|for|on|with|from|at|by)$/);
        if (label.endsWith(" {t}"))
          expect(sentence, action).not.toBe(`owner ${label.slice(0, -4)}`);
      }
    }

    const backup = { action: "backup_create", target_type: "server", target_id: 0 };
    expect(text({ ...backup, actor_id: 0, actor_name: "" })).toBe("The server took a backup");
    expect(
      text({
        action: "identity_key_update",
        actor_id: 0,
        actor_name: "",
        actor_token: "tok",
        target_type: "user",
        target_id: 0,
        subject_token: "tok",
      }),
    ).toBe("An erased account changed their encryption key");
    expect(text({ ...backup, actor_id: 9, actor_name: "" })).toBe("user #9 took a backup");
  });

  // Every client connection writes user_login and ws_connect, so the
  // dashboard's five-row Recent activity would read as sign-ins only.
  it("hides sign-ins and connections from the dashboard's Recent activity", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/audit-log?")) return { json: [] };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };

    await booted.bridge.renderDashboard();
    expect(calls.find((c) => c.path.startsWith("/audit-log?"))?.path).toBe(
      "/audit-log?limit=5&offset=0&hide_signins=1",
    );
  });

  // AO-7. Search and the action filter used to run over the fetched page of
  // 50 only, so an older match was unreachable. They are now GET /audit-log
  // q and action parameters, and a keystroke refetches without re-rendering
  // the search box out from under the operator.
  it("searches the audit log on the server and keeps the search box focused", async () => {
    const calls: FetchCall[] = [];
    const row = (id: number, action: string, detail: string) => ({
      id,
      action,
      actor_id: 1,
      actor_name: "owner",
      target_type: "channel",
      target_id: id,
      detail,
      created_at: "2026-09-01 10:00:00",
    });
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/audit-log?")) {
        const q = new URLSearchParams(p.slice("/audit-log?".length));
        const headers =
          q.get("offset") === "0"
            ? { "X-Audit-Actions": '["channel_delete","role_create","setting_change"]' }
            : undefined;
        if (q.get("q"))
          return { json: [row(3, "channel_delete", "removed #needle & co")], headers };
        return {
          json: Array.from({ length: 51 }, (_, i) => row(100 - i, "setting_change", "motd")),
          headers,
        };
      }
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { window } = booted.dom;
    const doc = window.document;
    showShell(booted.dom);
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };
    booted.bridge.state.section = "audit";
    booted.bridge.state.auditPage = 2;
    doc.getElementById("content")!.innerHTML = await booted.bridge.renderAudit();
    expect(doc.querySelectorAll("#auditTbody tr.audit-row")).toHaveLength(50);

    const search = doc.querySelector<HTMLInputElement>(".filter-search")!;
    expect(search.maxLength).toBe(100);
    search.focus();
    calls.length = 0;
    search.value = "needle & co";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    // Debounced: nothing is fetched on the keystroke itself.
    expect(calls.some((c) => c.path.startsWith("/audit-log?"))).toBe(false);
    await new Promise((resolve) => window.setTimeout(resolve, 350));

    const fetched = calls.find((c) => c.path.startsWith("/audit-log?"))?.path;
    expect(fetched).toBe("/audit-log?limit=51&offset=0&q=needle%20%26%20co&hide_signins=1");
    const rows = doc.querySelectorAll("#auditTbody tr.audit-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("removed #needle & co");
    expect(doc.querySelector(".pagination-info")!.textContent).toBe("Page 1 · 1 matching entry");
    expect(doc.querySelector('.pagination-info[role="status"]')).not.toBeNull();
    // The results were replaced, not the page: the box still has focus.
    expect(doc.activeElement).toBe(search);

    // The action filter is a server parameter too, and restarts at page 1.
    // Its options are every action the server names, not only fetched ones.
    calls.length = 0;
    const select = doc.querySelector<HTMLSelectElement>("#auditAction")!;
    expect([...select.options].map((o) => o.value)).toEqual([
      "all",
      "channel_delete",
      "role_create",
      "setting_change",
    ]);
    select.value = "channel_delete";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(calls.find((c) => c.path.startsWith("/audit-log?"))?.path).toBe(
      "/audit-log?limit=51&offset=0&q=needle%20%26%20co&action=channel_delete&hide_signins=1",
    );
  });

  // UX clarity: each row reads as a sentence with the raw code kept in its
  // tooltip, rows sit under day headings, and sign-in and connection rows are
  // hidden on the server until the Sign-ins chip is pressed or the action
  // filter names one of them.
  it("reads audit rows as sentences and hides sign-ins until asked", async () => {
    const calls: FetchCall[] = [];
    const now = new Date().toISOString();
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/audit-log?")) {
        return {
          json: [
            {
              id: 3,
              action: "channel_delete",
              actor_id: 1,
              actor_name: "owner",
              target_type: "channel",
              target_id: 7,
              detail: "",
              created_at: now,
            },
            {
              id: 2,
              action: "profile_update",
              actor_id: 1,
              actor_name: "owner",
              target_type: "user",
              target_id: 1,
              detail: "",
              created_at: "2020-01-02 10:00:00",
            },
            {
              id: 1,
              action: "made_up_thing",
              actor_id: 2,
              actor_name: "bob",
              target_type: "server",
              target_id: 0,
              detail: "",
              created_at: "2020-01-02 09:00:00",
            },
          ],
          headers: { "X-Audit-Actions": '["channel_delete","user_login"]' },
        };
      }
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { window } = booted.dom;
    const doc = window.document;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };
    booted.bridge.state.section = "audit";
    doc.getElementById("content")!.innerHTML = await booted.bridge.renderAudit();
    expect(calls.find((c) => c.path.startsWith("/audit-log?"))?.path).toBe(
      "/audit-log?limit=51&offset=0&hide_signins=1",
    );

    const rows = [...doc.querySelectorAll("#auditTbody tr.audit-row")];
    expect(rows.map((r) => r.querySelector(".audit-what")!.textContent)).toEqual([
      "owner deleted channel #7",
      "owner updated their profile",
      "bob made up thing",
    ]);
    expect(rows.map((r) => r.getAttribute("title"))).toEqual([
      "channel_delete",
      "profile_update",
      "made_up_thing",
    ]);
    const days = [...doc.querySelectorAll("#auditTbody tr.audit-day")].map((r) => r.textContent);
    expect(days).toHaveLength(2);
    expect(days[0]).toBe("Today");

    const chip = doc.querySelector<HTMLButtonElement>("#auditSignins")!;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    calls.length = 0;
    chip.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(calls.find((c) => c.path.startsWith("/audit-log?"))?.path).toBe(
      "/audit-log?limit=51&offset=0",
    );

    // Filtering on a sign-in action shows it even with the chip off.
    chip.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    calls.length = 0;
    const select = doc.querySelector<HTMLSelectElement>("#auditAction")!;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "All Actions",
      "Channel delete",
      "User login",
    ]);
    select.value = "user_login";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(calls.find((c) => c.path.startsWith("/audit-log?"))?.path).toBe(
      "/audit-log?limit=51&offset=0&action=user_login",
    );
  });

  // A failed page turn used to advance state.auditPage while the old rows
  // stayed on screen, so the next ">" skipped a page. A failure now replaces
  // the rows with the error and a Retry for the page that failed.
  it("shows a failed audit page turn as an error with Retry", async () => {
    const calls: FetchCall[] = [];
    let fail = false;
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/audit-log?")) {
        if (fail) return { status: 500, json: { message: "boom" } };
        return {
          json: Array.from({ length: 51 }, (_, i) => ({ id: 100 - i, action: "setting_change" })),
        };
      }
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { window } = booted.dom;
    const doc = window.document;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };
    booted.bridge.state.section = "audit";
    doc.getElementById("content")!.innerHTML = await booted.bridge.renderAudit();

    fail = true;
    doc.querySelector<HTMLButtonElement>('[data-action="turnAuditPage"][data-args="[1]"]')!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(booted.bridge.state.auditPage).toBe(1);
    expect(booted.bridge.state.auditCache).toEqual([]);
    expect(doc.querySelectorAll("#auditTbody tr")).toHaveLength(0);
    expect(doc.querySelector('#auditResults [role="alert"]')!.textContent).toBe("boom");

    fail = false;
    calls.length = 0;
    doc.querySelector<HTMLButtonElement>('#auditResults [data-action="reloadAudit"]')!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(calls.find((c) => c.path.startsWith("/audit-log?"))?.path).toContain("offset=50");
    expect(booted.bridge.state.auditPage).toBe(2);
    expect(doc.querySelectorAll("#auditTbody tr.audit-row")).toHaveLength(50);
  });

  // A failed search used to leave the old query's rows on screen; and a page
  // turn has to use the query the controls show, even while a search is
  // still pending.
  it("keeps the audit rows and pager on the query the controls show", async () => {
    const calls: FetchCall[] = [];
    let fail = false;
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/audit-log?")) {
        if (fail) return { status: 500, json: { message: "boom" } };
        return {
          json: Array.from({ length: 51 }, (_, i) => ({ id: 100 - i, action: "setting_change" })),
          headers: { "X-Audit-Actions": '["channel_delete",7,"setting_change"]' },
        };
      }
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { window } = booted.dom;
    const doc = window.document;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };
    booted.bridge.state.section = "audit";
    doc.getElementById("content")!.innerHTML = await booted.bridge.renderAudit();
    const select = doc.querySelector<HTMLSelectElement>("#auditAction")!;
    expect([...select.options].map((o) => o.value)).toEqual([
      "all",
      "channel_delete",
      "setting_change",
    ]);

    const search = doc.querySelector<HTMLInputElement>(".filter-search")!;
    search.value = "foo";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    calls.length = 0;
    doc.querySelector<HTMLButtonElement>('[data-action="turnAuditPage"][data-args="[1]"]')!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(calls.find((c) => c.path.startsWith("/audit-log?"))?.path).toBe(
      "/audit-log?limit=51&offset=50&q=foo&hide_signins=1",
    );

    fail = true;
    select.value = "channel_delete";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(booted.bridge.state.auditActionFilter).toBe("channel_delete");
    expect(booted.bridge.state.auditCache).toEqual([]);
    expect(doc.querySelectorAll("#auditTbody tr")).toHaveLength(0);
    expect(doc.querySelector('#auditResults [role="alert"]')).not.toBeNull();

    fail = false;
    calls.length = 0;
    doc.querySelector<HTMLButtonElement>('#auditResults [data-action="reloadAudit"]')!.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(calls.find((c) => c.path.startsWith("/audit-log?"))?.path).toBe(
      "/audit-log?limit=51&offset=0&q=foo&action=channel_delete&hide_signins=1",
    );
  });
});
