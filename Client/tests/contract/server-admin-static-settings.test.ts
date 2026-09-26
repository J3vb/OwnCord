// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// Loads the real admin panel (Server/admin/static, the Go admin panel's SPA)
// into a scripted jsdom window and drives its Settings-page save logic
// directly, the same way a browser would.
//
// There is no bundler or module system for the panel — its scripts are
// classic scripts sharing one global scope — so the only faithful way to test
// it is to actually run it, not to re-implement its logic in TypeScript.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const ADMIN_HTML_SOURCE = adminPanelHtml();

// The page's own <script> is a classic (non-module) script, so its top-level
// `const`/`function` declarations live in the window's shared global script
// scope but are never copied onto the `window` object itself. Append a second
// script that bridges the handful of bindings this test needs onto an
// explicit, test-only global.
const BRIDGE = `<script>
window.__test = {
  state: state,
  PERM: PERM,
  navigateTo: navigateTo,
  closeModal: closeModal,
  renderSettings: renderSettings,
  saveSettings: saveSettings,
  markSettingsChanged: markSettingsChanged,
  renderBackups: renderBackups,
  markBackupPolicyChanged: markBackupPolicyChanged,
  saveBackupPolicy: saveBackupPolicy,
  openRestoreModal: openRestoreModal,
  checkRestoreConfirm: checkRestoreConfirm,
  confirmRestore: confirmRestore,
  renderUpdates: renderUpdates,
  applyUpdate: applyUpdate,
  syncUpdateConfirm: syncUpdateConfirm,
  confirmApplyUpdate: confirmApplyUpdate
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

type Responder = (path: string, method: string) => { status?: number; json?: unknown };

function loadAdminPanel(fetchCalls: FetchCall[], respond: Responder): JSDOM {
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
        fetchCalls.push({ method, path: p, body });
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

interface Bridge {
  state: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  PERM: Record<string, number>;
  navigateTo: (id: string) => void;
  closeModal: () => void;
  renderSettings: () => Promise<string>;
  saveSettings: () => Promise<void>;
  markSettingsChanged: () => void;
  renderBackups: () => Promise<string>;
  markBackupPolicyChanged: () => void;
  saveBackupPolicy: () => Promise<void>;
  openRestoreModal: (name: string, date: string) => void;
  checkRestoreConfirm: (name: string) => void;
  confirmRestore: (name: string) => Promise<void>;
  renderUpdates: () => Promise<string>;
  applyUpdate: () => Promise<void>;
  syncUpdateConfirm: () => void;
  confirmApplyUpdate: () => Promise<void>;
}

async function boot(
  fetchCalls: FetchCall[],
  respond: Responder,
): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const dom = loadAdminPanel(fetchCalls, respond);
  // Let the page's own bootstrap (checkAuth -> GET /setup/status) settle.
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  fetchCalls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  return { dom, bridge };
}

const LOADED_SETTINGS = {
  server_name: "Test Server",
  server_icon: "",
  motd: "Old MOTD",
  max_upload_bytes: "5000000",
  voice_quality: "medium",
  backup_schedule: "off",
  backup_retention: "30",
  registration_mode: "closed",
  require_2fa: "true",
};

describe("Server/admin/static — Settings save (OC-0422)", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("does not resend require_2fa (or any other unchanged field) when only one setting was edited", async () => {
    const fetchCalls: FetchCall[] = [];
    const respond: Responder = (p) => {
      if (p === "/setup/status") return { json: { needs_setup: false } };
      if (p === "/settings") return { json: LOADED_SETTINGS };
      return { json: {} };
    };
    const booted = await boot(fetchCalls, respond);
    dom = booted.dom;
    const { window } = dom;

    const html = await booted.bridge.renderSettings();
    const content = window.document.getElementById("content");
    if (!content) throw new Error("expected #content in the static shell");
    content.innerHTML = html;

    // Sanity: the Require 2FA toggle loaded "on" from the server's "true".
    const require2faBtn = window.document.getElementById("s-require_2fa");
    expect(require2faBtn?.classList.contains("on")).toBe(true);

    // The operator edits only the MOTD.
    const motdInput = window.document.getElementById("s-motd") as HTMLInputElement;
    expect(motdInput).toBeTruthy();
    motdInput.value = "New MOTD";

    // Enable the Save button the way markSettingsChanged() would, without
    // going through its renderNav() side effect.
    const saveBtn = window.document.getElementById("saveSettingsBtn") as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();
    saveBtn.disabled = false;

    await booted.bridge.saveSettings();

    const patchCall = fetchCalls.find((c) => c.path === "/settings" && c.method === "PATCH");
    expect(patchCall).toBeTruthy();
    // Only the field that actually changed should be sent. Sending
    // require_2fa:"true" again — unchanged — re-triggers the server's
    // enrollment-gate precondition for a request that never touched it.
    expect(patchCall!.body).toEqual({ motd: "New MOTD" });
  });
});

const CONFIG_FACTS = { upload_max_size_mb: 100, voice_quality: "medium" };
const BACKUP = "chatserver_20260926_055335.db";

function respondWith(
  overrides: Record<string, { status?: number; json?: unknown }> = {},
): Responder {
  return (p, method) => {
    const hit = overrides[`${method} ${p}`];
    if (hit) return hit;
    if (p === "/setup/status") return { json: { needs_setup: false } };
    if (p === "/settings") return { json: LOADED_SETTINGS };
    if (p === "/config") return { json: CONFIG_FACTS };
    if (p === "/backups")
      return { json: [{ name: BACKUP, size: 1024, date: "2026-09-26T05:53:35Z" }] };
    return { json: {} };
  };
}

async function render(
  bridge: Bridge,
  window: JSDOM["window"],
  fn: () => Promise<string>,
): Promise<HTMLElement> {
  const content = window.document.getElementById("content");
  if (!content) throw new Error("expected #content in the static shell");
  content.innerHTML = await fn();
  return content;
}

describe("Server/admin/static — Settings page (AO-6)", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("groups the editable settings into sections and shows config.yaml values as read-only facts", async () => {
    const booted = await boot([], respondWith());
    dom = booted.dom;
    const content = await render(booted.bridge, dom.window, booted.bridge.renderSettings);

    const headings = [...content.querySelectorAll("section.section-card h3")].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual([
      "General",
      "Access & registration",
      "Security",
      "Set in config.yaml",
    ]);
    // Config-file values are facts from GET /config, not inputs that do nothing.
    for (const id of ["s-max_upload_bytes", "s-voice_quality", "s-server_icon"]) {
      expect(content.querySelector(`#${id}`)).toBeNull();
    }
    const facts = content.querySelector(".fact-list")?.textContent ?? "";
    expect(facts).toContain("100 MB");
    expect(facts).toContain("upload.max_size_mb");
    expect(facts).toContain("Medium");
    // The owner-only backup policy moved to Backups & restore.
    expect(content.querySelector("#s-backup_schedule")).toBeNull();
    expect(content.querySelector("#s-backup_retention")).toBeNull();
    // Every control has an accessible name.
    for (const el of content.querySelectorAll("input, select")) {
      expect(content.querySelector(`label[for="${el.id}"]`), el.id).not.toBeNull();
    }
    expect(content.querySelector("#s-require_2fa")?.getAttribute("aria-labelledby")).toBe(
      "s-require_2fa-name",
    );
  });

  it("drives the save bar from the actual difference, so reverting an edit clears it", async () => {
    const booted = await boot([], respondWith());
    dom = booted.dom;
    const { document } = dom.window;
    await render(booted.bridge, dom.window, booted.bridge.renderSettings);
    const motd = document.getElementById("s-motd") as HTMLInputElement;
    const save = document.getElementById("saveSettingsBtn") as HTMLButtonElement;
    const discard = document.getElementById("discardSettingsBtn") as HTMLButtonElement;
    const bar = document.getElementById("settingsSaveBar");
    expect(save.disabled).toBe(true);
    expect(bar?.classList.contains("dirty")).toBe(false);

    motd.value = "New MOTD";
    booted.bridge.markSettingsChanged();
    expect(save.disabled).toBe(false);
    expect(discard.disabled).toBe(false);
    expect(bar?.classList.contains("dirty")).toBe(true);
    expect(document.getElementById("settingsSaveState")?.textContent).toBe("Unsaved changes");
    expect(booted.bridge.state.settingsChanged).toBe(true);

    motd.value = LOADED_SETTINGS.motd;
    booted.bridge.markSettingsChanged();
    expect(save.disabled).toBe(true);
    expect(bar?.classList.contains("dirty")).toBe(false);
    expect(document.getElementById("settingsSaveState")?.textContent).toBe("All changes saved");
    expect(booted.bridge.state.settingsChanged).toBe(false);
  });

  it("discards an unsaved edit when the page is rendered again, showing server values and a clean save bar", async () => {
    const booted = await boot([], respondWith());
    dom = booted.dom;
    const { document } = dom.window;
    await render(booted.bridge, dom.window, booted.bridge.renderSettings);
    (document.getElementById("s-motd") as HTMLInputElement).value = "Draft MOTD";
    booted.bridge.markSettingsChanged();
    expect(booted.bridge.state.settingsChanged).toBe(true);

    await render(booted.bridge, dom.window, booted.bridge.renderSettings);
    expect((document.getElementById("s-motd") as HTMLInputElement).value).toBe(
      LOADED_SETTINGS.motd,
    );
    expect((document.getElementById("saveSettingsBtn") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("discardSettingsBtn") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(document.getElementById("settingsSaveBar")?.classList.contains("dirty")).toBe(false);
    expect(document.getElementById("settingsSaveState")?.textContent).toBe("All changes saved");
    expect(booted.bridge.state.settingsChanged).toBe(false);
  });

  it("clears the unsaved state when the operator leaves Settings, so the nav dot does not linger", async () => {
    const booted = await boot([], respondWith());
    dom = booted.dom;
    const { document } = dom.window;
    booted.bridge.state.me = { permissions: booted.bridge.PERM.ADMINISTRATOR, is_owner: true };
    booted.bridge.state.section = "settings";
    await render(booted.bridge, dom.window, booted.bridge.renderSettings);
    (document.getElementById("s-motd") as HTMLInputElement).value = "Draft MOTD";
    booted.bridge.markSettingsChanged();
    expect(booted.bridge.state.settingsChanged).toBe(true);

    booted.bridge.navigateTo("backups");
    expect(booted.bridge.state.settingsChanged).toBe(false);
  });
});

describe("Server/admin/static — Backups & restore (AO-6)", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("edits the backup schedule on Backups and saves only the backup keys that changed", async () => {
    const fetchCalls: FetchCall[] = [];
    const booted = await boot(fetchCalls, respondWith());
    dom = booted.dom;
    const { document } = dom.window;
    await render(booted.bridge, dom.window, booted.bridge.renderBackups);
    const schedule = document.getElementById("s-backup_schedule") as HTMLSelectElement;
    const save = document.getElementById("saveBackupPolicyBtn") as HTMLButtonElement;
    expect(schedule.value).toBe("off");
    expect(save.disabled).toBe(true);

    schedule.value = "weekly";
    booted.bridge.markBackupPolicyChanged();
    expect(save.disabled).toBe(false);
    await booted.bridge.saveBackupPolicy();

    const patch = fetchCalls.find((c) => c.method === "PATCH");
    expect(patch).toMatchObject({ path: "/settings", body: { backup_schedule: "weekly" } });
  });

  it("restores only after the backup's name is typed, then waits for the restart", async () => {
    const fetchCalls: FetchCall[] = [];
    const booted = await boot(fetchCalls, respondWith());
    dom = booted.dom;
    const { document } = dom.window;
    booted.bridge.openRestoreModal(BACKUP, "2026-09-26T05:53:35Z");
    const input = document.getElementById("restoreConfirm") as HTMLInputElement;
    const button = document.getElementById("restoreConfirmBtn") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    input.value = "chatserver";
    booted.bridge.checkRestoreConfirm(BACKUP);
    expect(button.disabled).toBe(true);
    await booted.bridge.confirmRestore(BACKUP);
    expect(fetchCalls.some((c) => c.path.endsWith("/restore"))).toBe(false);

    input.value = BACKUP;
    booted.bridge.checkRestoreConfirm(BACKUP);
    expect(button.disabled).toBe(false);
    await booted.bridge.confirmRestore(BACKUP);
    expect(fetchCalls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      `/backups/${BACKUP}/restore`,
    ]);
    expect(document.getElementById("restartWait")?.textContent).toContain("Waiting for the server");
  });
});

describe("Server/admin/static — Apply update dialog (AO-6, OP-11)", () => {
  let dom: JSDOM | undefined;
  const UPDATE = {
    current: "1.0.0",
    latest: "v1.1.0",
    update_available: true,
    can_apply: true,
    release_url: "https://github.com/J3vb/OwnCord/releases/tag/v1.1.0",
  };

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  async function openDialog(
    fetchCalls: FetchCall[],
    overrides: Record<string, { status?: number; json?: unknown }> = {},
  ): Promise<{ bridge: Bridge; document: Document }> {
    const booted = await boot(
      fetchCalls,
      respondWith({ "GET /updates": { json: UPDATE }, ...overrides }),
    );
    dom = booted.dom;
    await booted.bridge.renderUpdates();
    await booted.bridge.applyUpdate();
    fetchCalls.length = 0;
    return { bridge: booted.bridge, document: dom.window.document };
  }

  it("warns that migrations are forward-only, links the release notes and offers a backup first", async () => {
    const { document } = await openDialog([]);
    const modal = document.getElementById("modalInner");
    expect(modal?.textContent).toContain("Database migrations only run forward");
    const link = modal?.querySelector("a.text-link");
    expect(link?.getAttribute("href")).toBe(UPDATE.release_url);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect((document.getElementById("updateBackupFirst") as HTMLInputElement).checked).toBe(true);
    expect(document.getElementById("updateLastBackup")?.textContent).toContain(BACKUP);
  });

  it("takes the backup before applying the update", async () => {
    const fetchCalls: FetchCall[] = [];
    const { bridge, document } = await openDialog(fetchCalls);
    await bridge.confirmApplyUpdate();
    expect(fetchCalls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/backup",
      "/updates/apply",
    ]);
    expect(document.getElementById("restartWait")).not.toBeNull();
  });

  it("does not update when the pre-update backup fails", async () => {
    const fetchCalls: FetchCall[] = [];
    const { bridge, document } = await openDialog(fetchCalls, {
      "POST /backup": { status: 500, json: { message: "disk full" } },
    });
    await bridge.confirmApplyUpdate();
    expect(fetchCalls.some((c) => c.path === "/updates/apply")).toBe(false);
    expect(document.getElementById("updateErr")?.textContent).toContain("nothing was updated");
    expect((document.getElementById("updateConfirmBtn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not update when the dialog is closed while the backup runs", async () => {
    const fetchCalls: FetchCall[] = [];
    const { bridge, document } = await openDialog(fetchCalls);
    const pending = bridge.confirmApplyUpdate();
    bridge.closeModal();
    await pending;
    expect(fetchCalls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/backup"]);
    expect(bridge.state.updateApplying).toBe(false);
    expect(document.getElementById("restartWait")).toBeNull();
  });

  it("skips the backup only when the operator unticks it", async () => {
    const fetchCalls: FetchCall[] = [];
    const { bridge, document } = await openDialog(fetchCalls);
    (document.getElementById("updateBackupFirst") as HTMLInputElement).checked = false;
    bridge.syncUpdateConfirm();
    expect(document.getElementById("updateConfirmBtn")?.textContent).toBe(
      "Update without a backup",
    );
    await bridge.confirmApplyUpdate();
    expect(fetchCalls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/updates/apply",
    ]);
  });

  it("links only an https release page", async () => {
    const { document } = await openDialog([], {
      "GET /updates": { json: { ...UPDATE, release_url: "javascript:alert(1)" } },
    });
    expect(document.getElementById("modalInner")?.querySelector("a")).toBeNull();
  });
});
