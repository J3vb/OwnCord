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
import { adminIndexHtml, adminPanelHtml } from "../helpers/admin-panel";
import path from "node:path";

const ADMIN_HTML_SOURCE = adminPanelHtml();

// The panel's scripts are classic scripts: their top-level declarations live in
// the window's shared script scope but never land on `window`. A second script
// bridges the bindings these tests drive onto a test-only global.
const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  utcDate: utcDate,
  effectiveBan: effectiveBan,
  myPosition: myPosition,
  renderUsers: renderUsers,
  renderInvites: renderInvites,
  openInviteRedemptions: openInviteRedemptions,
  renderAudit: renderAudit,
  renderDashboard: renderDashboard,
  auditSentence: auditSentence,
  actionLabels: ACTION_LABEL,
  renderTokens: renderTokens,
  downloadArchive: downloadArchive,
  openRoleModal: openRoleModal,
  renderRetention: renderRetention,
  saveChannelRetention: saveChannelRetention,
  clearChannelRetention: clearChannelRetention,
  openApplyRetention: openApplyRetention,
  closeModal: closeModal,
  applyRetention: applyRetention,
  navigateTo: navigateTo,
  enterApp: enterApp,
  nav: NAV,
  wiz: wiz,
  wizStepCount: WIZ_STEP_COUNT,
  renderWizard: renderWizard,
  actions: ACTIONS
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
  renderInvites: () => Promise<string>;
  openInviteRedemptions: (code: string, uses?: number) => Promise<void>;
  renderAudit: () => Promise<string>;
  renderDashboard: () => Promise<string>;
  auditSentence: (e: any) => string;
  actionLabels: Record<string, string>;
  renderTokens: () => Promise<string>;
  downloadArchive: () => Promise<void>;
  openRoleModal: (id: number | null) => void;
  renderRetention: () => Promise<string>;
  saveChannelRetention: (id: number) => Promise<void>;
  clearChannelRetention: (id: number) => Promise<void>;
  openApplyRetention: () => Promise<void>;
  closeModal: () => void;
  applyRetention: () => Promise<void>;
  navigateTo: (id: string) => void;
  enterApp: () => Promise<void>;
  nav: { id?: string }[];
  wiz: { step: number };
  wizStepCount: number;
  renderWizard: () => void;
  actions: Record<string, unknown>;
}

type Responder = (
  path: string,
  method: string,
) => { status?: number; json?: unknown; headers?: Record<string, string> };

const proposedPreview = {
  token: "signed-preview",
  revision: "revision-1",
  observed_at: "2026-09-23T12:30:00Z",
  would_delete: 42,
  affected_channels: 1,
  protected_pinned: 2,
  protected_indefinite: 3,
  protected_direct_messages: 4,
  channels: [
    {
      channel_id: 7,
      channel_name: "archive <script>",
      days: 30,
      source: "server",
      would_delete: 42,
      protected_pinned: 2,
      protected_indefinite: 0,
    },
  ],
};

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
          headers: new Headers(r.headers),
          json: async () => r.json ?? {},
          text: async () => JSON.stringify(r.json ?? {}),
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

// Sign-in is a real <form>: submit it the way Enter or the button does, then
// let the handler's fetch chain (mocked, so microtasks only) run out.
async function submitForm(doc: Document, id: string): Promise<void> {
  (doc.getElementById(id) as HTMLFormElement).requestSubmit();
  const win = doc.defaultView!;
  for (let i = 0; i < 5; i++) await new Promise((resolve) => win.setTimeout(resolve, 0));
}

const defaultRespond: Responder = (p) => {
  if (p === "/setup/status") return { json: { needs_setup: false } };
  return { json: {} };
};

describe("Server/admin/static — panel behaviour", () => {
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
    const respond: Responder = (p, method) => {
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
    await submitForm(doc, "loginStep1");

    // The token-less response must not be stored, and the panel must ask for
    // the code rather than pretending the session expired.
    expect(window.localStorage.getItem("admin_token")).toBeNull();
    expect(doc.getElementById("loginTotpStep")?.className).not.toContain("hidden");
    expect(doc.getElementById("loginStep1")?.className).toContain("hidden");
    expect(doc.getElementById("loginErr")?.textContent).toBe("");

    (doc.getElementById("loginTotp") as HTMLInputElement).value = "123456";
    await submitForm(doc, "loginTotpStep");

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
    const respond: Responder = (p, method) => {
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
    await submitForm(doc, "loginStep1");

    (doc.getElementById("loginTotp") as HTMLInputElement).value = "000000";
    await submitForm(doc, "loginTotpStep");

    // The code is single-use; the challenge is not. A retry has to keep working.
    expect(doc.getElementById("loginErr")?.textContent).toBe("Invalid two-factor code");
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

  // OC-0331. The API Tokens table renders naive-UTC created_at / last_used
  // through fmtLocal: local text, the UTC instant in the tooltip.
  it("renders token timestamps as UTC instants (OC-0331)", async () => {
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/tokens")
        return {
          json: [
            {
              id: 1,
              label: "ci",
              username: "owner",
              created_at: "2026-09-01 10:00:00",
              last_used: "2026-09-02 11:30:00",
            },
          ],
        };
      return { json: {} };
    };
    const booted = await boot([], respond);
    dom = booted.dom;
    const doc = booted.dom.window.document;
    doc.getElementById("content")!.innerHTML = await booted.bridge.renderTokens();
    const cells = doc.querySelectorAll("tbody tr td");
    expect(cells[2]!.querySelector("span")!.title).toBe("2026-09-01T10:00:00.000Z");
    expect(cells[3]!.querySelector("span")!.title).toBe("2026-09-02T11:30:00.000Z");
  });

  // The full archive can be tens of gigabytes, so the panel must not fetch it
  // into a Blob. It asks for a single-use link with its Bearer auth and opens
  // that link as a plain navigation, so the browser streams it to disk.
  it("downloads the full archive through a single-use link, never a Blob", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p, method) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/archive/link" && method === "POST")
        return { json: { path: "/admin/api/archive/download?token=TOK-1" } };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { window } = booted.dom;
    booted.bridge.state.me = {
      id: 1,
      permissions: ADMINISTRATOR,
      role_position: 100,
      is_owner: true,
    };
    booted.bridge.state.token = "SESSION";
    // Capture the anchor the handler clicks instead of letting jsdom navigate.
    const clicked: string[] = [];
    window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.href);
    };

    await booted.bridge.downloadArchive();

    expect(calls.some((c) => c.path === "/archive/link" && c.method === "POST")).toBe(true);
    expect(clicked).toEqual(["http://localhost:8080/admin/api/archive/download?token=TOK-1"]);
    // The archive body itself was never fetched into the page.
    expect(calls.some((c) => c.path === "/archive" && c.method === "GET")).toBe(false);
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
    const respond: Responder = (p, method) => {
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
    expect(html).toContain('data-action="turnUsersPage" data-args="[1]"');
    expect(html).toMatch(
      /<button class="page-btn" disabled data-action="turnUsersPage" data-args="\[1\]"/,
    );

    // OC-0390: erasure is reachable from the row's overflow menu, and a
    // separator keeps it apart from Force Logout.
    const doc = booted.dom.window.document;
    doc.getElementById("content")!.innerHTML = html;
    (doc.querySelector('[data-action="toggleMemberMenu"][data-args="[2]"]') as HTMLElement).click();
    const menu = doc.getElementById("memberMenu")!;
    const items = [...menu.children].map(
      (el) => el.getAttribute("data-action") ?? el.getAttribute("role"),
    );
    expect(items).toContain("openEraseUser");
    expect(items.indexOf("forceLogout")).toBeLessThan(items.indexOf("separator"));
    expect(items.indexOf("separator")).toBe(items.indexOf("openEraseUser") - 1);
    expect(menu.querySelector('[data-action="openEraseUser"]')!.getAttribute("data-args")).toMatch(
      /^\[2,/,
    );
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
    const respond: Responder = (p, method) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p.startsWith("/users?")) return { json: users };
      if (p === "/registrations") return { json: [] };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };

    const html = await booted.bridge.renderUsers();
    expect(html).toMatch(
      /<button class="page-btn" {2}data-action="turnUsersPage" data-args="\[1\]"/,
    );
    // The overflow row is fetched, never rendered.
    expect(html).not.toContain('data-action="openEraseUser" data-args="[52,');
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
      if (p === "/registrations")
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
  it("keeps the active action filter in the dropdown when the page no longer contains it (OC-0373)", async () => {
    const calls: FetchCall[] = [];
    const entries = [{ id: 1, action: "message_delete", actor_id: 1, target_type: "message" }];
    const respond: Responder = (p, method) => {
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
  it("searches the audit log on the server and keeps the search box focused (AO-7)", async () => {
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
  it("shows a failed audit page turn as an error with Retry (AO-7)", async () => {
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
  it("keeps the audit rows and pager on the query the controls show (AO-7)", async () => {
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

  // O1. The setup wizard promises invites can be managed "later in the admin
  // panel"; before this, the panel had no invite page, and invites.redeemed_by
  // was never written, so a leaked code could not be traced to its redeemer.
  it("manages invites and shows a redemption history per code (O1)", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/api/v1/invites/")
        return {
          json: [
            {
              id: 1,
              code: "leaked-code",
              max_uses: 5,
              uses: 2,
              expires_at: null,
              revoked: false,
              created_at: "2026-09-01 10:00:00",
            },
          ],
        };
      if (p === "/api/v1/invites/leaked-code/redemptions")
        return {
          json: [
            { user_id: 2, username: "alice", redeemed_at: "2026-09-01 11:00:00" },
            { user_id: null, username: "", redeemed_at: "2026-09-01 12:00:00" },
          ],
        };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { window } = booted.dom;
    const doc = window.document;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };

    // The section renders and lists the invite.
    const html = await booted.bridge.renderInvites();
    expect(html).toContain("leaked-code");
    expect(html).toContain("2 / 5 uses");

    // Opening the history shows the redeemer and marks the erased one.
    await booted.bridge.openInviteRedemptions("leaked-code");
    expect(doc.getElementById("modal")!.classList.contains("visible")).toBe(true);
    const modal = doc.getElementById("modalInner")!.textContent!;
    expect(modal).toContain("alice");
    expect(modal).toContain("Account erased");
    expect(modal).not.toContain("not listed");

    // Uses the history does not cover (redeemed before tracking existed, or
    // past the listing cap) are counted, never reported as "not redeemed".
    await booted.bridge.openInviteRedemptions("leaked-code", 5);
    expect(doc.getElementById("modalInner")!.textContent).toContain("3 of 5 uses are not listed");
    await booted.bridge.openInviteRedemptions("legacy-code", 3);
    const legacy = doc.getElementById("modalInner")!.textContent!;
    expect(legacy).toContain("3 of 3 uses are not listed");
    expect(legacy).not.toContain("has not been redeemed yet");

    // The row button hands the invite's use count to the history.
    const content = doc.getElementById("content")!;
    booted.bridge.state.section = "invites";
    content.innerHTML = html;
    const args = content
      .querySelector('[data-action="openInviteRedemptions"]')!
      .getAttribute("data-args");
    expect(JSON.parse(args!)).toEqual(["leaked-code", 2]);

    // Create sends the form's limits as a JSON body.
    (doc.getElementById("inviteMaxUses") as HTMLInputElement).value = "3";
    (doc.getElementById("inviteExpiry") as HTMLInputElement).value = "48";
    calls.length = 0;
    await (booted.bridge.actions.createInvite as () => Promise<void>)();
    const create = calls.find((c) => c.method === "POST");
    expect(create?.path).toBe("/api/v1/invites/");
    expect(create?.body).toEqual({ max_uses: 3, expires_in_hours: 48 });
    expect(create?.headers["Content-Type"]).toBe("application/json");

    // Revoke deletes the code on the member API.
    calls.length = 0;
    await (booted.bridge.actions.confirmRevokeInvite as (c: string) => Promise<void>)(
      "leaked-code",
    );
    expect(
      calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/invites/leaked-code"),
    ).toBe(true);
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
  it("preserves the saved-policy preview and confirms all retention writes (OC-0389, RI-08)", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p, method) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/retention")
        return {
          json: {
            server_days: 30,
            revision: "revision-1",
            channels: [{ channel_id: 7, days: 0, updated_by: 1, updated_at: "" }],
          },
        };
      if (p === "/retention/preview" && method === "POST") return { json: proposedPreview };
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
    expect(html).not.toContain('data-action="openChannelRetention" data-args="[9,');
    expect(html).toContain('data-action="openChannelRetention" data-args="[5,');
    expect(html).toContain('data-action="clearChannelRetention" data-args="[7]"');

    // Every edit previews first, then explicit confirmation reaches its route.
    booted.bridge.state.retentionPolicyChannels = [{ channel_id: 5, days: 0 }];
    const doc = booted.dom.window.document;
    doc.getElementById("modalInner")!.innerHTML = '<input id="chRetDays" value="14">';
    await booted.bridge.saveChannelRetention(5);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await booted.bridge.applyRetention();
    expect(
      calls.find((c) => c.path === "/channels/5/retention" && c.method === "PUT")?.body,
    ).toEqual({ days: 14 });

    await booted.bridge.clearChannelRetention(7);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(doc.getElementById("modalInner")!.textContent).toContain(
      "removal of keep-forever protection",
    );
    await booted.bridge.applyRetention();
    expect(calls.some((c) => c.path === "/channels/7/retention" && c.method === "DELETE")).toBe(
      true,
    );

    // Each apply re-renders #content without awaiting it; let that settle so
    // it cannot replace the input below mid-preview.
    await new Promise((resolve) => booted.dom.window.setTimeout(resolve, 0));
    doc.getElementById("content")!.innerHTML = '<input id="retentionDays" value="90">';
    await booted.bridge.openApplyRetention();
    await booted.bridge.applyRetention();
    expect(calls.find((c) => c.path === "/settings" && c.method === "PATCH")?.body).toEqual({
      retention_days: "90",
    });
  });
  it("states channel counts only from the full channel list, in agreeing verb form", async () => {
    let channelsReadable = true;
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/retention")
        return {
          json: {
            server_days: 0,
            revision: "revision-1",
            channels: [{ channel_id: 7, days: 30, updated_by: 1, updated_at: "" }],
          },
        };
      if (p === "/retention/preview") return { json: [] };
      if (p === "/channels")
        return channelsReadable
          ? {
              json: [
                { id: 5, name: "general", type: "text" },
                { id: 7, name: "archive", type: "text" },
              ],
            }
          : { status: 403, json: { message: "forbidden" } };
      return { json: {} };
    };
    const booted = await boot([], respond);
    dom = booted.dom;
    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, role_position: 100 };

    const full = await booted.bridge.renderRetention();
    expect(full).toContain("1 channel follows this; 1 channel has its own rule.");
    expect(full).toContain("Show all 2 channels");

    channelsReadable = false;
    const partial = await booted.bridge.renderRetention();
    expect(partial).toContain("1 channel has its own rule; every other channel follows this.");
    expect(partial).not.toContain("0 channels follow");
    expect(partial).not.toContain("Show all");
    expect(partial).toContain("Show listed channels");
  });
  it("binds the confirmation to the proposed window and shows its observation and exclusions", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls, (p) =>
      p === "/retention/preview" ? { json: proposedPreview } : { json: { needs_setup: false } },
    );
    dom = booted.dom;
    const { bridge } = booted;
    const doc = dom.window.document;
    bridge.state.retentionRevision = "revision-1";
    doc.getElementById("content")!.innerHTML = '<input id="retentionDays" value="14">';
    await bridge.openApplyRetention();
    expect(calls.find((c) => c.method === "POST" && c.path === "/retention/preview")?.body).toEqual(
      { proposed: { scope: "server", days: 14 }, revision: "revision-1" },
    );
    const modal = doc.getElementById("modalInner")!;
    expect(modal.textContent).toContain("42 messages");
    expect(modal.textContent).toContain(
      "2 pinned messages, 3 messages kept indefinitely, and 4 direct messages",
    );
    expect(modal.textContent).toContain(proposedPreview.observed_at);
    expect(modal.textContent).toContain("14 days");
    expect(modal.querySelector("script")).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await bridge.applyRetention();
    const apply = calls.find((c) => c.method === "PATCH");
    expect(apply?.body).toEqual({ retention_days: "14" });
    expect(apply?.headers["X-Retention-Preview"]).toBe("signed-preview");
  });

  it("requires another preview after edits, cancellation, or a failed preview", async () => {
    const calls: FetchCall[] = [];
    let failed = false;
    const booted = await boot(calls, (p) =>
      p === "/retention/preview"
        ? failed
          ? { status: 500, json: { message: "Cannot count messages" } }
          : { json: proposedPreview }
        : { json: { needs_setup: false } },
    );
    dom = booted.dom;
    const { bridge } = booted;
    const doc = dom.window.document;
    bridge.state.retentionRevision = "revision-1";
    doc.getElementById("content")!.innerHTML = '<input id="retentionDays" value="14">';
    await bridge.openApplyRetention();
    (doc.getElementById("retentionDays") as HTMLInputElement).value = "1";
    await bridge.applyRetention();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await bridge.openApplyRetention();
    bridge.closeModal();
    await bridge.applyRetention();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    failed = true;
    await bridge.openApplyRetention();
    expect(doc.getElementById("modalInner")!.textContent).toContain("Cannot count messages");
    expect(doc.getElementById("applyRetentionPreview")).toBeNull();
    await bridge.applyRetention();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it.each([409, 403])(
    "shows apply rejection (%s) and requires a reload and new preview",
    async (status) => {
      const calls: FetchCall[] = [];
      const message =
        status === 409
          ? "Retention policy changed; reload and preview again. Nothing was saved."
          : "MANAGE_SERVER permission required";
      const booted = await boot(calls, (p, method) =>
        method === "DELETE"
          ? { status, json: { message } }
          : p === "/retention/preview"
            ? { json: proposedPreview }
            : { json: { needs_setup: false } },
      );
      dom = booted.dom;
      const { bridge } = booted;
      bridge.state.retentionRevision = "revision-1";
      await bridge.clearChannelRetention(7);
      await bridge.applyRetention();
      expect(dom.window.document.getElementById("modalInner")!.textContent).toContain(message);
      expect(dom.window.document.getElementById("applyRetentionPreview")).toBeNull();
      await bridge.applyRetention();
      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    },
  );
  it("discards a late preview after cancellation and sends only one apply while pending", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls, (p) =>
      p === "/retention/preview" ? { json: proposedPreview } : { json: { needs_setup: false } },
    );
    dom = booted.dom;
    const { bridge } = booted;
    bridge.state.retentionRevision = "revision-1";
    const originalFetch = dom.window.fetch;
    let release = () => {};
    let pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    dom.window.fetch = (async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      await pending;
      return response;
    }) as typeof fetch;
    const preview = bridge.clearChannelRetention(7);
    bridge.closeModal();
    release();
    await preview;
    expect(bridge.state.retentionProposal).toBeNull();
    expect(dom.window.document.getElementById("modal")!.classList.contains("visible")).toBe(false);
    await bridge.clearChannelRetention(7);
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = bridge.applyRetention();
    await bridge.applyRetention();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    release();
    await apply;
  });

  // AO-3. The shell groups the same #hash routes, shows who and where in a
  // top bar, badges the nav from the routes that own the counts, and below
  // 900px turns the sidebar into a drawer that takes focus and gives it back.
  it("renders the grouped nav, top bar, badges and drawer (AO-3)", async () => {
    const calls: FetchCall[] = [];
    let pending = [{ id: 1 }, { id: 2 }];
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/me")
        return {
          json: {
            id: 1,
            username: "ada",
            role_name: "Owner",
            permissions: ADMINISTRATOR,
            role_position: 100,
            is_owner: true,
            server_name: "Lab <b>",
            version: "1.2.0",
          },
        };
      if (p === "/registrations") return { json: pending };
      if (p === "/attention")
        return { json: { warnings: [{ id: "a" }, { id: "b", recovered_at: "x" }] } };
      if (p === "/updates") return { json: { update_available: true } };
      if (p.startsWith("/audit-log") || p.startsWith("/users")) return { json: [] };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { bridge, dom: jsdom } = booted;
    const doc = jsdom.window.document;
    jsdom.window.location.hash = "#audit";
    await bridge.enterApp();
    await new Promise((resolve) => jsdom.window.setTimeout(resolve, 0));

    // The deep link still lands on its section.
    expect(bridge.state.section).toBe("audit");
    const nav = doc.getElementById("sidebarNav")!;
    expect([...nav.querySelectorAll(".sidebar-label")].map((e) => e.textContent)).toEqual([
      "Overview",
      "Community",
      "Moderation",
      "Server",
      "Operations",
      "Integrations",
    ]);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Audit log");
    expect(nav.textContent).not.toMatch(/sign out/i);

    // Badges come from the routes that own the counts; the dashboard count
    // excludes recovered warnings.
    const item = (id: string) => nav.querySelector(`[data-args='["${id}"]']`)!;
    expect(item("users").textContent).toBe("Members2 (2 pending registrations)");
    expect(item("dashboard").textContent).toBe("Dashboard1 (1 active warnings)");
    expect(item("updates").querySelector(".nav-dot")).not.toBeNull();

    // Top bar: server name as text, the version, the signed-in user.
    expect(doc.getElementById("topbarServer")!.textContent).toBe("Lab <b>");
    expect(doc.getElementById("topbarVersion")!.textContent).toBe("v1.2.0");
    expect(doc.getElementById("userMenuBtn")!.getAttribute("aria-label")).toBe(
      "Account: ada, Owner",
    );

    // Drawer: focus moves in, Escape closes it and restores focus.
    const toggle = doc.getElementById("navToggle") as HTMLButtonElement;
    const shell = doc.getElementById("adminShell")!;
    toggle.focus();
    toggle.click();
    expect(shell.classList.contains("nav-open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(doc.activeElement).toBe(nav.querySelector('[aria-current="page"]'));

    // A full page of registrations (the route's 50-row default) may be an
    // undercount, so the badge reads 50+; the nav re-render keeps focus.
    pending = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    await bridge.renderUsers();
    expect(item("users").textContent).toBe("Members50+ (50+ pending registrations)");
    expect(doc.activeElement).toBe(nav.querySelector('[aria-current="page"]'));
    expect(shell.classList.contains("nav-open")).toBe(true);

    doc.dispatchEvent(new jsdom.window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(shell.classList.contains("nav-open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement).toBe(toggle);

    // Choosing a section from the open drawer closes it.
    toggle.click();
    (item("users") as HTMLButtonElement).click();
    expect(bridge.state.section).toBe("users");
    expect(shell.classList.contains("nav-open")).toBe(false);

    // Sign out moved to the user menu.
    doc.getElementById("userMenuBtn")!.click();
    expect(doc.getElementById("userMenu")!.classList.contains("hidden")).toBe(false);
    (doc.querySelector('#userMenu [data-action="doLogout"]') as HTMLButtonElement).click();
    expect(doc.getElementById("loginOverlay")!.classList.contains("visible")).toBe(true);
    expect(bridge.state.token).toBe("");
  });

  // UX-12(b). The badges used to load once at sign-in, so a warning raised
  // while the operator was away stayed unseen until a re-login. Coming back
  // to the tab refreshes every source — the open section's included — and a
  // signed-out panel fetches nothing.
  it("refreshes the nav badges when the tab comes back into view (UX-12(b))", async () => {
    const calls: FetchCall[] = [];
    let warnings = [{ id: "a" }];
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/me")
        return {
          json: {
            id: 1,
            username: "ada",
            role_name: "Owner",
            permissions: ADMINISTRATOR,
            role_position: 100,
            is_owner: true,
            server_name: "Lab",
            version: "1.2.0",
          },
        };
      if (p === "/attention") return { json: { warnings } };
      if (p === "/registrations") return { json: [] };
      if (p === "/updates") return { json: { update_available: false } };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
    dom = booted.dom;
    const { bridge, dom: jsdom } = booted;
    const doc = jsdom.window.document;
    const tick = () => new Promise((resolve) => jsdom.window.setTimeout(resolve, 0));
    await bridge.enterApp();
    await tick();
    const dashboard = () =>
      doc.getElementById("sidebarNav")!.querySelector(`[data-args='["dashboard"]']`)!;
    expect(bridge.state.section).toBe("dashboard");
    expect(dashboard().textContent).toBe("Dashboard1 (1 active warnings)");

    // A warning raised while the operator was on another tab.
    warnings = [{ id: "a" }, { id: "b" }];
    doc.dispatchEvent(new jsdom.window.Event("visibilitychange"));
    await tick();
    await tick();
    expect(dashboard().textContent).toBe("Dashboard2 (2 active warnings)");

    // Signed out, a return to the tab loads nothing.
    (doc.querySelector('#userMenu [data-action="doLogout"]') as HTMLButtonElement).click();
    calls.length = 0;
    doc.dispatchEvent(new jsdom.window.Event("visibilitychange"));
    await tick();
    expect(calls).toEqual([]);
  });
});
