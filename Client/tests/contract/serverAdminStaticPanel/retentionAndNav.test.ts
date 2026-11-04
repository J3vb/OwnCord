// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
// Continues the panel behaviour tests from authAndInvites.test.ts.
import { describe, it, expect, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  FetchCall,
  Responder,
  proposedPreview,
  ADMINISTRATOR,
  boot,
  bootAsAdmin,
  defaultRespond,
} from "../../helpers/serverAdminStaticPanelHarness";

/** The /me answer for the Owner account, under `serverName`. */
const ownerMe = (serverName: string) => ({
  id: 1,
  username: "ada",
  role_name: "Owner",
  permissions: ADMINISTRATOR,
  role_position: 100,
  is_owner: true,
  server_name: serverName,
  version: "1.2.0",
});

describe("Server/admin/static — panel behaviour", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  /** Opens the retention apply dialog for a 14-day window over the booted panel. */
  async function openRetentionDialog(booted: Awaited<ReturnType<typeof boot>>) {
    dom = booted.dom;
    const { bridge } = booted;
    const doc = dom.window.document;
    bridge.state.retentionRevision = "revision-1";
    doc.getElementById("content")!.innerHTML = '<input id="retentionDays" value="14">';
    await bridge.openApplyRetention();
    return { bridge, doc };
  }

  // OC-0389. Four mounted retention routes and the retention_days setting had
  // no caller at all, so a policy that continuously and irreversibly deletes
  // message history could be neither set, inspected, overridden nor
  // previewed.
  it("preserves the saved-policy preview and confirms all retention writes", async () => {
    const calls: FetchCall[] = [];
    const respond: Responder = (p, method) => {
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
      if (p === "/retention/channels")
        return {
          json: [
            { id: 5, name: "general", type: "text" },
            { id: 7, name: "archive", type: "text" },
            { id: 9, name: "dm", type: "dm" },
          ],
        };
      return { json: {} };
    };
    const booted = await bootAsAdmin(calls, respond);
    dom = booted.dom;

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
      if (p === "/retention")
        return {
          json: {
            server_days: 0,
            revision: "revision-1",
            channels: [{ channel_id: 7, days: 30, updated_by: 1, updated_at: "" }],
          },
        };
      if (p === "/retention/preview") return { json: [] };
      if (p === "/retention/channels")
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
    const booted = await bootAsAdmin([], respond);
    dom = booted.dom;

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
    const { bridge, doc } = await openRetentionDialog(booted);
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
    const { bridge, doc } = await openRetentionDialog(booted);
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

  // WP 8.4c: a Manage Backups holder reaches the Backups page and nothing
  // else of the owner-only group.
  it("opens the Backups nav item to the owner and a Manage Backups holder only", async () => {
    const booted = await boot([], () => ({ json: {} }));
    dom = booted.dom;
    const { bridge } = booted;
    const item = (id: string) => bridge.nav.find((n) => n.id === id)!;
    const MANAGE_BACKUPS = 0x4000;

    bridge.state.me = { permissions: MANAGE_BACKUPS, is_owner: false };
    expect(item("backups").allowed!()).toBe(true);
    expect(item("backups").label).toBe("Backups");
    for (const id of ["updates", "tokens", "config"]) {
      expect(item(id).allowed!(), id).toBe(false);
    }

    bridge.state.me = { permissions: 0x2000000, is_owner: false }; // Manage Server only
    expect(item("backups").allowed!()).toBe(false);

    bridge.state.me = { permissions: ADMINISTRATOR, is_owner: true };
    expect(item("backups").allowed!()).toBe(true);
    expect(item("backups").label).toBe("Backups & restore");
  });

  // AO-3. The shell groups the same #hash routes, shows who and where in a
  // top bar, badges the nav from the routes that own the counts, and below
  // 900px turns the sidebar into a drawer that takes focus and gives it back.
  it("renders the grouped nav, top bar, badges and drawer", async () => {
    const calls: FetchCall[] = [];
    let pending = [{ id: 1 }, { id: 2 }];
    const respond: Responder = (p) => {
      if (p === "/me") return { json: ownerMe("Lab <b>") };
      if (p.startsWith("/registrations")) {
        // Answers like the route: at most `limit` rows, 50 by default.
        const limit = /[?&]limit=(\d+)/.exec(p);
        return { json: pending.slice(0, limit ? Number(limit[1]) : 50) };
      }
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
    // The menu button only shows below 900px, and jsdom does not evaluate
    // @media: apply the narrow rule so the button can take focus.
    const narrow = doc.createElement("style");
    narrow.textContent = ".topbar-menu{display:inline-flex}";
    doc.head.append(narrow);
    toggle.focus();
    toggle.click();
    expect(shell.classList.contains("nav-open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(doc.activeElement).toBe(nav.querySelector('[aria-current="page"]'));

    // More registrations than one page reads as 50+ (Members over-fetches its
    // first page by one row to know); the nav re-render keeps focus.
    pending = Array.from({ length: 51 }, (_, i) => ({ id: i + 1 }));
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
  it("refreshes the nav badges when the tab comes back into view", async () => {
    const calls: FetchCall[] = [];
    let warnings = [{ id: "a" }];
    const respond: Responder = (p) => {
      if (p === "/me") return { json: ownerMe("Lab") };
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

  it("shows the running version's release notes, the history and the repository (What's new)", async () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "- Not released yet",
      "",
      "## v1.2.0 — Spring",
      "",
      "### Added",
      "",
      "- **Bold** and `code` and [docs](https://example.com/d) and [local](docs/x.md)",
      "- <img src=x onerror=alert(1)>",
      "",
      "## v1.1.0",
      "",
      "- Older change",
    ].join("\n");
    const calls: FetchCall[] = [];
    const { dom, bridge } = await boot(calls, (p) =>
      p === "/admin/changelog.md" ? { text: changelog } : defaultRespond(p, "GET"),
    );
    bridge.state.me = { version: "v1.2.0" };
    const host = dom.window.document.createElement("div");
    host.innerHTML = await bridge.renderWhatsNew();

    expect(calls.map((c) => c.url)).toEqual(["/admin/changelog.md"]);
    expect(host.textContent).toContain("This server runs OwnCord v1.2.0");
    expect(host.textContent).toContain("What's new in v1.2.0");
    expect(host.textContent).not.toContain("Not released yet");
    const notes = host.querySelector(".section-card .changelog-body")!;
    expect(notes.querySelector("h4")!.textContent).toBe("Added");
    expect(notes.querySelector("strong")!.textContent).toBe("Bold");
    expect(notes.querySelector("code")!.textContent).toBe("code");
    // Only https links become links, and the notes' own markup stays text.
    expect([...notes.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "https://example.com/d",
    ]);
    expect(notes.querySelector("img")).toBeNull();
    expect(notes.textContent).toContain("<img src=x onerror=alert(1)>");
    // Earlier versions sit in the history; the repository is linked.
    expect(host.querySelector(".whats-new-history")!.textContent).toContain("v1.1.0");
    expect(host.querySelector(".whats-new-history")!.textContent).toContain("Older change");
    expect(host.querySelector<HTMLAnchorElement>(".whats-new-repo")!.href).toBe(
      "https://github.com/J3vb/OwnCord",
    );
  });

  it("links to GitHub when the notes cannot be loaded or the version has none (What's new)", async () => {
    const calls: FetchCall[] = [];
    let status = 404;
    const { dom, bridge } = await boot(calls, (p) =>
      p === "/admin/changelog.md"
        ? { status, text: "## v1.1.0\n\n- Older" }
        : defaultRespond(p, "GET"),
    );
    bridge.state.me = { version: "1.2.0-dev" };
    const host = dom.window.document.createElement("div");
    const warn = vi.spyOn(dom.window.console, "warn").mockImplementation(() => {});
    host.innerHTML = await bridge.renderWhatsNew();
    expect(warn).toHaveBeenCalled();
    expect(host.textContent).toContain("could not be loaded");
    expect(host.querySelector<HTMLAnchorElement>(".card-note a")!.href).toBe(
      "https://github.com/J3vb/OwnCord/releases",
    );

    status = 200;
    host.innerHTML = await bridge.renderWhatsNew();
    expect(host.textContent).toContain("This build has no release notes");
    expect(host.querySelector(".whats-new-history")!.textContent).toContain("v1.1.0");
  });
});
