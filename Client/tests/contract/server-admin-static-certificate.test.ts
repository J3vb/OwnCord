// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because the Go module carries no JavaScript engine (see
// docs/contributing.md#testing). It runs the dashboard's certificate card
// against a stubbed GET /admin/api/stats in each TLS mode.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminHtmlWithBridge, bootAdminPanel } from "../helpers/adminPanelFetch";

const BRIDGE = `<script>
window.__test = { get state(){return state}, renderDashboard: renderDashboard };
</script>`;
const ADMIN_HTML = adminHtmlWithBridge(BRIDGE);

interface Bridge {
  state: { me: unknown };
  renderDashboard: () => Promise<string>;
}

async function dashboard(stats: Record<string, unknown>): Promise<{ dom: JSDOM; host: Element }> {
  const { dom, bridge } = await bootAdminPanel<Bridge>(ADMIN_HTML, [], (p) => ({
    json: p === "/stats" ? stats : {},
  }));
  bridge.state.me = { permissions: 0 };
  const host = dom.window.document.createElement("div");
  host.innerHTML = await bridge.renderDashboard();
  return { dom, host };
}

describe("Server/admin/static — dashboard certificate card", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("shows the served fingerprint", async () => {
    const r = await dashboard({
      tls_mode: "acme",
      certificate_fingerprint: "aa:bb:cc",
    });
    dom = r.dom;
    const card = r.host.querySelector("#certFingerprintCard");
    expect(card?.querySelector(".hash")?.textContent).toBe("aa:bb:cc");
    // ACME replaces it on every renewal; the owner is told to republish.
    expect(card?.textContent).toMatch(/renew/i);
  });

  it("gives a reverse-proxy owner the recipe for the fingerprint members see", async () => {
    const r = await dashboard({ tls_mode: "off" });
    dom = r.dom;
    const card = r.host.querySelector("#certFingerprintCard");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("reverse proxy");
    const recipe = card?.querySelector("code")?.textContent ?? "";
    expect(recipe).toContain("openssl s_client");
    expect(recipe).toContain("-fingerprint -sha256");
    // The app shows lower-case colon-hex; the recipe prints the same form.
    expect(recipe).toContain("tr 'A-F' 'a-f'");
  });

  it("explains that acme's fingerprint appears after the first secure connection", async () => {
    const r = await dashboard({ tls_mode: "acme" });
    dom = r.dom;
    const card = r.host.querySelector("#certFingerprintCard");
    expect(card?.textContent).toMatch(/first HTTPS connection/);
    expect(card?.querySelector(".hash")).toBeNull();
  });
});
