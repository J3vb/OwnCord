// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// Companion to server-admin-static-channel-perms.test.ts, covering the panel
// behaviour that a text-level assertion cannot reach: what the sign-in handler
// does with a two-factor challenge, how a timestamp is parsed, whether a
// lapsed ban still reads as banned, whether the next-page button lies, what
// Create Role prefills, and whether "/" is swallowed inside the field it
// focuses. Server/admin/panel_wiring_test.go greps the same file for the
// wiring; these tests run it.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

const ADMIN_HTML_PATH = path.resolve(__dirname, "../../../Server/admin/static/index.html");
const ADMIN_HTML_SOURCE = readFileSync(ADMIN_HTML_PATH, "utf8");

// The page's <script> is a classic script: its top-level declarations live in
// the window's shared script scope but never land on `window`. A second script
// bridges the bindings these tests drive onto a test-only global.
const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  utcDate: utcDate,
  effectiveBan: effectiveBan,
  myPosition: myPosition,
  renderUsers: renderUsers,
  renderAudit: renderAudit,
  openRoleModal: openRoleModal,
  renderRetention: renderRetention,
  saveChannelRetention: saveChannelRetention,
  clearChannelRetention: clearChannelRetention,
  applyRetention: applyRetention
};
</script>`;
if (!ADMIN_HTML_SOURCE.includes("</body>")) {
  throw new Error("expected Server/admin/static/index.html to contain </body>");
}
const ADMIN_HTML = ADMIN_HTML_SOURCE.replace("</body>", `${BRIDGE}\n</body>`);

interface FetchCall {
  method: string;
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/* eslint-disable  @typescript-eslint/no-explicit-any */
interface Bridge {
  state: any;
  utcDate: (s: string) => Date;
  effectiveBan: (u: any) => boolean;
  myPosition: () => number;
  renderUsers: () => Promise<string>;
  renderAudit: () => Promise<string>;
  openRoleModal: (id: number | null) => void;
  renderRetention: () => Promise<string>;
  saveChannelRetention: (id: number) => Promise<void>;
  clearChannelRetention: (id: number) => Promise<void>;
  applyRetention: (days: number) => Promise<void>;
}

type Responder = (path: string, method: string) => { status?: number; json?: unknown };

const ADMINISTRATOR = 0x40000000;

function loadAdminPanel(calls: FetchCall[], respond: Responder): JSDOM {
  return new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const p = String(input).replace(/^\/admin\/api/, "");
        let body: unknown;
        if (typeof opts.body === "string") {
          try {
            body = JSON.parse(opts.body);
          } catch {
            body = opts.body;
          }
        }
        calls.push({
          method,
          url: String(input),
          path: p,
          body,
          headers: (opts.headers as Record<string, string>) ?? {},
        });
        const r = respond(p, method);
        const status = r.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => r.json ?? {},
        } as Response;
      }) as typeof fetch;
    },
  });
}

async function boot(
  calls: FetchCall[],
  respond: Responder,
): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const dom = loadAdminPanel(calls, respond);
  // Let the page's own bootstrap (checkAuth -> GET /setup/status) settle.
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  calls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  return { dom, bridge };
}

const defaultRespond: Responder = (p) => {
  if (p === "/setup/status") return { json: { needs_setup: false } };
  return { json: {} };
};

describe("Server/admin/static/index.html — panel behaviour", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  // OC-0350. POST /api/v1/auth/login answers a TOTP account with 200,
  // {partial_token, requires_2fa:true} and NO token. Before the fix the
  // handler assigned d.token (undefined), wrote the string "undefined" into
  // localStorage, and every retry ended at a false "session expired".
  it("completes a two-factor sign-in through /auth/verify-totp (OC-0350)", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/api/v1/auth/login")
        return { json: { requires_2fa: true, partial_token: "PARTIAL-123" } };
      if (p === "/api/v1/auth/verify-totp") return { json: { token: "SESSION-XYZ" } };
      if (p === "/me")
        return { json: { id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true } };
      if (p === "/stats") return { json: {} };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { window } = booted.dom;
    const doc = window.document;

    (doc.getElementById("loginUser") as HTMLInputElement).value = "owner";
    (doc.getElementById("loginPass") as HTMLInputElement).value = "hunter22";
    await (doc.getElementById("loginBtn") as unknown as { onclick: () => Promise<void> }).onclick();

    // The token-less response must not be stored, and the panel must ask for
    // the code rather than pretending the session expired.
    expect(window.localStorage.getItem("admin_token")).toBeNull();
    expect(doc.getElementById("loginTotpStep")?.className).not.toContain("hidden");
    expect(doc.getElementById("loginStep1")?.className).toContain("hidden");
    expect(doc.getElementById("loginErr")?.textContent).toBe("");

    (doc.getElementById("loginTotp") as HTMLInputElement).value = "123456";
    await (doc.getElementById("totpBtn") as unknown as { onclick: () => Promise<void> }).onclick();

    const verify = calls.find((c) => c.path === "/api/v1/auth/verify-totp");
    expect(verify).toBeTruthy();
    expect(verify?.method).toBe("POST");
    // The partial token is what authorises the second leg (Server/api/
    // totp_handler.go reads it as the bearer token).
    expect(verify?.headers.Authorization).toBe("Bearer PARTIAL-123");
    expect(verify?.body).toEqual({ code: "123456" });
    expect(window.localStorage.getItem("admin_token")).toBe("SESSION-XYZ");
    expect(booted.bridge.state.partialToken).toBe("");
  });

  it("keeps the challenge alive after a rejected code, then clears it on Back (OC-0350)", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/api/v1/auth/login")
        return { json: { requires_2fa: true, partial_token: "PARTIAL-123" } };
      if (p === "/api/v1/auth/verify-totp")
        return { status: 401, json: { message: "invalid two-factor code" } };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const doc = booted.dom.window.document;

    (doc.getElementById("loginUser") as HTMLInputElement).value = "owner";
    (doc.getElementById("loginPass") as HTMLInputElement).value = "hunter22";
    await (doc.getElementById("loginBtn") as unknown as { onclick: () => Promise<void> }).onclick();

    (doc.getElementById("loginTotp") as HTMLInputElement).value = "000000";
    await (doc.getElementById("totpBtn") as unknown as { onclick: () => Promise<void> }).onclick();

    // The code is single-use; the challenge is not. A retry has to keep working.
    expect(doc.getElementById("loginErr")?.textContent).toBe("invalid two-factor code");
    expect(booted.bridge.state.partialToken).toBe("PARTIAL-123");
    expect(doc.getElementById("loginTotpStep")?.className).not.toContain("hidden");

    (doc.getElementById("totpCancelBtn") as unknown as { onclick: () => void }).onclick();
    expect(booted.bridge.state.partialToken).toBe("");
    expect(doc.getElementById("loginStep1")?.className).not.toContain("hidden");
  });

  // OC-0331. SQLite datetime('now') is naive UTC; new Date() reads that
  // non-ISO form as local time.
  it("parses a naive SQLite timestamp as UTC, and leaves a zoned one alone (OC-0331)", async () => {
    const booted = await boot([], defaultRespond);
    dom = booted.dom;
    const { utcDate } = booted.bridge;

    expect(utcDate("2026-03-19 08:29:41").getTime()).toBe(Date.UTC(2026, 2, 19, 8, 29, 41));
    expect(utcDate("2026-03-19T08:29:41Z").getTime()).toBe(Date.UTC(2026, 2, 19, 8, 29, 41));
    expect(utcDate("2026-03-19T10:29:41+02:00").getTime()).toBe(Date.UTC(2026, 2, 19, 8, 29, 41));
  });

  // OC-0364. Nothing clears users.banned when a temporary ban lapses; expiry
  // is decided lazily everywhere else.
  it("treats a lapsed temporary ban as not banned (OC-0364)", async () => {
    const booted = await boot([], defaultRespond);
    dom = booted.dom;
    const { effectiveBan } = booted.bridge;

    expect(effectiveBan({ banned: false })).toBe(false);
    expect(effectiveBan({ banned: true })).toBe(true);
    expect(effectiveBan({ banned: true, ban_expires: "2020-01-01T00:00:00Z" })).toBe(false);
    // SQLite's space-separated, zone-less form is UTC, like the rest.
    expect(effectiveBan({ banned: true, ban_expires: "2020-01-01 00:00:00" })).toBe(false);
    expect(effectiveBan({ banned: true, ban_expires: "2999-01-01T00:00:00Z" })).toBe(true);
  });

  // OC-0361 and OC-0390 and OC-0364, over one rendered Users page.
  it("does not offer a next page for an exactly-full page, and offers erasure apart from force-logout (OC-0361, OC-0390)", async () => {
    const calls: FetchCall[] = [];
    const users = Array.from({ length: 50 }, (_, i) => ({
      id: i + 2,
      username: "u" + (i + 2),
      role_id: 4,
      status: "offline",
      banned: false,
    }));
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/users?")) return { json: users };
      if (p === "/registrations") return { json: [] };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };

    const html = await booted.bridge.renderUsers();

    // limit+1, the way MessageService.GetMessages asks.
    const usersCall = calls.find((c) => c.path.startsWith("/users?"));
    expect(usersCall?.path).toContain("limit=51");
    // 50 rows came back for a 51-row request, so this is the last page.
    expect(html).toContain('onclick="state.usersPage++;renderContent()"');
    expect(html).toMatch(/<button class="page-btn" disabled onclick="state\.usersPage\+\+/);

    // OC-0390: erasure is reachable, and not adjacent to Force Logout.
    expect(html).toContain("openEraseUser(2,");
    const row = html.slice(
      html.indexOf("openEraseUser(2,") - 800,
      html.indexOf("openEraseUser(2,"),
    );
    expect(row).toContain("forceLogout(2)");
    expect(row.slice(row.indexOf("forceLogout(2)"))).toContain("<span style=");
  });

  it("offers a next page when an overflow row comes back (OC-0361)", async () => {
    const calls: FetchCall[] = [];
    const users = Array.from({ length: 51 }, (_, i) => ({
      id: i + 2,
      username: "u" + (i + 2),
      role_id: 4,
      status: "offline",
      banned: false,
    }));
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/users?")) return { json: users };
      if (p === "/registrations") return { json: [] };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };

    const html = await booted.bridge.renderUsers();
    expect(html).toMatch(/<button class="page-btn" {2}onclick="state\.usersPage\+\+/);
    // The overflow row is fetched, never rendered.
    expect(html).not.toContain("openEraseUser(52,");
  });

  // OC-0373. The option set is rebuilt from the fetched page while the filter
  // is global, so a filter whose action left the page used to vanish from the
  // control while still filtering the table.
  it("keeps the active action filter in the dropdown when the page no longer contains it (OC-0373)", async () => {
    const calls: FetchCall[] = [];
    const entries = [{ id: 1, action: "message_delete", actor_id: 1, target_type: "message" }];
    const respond: Responder = (p) => {
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

  // OC-0367. CreateRole refuses an explicitly requested position that is
  // taken, and the slot below the actor is the one the previous new role got.
  it("prefills Create Role with the highest free position below the actor (OC-0367)", async () => {
    const booted = await boot([], defaultRespond);
    dom = booted.dom;
    const doc = booted.dom.window.document;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };
    booted.bridge.state.roleList = [
      { id: 1, name: "Owner", position: 100, permissions: 0 },
      { id: 9, name: "Helper", position: 99, permissions: 0 },
      { id: 4, name: "Member", position: 40, permissions: 0, is_default: true },
    ];

    booted.bridge.openRoleModal(null);
    expect((doc.getElementById("rolePos") as HTMLInputElement).value).toBe("98");

    // Editing an existing role still shows that role's own position.
    booted.bridge.openRoleModal(9);
    expect((doc.getElementById("rolePos") as HTMLInputElement).value).toBe("99");
  });

  // OC-0355. The hotkey used to preventDefault whenever a .filter-search
  // existed, including while the caret sat inside that very field.
  it('lets "/" be typed into a text field and still jumps there from outside (OC-0355)', async () => {
    const booted = await boot([], defaultRespond);
    dom = booted.dom;
    const { window } = booted.dom;
    const doc = window.document;

    const content = doc.getElementById("content") as HTMLElement;
    content.innerHTML = '<input class="filter-search">';
    const field = doc.querySelector(".filter-search") as HTMLInputElement;

    const inside = new window.KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(inside);
    expect(inside.defaultPrevented).toBe(false);

    const outside = new window.KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    });
    doc.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(field);
  });

  // OC-0389. Four mounted retention routes and the retention_days setting had
  // no caller at all, so a policy that continuously and irreversibly deletes
  // message history could be neither set, inspected, overridden nor
  // previewed.
  it("renders the policy with its effect preview and drives all four retention routes (OC-0389)", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/retention")
        return {
          json: {
            server_days: 30,
            channels: [{ channel_id: 7, days: 0, updated_by: 1, updated_at: "" }],
          },
        };
      if (p === "/retention/preview")
        return {
          json: [
            {
              channel_id: 5,
              channel_name: "general",
              days: 30,
              source: "server",
              cutoff: "2026-08-04T00:00:00Z",
              would_delete: 1234,
            },
          ],
        };
      if (p === "/channels")
        return {
          json: [
            { id: 5, name: "general", type: "text" },
            { id: 7, name: "archive", type: "text" },
            { id: 9, name: "dm", type: "dm" },
          ],
        };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };

    const html = await booted.bridge.renderRetention();

    // The preview is the point of the page: the operator sees the effect.
    // toLocaleString groups per the runner's locale, so match either form.
    expect(html).toMatch(/<strong>1[.,]?234<\/strong>/);
    expect(html).toContain("This cannot be undone");
    // The server window is shown and editable.
    expect(html).toContain('id="retentionDays"');
    expect(html).toContain("30 days");
    // A channel override reads as its own source; 0 means kept forever.
    expect(html).toContain("Kept forever");
    expect(html).toContain(">channel<");
    expect(html).toContain(">server<");
    // DMs are never in scope, so they are not offered a policy.
    expect(html).not.toContain("openChannelRetention(9,");
    expect(html).toContain("openChannelRetention(5,");
    expect(html).toContain("clearChannelRetention(7)");

    // PUT, DELETE and the server-wide PATCH all reach the mounted routes.
    booted.bridge.state.retentionPolicyChannels = [{ channel_id: 5, days: 0 }];
    const doc = booted.dom.window.document;
    doc.getElementById("modalInner")!.innerHTML = '<input id="chRetDays" value="14">';
    await booted.bridge.saveChannelRetention(5);
    expect(
      calls.find((c) => c.path === "/channels/5/retention" && c.method === "PUT")?.body,
    ).toEqual({ days: 14 });

    await booted.bridge.clearChannelRetention(7);
    expect(calls.some((c) => c.path === "/channels/7/retention" && c.method === "DELETE")).toBe(
      true,
    );

    await booted.bridge.applyRetention(90);
    expect(calls.find((c) => c.path === "/settings" && c.method === "PATCH")?.body).toEqual({
      retention_days: "90",
    });
  });
});
