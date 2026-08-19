// Loads the real Server/admin/static/index.html (the Go admin panel's
// single-file SPA) into a scripted jsdom window and drives its inline
// channel-permissions logic directly, the same way a browser would.
//
// There is no bundler or module system for this file — it is one inline
// <script> executed as a classic script — so the only faithful way to test
// it is to actually run it, not to re-implement its logic in TypeScript.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

const ADMIN_HTML_PATH = path.resolve(__dirname, "../../../../Server/admin/static/index.html");
const ADMIN_HTML_SOURCE = readFileSync(ADMIN_HTML_PATH, "utf8");

// The page's own <script> is a classic (non-module) script, so its top-level
// `const`/`function` declarations live in the window's shared global script
// scope but are never copied onto the `window` object itself — `window.state`
// is undefined even though a later <script> in the same document can still
// read `state` by name. Append a second script that bridges the handful of
// bindings this test needs onto an explicit, test-only global.
const BRIDGE = `<script>
window.__test = {
  state: state,
  renderChannelPermsModal: renderChannelPermsModal,
  renderPermMatrix: renderPermMatrix,
  saveChannelPerms: saveChannelPerms
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

function loadAdminPanel(fetchCalls: FetchCall[]): JSDOM {
  return new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // Stand in for the real REST API. `api()` in the page prefixes every
      // path with /admin/api and JSON-encodes the body.
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const p = input.replace(/^\/admin\/api/, "");
        let body: unknown;
        if (typeof opts.body === "string") {
          try {
            body = JSON.parse(opts.body);
          } catch {
            body = opts.body;
          }
        }
        fetchCalls.push({ method, path: p, body });
        if (p === "/setup/status") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ needs_setup: false }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }) as typeof fetch;
    },
  });
}

describe("Server/admin/static/index.html — channel permissions save (OC-0154)", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("keeps the quick 'Can access' toggle's write when the override matrix targets the same role", async () => {
    const fetchCalls: FetchCall[] = [];
    dom = loadAdminPanel(fetchCalls);
    const { window } = dom;

    // Let the page's own bootstrap (checkAuth() -> GET /setup/status) settle
    // before we start driving it, and drop that call from the log.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fetchCalls.length = 0;

    const bridge = (
      window as unknown as {
        __test: {
          state: any;
          renderChannelPermsModal: () => void;
          renderPermMatrix: () => void;
          saveChannelPerms: () => Promise<void>;
        };
      }
    ).__test;
    expect(bridge).toBeTruthy();

    // Open the channel-permissions modal for #general. "Member" has no
    // existing per-channel override (allow=0, deny=0) — matches the finding's repro.
    bridge.state.permChannel = {
      id: 42,
      name: "general",
      roles: [{ role_id: 5, role_name: "Member", permissions: 0, allow: 0, deny: 0 }],
      users: [],
      allUsers: [],
    };
    bridge.renderChannelPermsModal();

    // Pick "Member" in the override-matrix dropdown. With no existing
    // override every radio renders "Inherit".
    const targetSelect = window.document.getElementById("permTarget") as HTMLSelectElement;
    expect(targetSelect).toBeTruthy();
    targetSelect.value = "r:5";
    bridge.renderPermMatrix();

    // Untick "Can access" for Member — the quick toggle that should hide the
    // channel from that role.
    const accessBox = window.document.getElementById("permRole5") as HTMLInputElement;
    expect(accessBox).toBeTruthy();
    accessBox.checked = false;

    await bridge.saveChannelPerms();

    const rolePermCalls = fetchCalls.filter((c) => c.path === "/channels/42/permissions/5");
    expect(rolePermCalls.length).toBeGreaterThan(0);

    // The quick toggle must have written a deny — and nothing written after
    // it may delete that override back out. A DELETE here means the matrix
    // step, working off its pre-toggle (stale) snapshot, just reverted the
    // channel back to visible for Member.
    const last = rolePermCalls[rolePermCalls.length - 1];
    expect(last.method).not.toBe("DELETE");
    expect((last.body as { deny: number }).deny & 0x2).toBe(0x2);
  });
});
