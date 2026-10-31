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
import { describe, it, expect } from "vitest";
import {
  FetchCall,
  Responder,
  ADMINISTRATOR,
  boot,
  bootAsAdmin,
  showShell,
  submitForm,
  defaultRespond,
} from "../../helpers/serverAdminStaticPanelHarness";

/** The Users page rendered over a server that answers with `count` users. */
async function renderUserPage(count: number) {
  const calls: FetchCall[] = [];
  const users = Array.from({ length: count }, (_, i) => ({
    id: i + 2,
    username: "u" + (i + 2),
    role_id: 4,
    status: "offline",
    banned: false,
  }));
  const respond: Responder = (p, _method) => {
    if (p.startsWith("/users?")) return { json: users };
    if (p === "/registrations") return { json: [] };
    return { json: {} };
  };
  const booted = await bootAsAdmin(calls, respond);
  return { calls, booted, html: await booted.bridge.renderUsers() };
}

describe("Server/admin/static — panel behaviour", () => {
  // OC-0350. POST /api/v1/auth/login answers a TOTP account with 200,
  // {partial_token, requires_2fa:true} and NO token. Before the fix the
  // handler assigned d.token (undefined), wrote the string "undefined" into
  // localStorage, and every retry ended at a false "session expired".
  it("completes a two-factor sign-in through /auth/verify-totp", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p, _method) => {
      if (p === "/api/v1/auth/login")
        return { json: { requires_2fa: true, partial_token: "PARTIAL-123" } };
      if (p === "/api/v1/auth/verify-totp") return { json: { token: "SESSION-XYZ" } };
      if (p === "/me")
        return { json: { id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true } };
      if (p === "/stats") return { json: {} };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
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

  it("keeps the challenge alive after a rejected code, then clears it on Back", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p, _method) => {
      if (p === "/api/v1/auth/login")
        return { json: { requires_2fa: true, partial_token: "PARTIAL-123" } };
      if (p === "/api/v1/auth/verify-totp")
        return { status: 401, json: { message: "invalid two-factor code" } };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
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
  it("parses a naive SQLite timestamp as UTC, and leaves a zoned one alone", async () => {
    const booted = await boot([], defaultRespond);
    const { utcDate } = booted.bridge;

    expect(utcDate("2026-03-19 08:29:41").getTime()).toBe(Date.UTC(2026, 2, 19, 8, 29, 41));
    expect(utcDate("2026-03-19T08:29:41Z").getTime()).toBe(Date.UTC(2026, 2, 19, 8, 29, 41));
    expect(utcDate("2026-03-19T10:29:41+02:00").getTime()).toBe(Date.UTC(2026, 2, 19, 8, 29, 41));
  });

  // OC-0331. The API Tokens table renders naive-UTC created_at / last_used
  // through fmtLocal: local text, the UTC instant in the tooltip.
  it("renders token timestamps as UTC instants", async () => {
    const respond: Responder = (p) => {
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
      if (p === "/archive/link" && method === "POST")
        return { json: { path: "/admin/api/archive/download?token=TOK-1" } };
      return { json: {} };
    };
    const booted = await boot(calls, respond);
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
  it("treats a lapsed temporary ban as not banned", async () => {
    const booted = await boot([], defaultRespond);
    const { effectiveBan } = booted.bridge;

    expect(effectiveBan({ banned: false })).toBe(false);
    expect(effectiveBan({ banned: true })).toBe(true);
    expect(effectiveBan({ banned: true, ban_expires: "2020-01-01T00:00:00Z" })).toBe(false);
    // SQLite's space-separated, zone-less form is UTC, like the rest.
    expect(effectiveBan({ banned: true, ban_expires: "2020-01-01 00:00:00" })).toBe(false);
    expect(effectiveBan({ banned: true, ban_expires: "2999-01-01T00:00:00Z" })).toBe(true);
  });

  // OC-0361 and OC-0390 and OC-0364, over one rendered Users page.
  it("does not offer a next page for an exactly-full page, and offers erasure apart from force-logout", async () => {
    const { calls, booted, html } = await renderUserPage(50);

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

  it("offers a next page when an overflow row comes back", async () => {
    const { html } = await renderUserPage(51);
    expect(html).toMatch(
      /<button class="page-btn" {2}data-action="turnUsersPage" data-args="\[1\]"/,
    );
    // The overflow row is fetched, never rendered.
    expect(html).not.toContain('data-action="openEraseUser" data-args="[52,');
  });

  // OC-0367. CreateRole refuses an explicitly requested position that is
  // taken, and the slot below the actor is the one the previous new role got.
  it("prefills Create Role with the highest free position below the actor", async () => {
    const booted = await bootAsAdmin([], defaultRespond);
    const doc = booted.dom.window.document;
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
    const booted = await bootAsAdmin(calls, respond);
    const { window } = booted.dom;
    const doc = window.document;

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
  it('lets "/" be typed into a text field and still jumps there from outside', async () => {
    const booted = await boot([], defaultRespond);
    const { window } = booted.dom;
    const doc = window.document;
    showShell(booted.dom);

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
});
