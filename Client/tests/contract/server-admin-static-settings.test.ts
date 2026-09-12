// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// Loads the real Server/admin/static/index.html (the Go admin panel's
// single-file SPA) into a scripted jsdom window and drives its inline
// Settings-page save logic directly, the same way a browser would.
//
// There is no bundler or module system for this file — it is one inline
// <script> executed as a classic script — so the only faithful way to test
// it is to actually run it, not to re-implement its logic in TypeScript.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

const ADMIN_HTML_PATH = path.resolve(__dirname, "../../../Server/admin/static/index.html");
const ADMIN_HTML_SOURCE = readFileSync(ADMIN_HTML_PATH, "utf8");

// The page's own <script> is a classic (non-module) script, so its top-level
// `const`/`function` declarations live in the window's shared global script
// scope but are never copied onto the `window` object itself. Append a second
// script that bridges the handful of bindings this test needs onto an
// explicit, test-only global.
const BRIDGE = `<script>
window.__test = {
  state: state,
  renderSettings: renderSettings,
  saveSettings: saveSettings
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
  renderSettings: () => Promise<string>;
  saveSettings: () => Promise<void>;
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

describe("Server/admin/static/index.html — Settings save (OC-0422)", () => {
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
