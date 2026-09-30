// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because the Go module carries no JavaScript engine (see
// docs/contributing.md#testing). It runs the Dashboard's connectivity check
// against a stubbed GET /api/v1/diagnostics/connectivity — the admin-only
// report docs/port-forwarding.md points operators at.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = { get state(){return state}, renderDashboard: renderDashboard };
</script>`;
const ADMIN_HTML = adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`);

const ADMINISTRATOR = 0x40000000;
const MANAGE_CHANNELS = 0x20000;
const DIAG = "/api/v1/diagnostics/connectivity";

interface Call {
  path: string;
  method: string;
  auth: string;
}
type Responder = (path: string) => { status?: number; json?: unknown };
interface Bridge {
  state: { me: unknown; token: string; section: string };
  renderDashboard: () => Promise<string>;
}

const REPORT = {
  server: { version: "2.0.0", uptime_s: 7260, go_version: "go1.27.1", online_users: 3 },
  voice: {
    enabled: true,
    livekit_url: "127.0.0.1:7880",
    livekit_health: false,
    node_ip: "192.168.1.20",
    proxy_path: "/livekit",
  },
  client: { remote_addr: "192.168.1.5", is_private_network: true, address_class: "private" },
};

let dom: JSDOM | undefined;
afterEach(() => {
  dom?.window?.close();
  dom = undefined;
});

async function show(me: Record<string, unknown>, respond: Responder, calls: Call[] = []) {
  dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string, opts: RequestInit = {}) => {
        const p = String(input).replace(/^\/admin\/api/, "");
        const headers = (opts.headers ?? {}) as Record<string, string>;
        calls.push({
          path: p,
          method: String(opts.method ?? "GET").toUpperCase(),
          auth: headers.Authorization ?? "",
        });
        const r = p === "/setup/status" ? { json: { needs_setup: false } } : respond(p);
        const status = r.status ?? 200;
        return {
          ok: status < 300,
          status,
          json: async () => r.json ?? {},
          text: async () => JSON.stringify(r.json ?? {}),
        } as Response;
      }) as typeof fetch;
    },
  });
  const settle = () => new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
  await settle();
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  bridge.state.me = me;
  bridge.state.token = "SESSION";
  bridge.state.section = "dashboard";
  const doc = dom.window.document;
  doc.getElementById("content")!.innerHTML = await bridge.renderDashboard();
  return { doc, settle };
}

const stats: Responder = (p) => (p === "/stats" ? { json: { user_count: 1 } } : { json: {} });

describe("Server/admin/static — connectivity check", () => {
  it("runs the admin-only connectivity report on request and shows it in the panel", async () => {
    const calls: Call[] = [];
    const { doc, settle } = await show(
      { id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true },
      (p) => (p === DIAG ? { json: REPORT } : stats(p)),
      calls,
    );
    const card = doc.getElementById("connectivityCard")!;
    expect(card.querySelector("h3")!.textContent).toBe("Connectivity check");
    expect(calls.some((c) => c.path === DIAG)).toBe(false);

    (card.querySelector('[data-action="runConnectivityCheck"]') as HTMLButtonElement).click();
    await settle();
    await settle();

    expect(calls.filter((c) => c.path === DIAG)).toEqual([
      { path: DIAG, method: "GET", auth: "Bearer SESSION" },
    ]);
    const result = doc.getElementById("connectivityResult")!;
    const facts = Object.fromEntries(
      [...result.querySelectorAll("dt")].map((dt) => [
        dt.textContent,
        dt.nextElementSibling!.textContent,
      ]),
    );
    expect(facts).toMatchObject({
      "Voice server": "Not reachable",
      "Voice address": "127.0.0.1:7880",
      "Voice node IP": "192.168.1.20",
      "Your address": "192.168.1.5 (private network)",
      "Server version": "2.0.0",
      "Online now": "3",
    });
    expect(result.textContent).toContain("server.reachability_report_enabled");
  });

  it("lists the forwarding rules and what the server cannot see when the owner enabled the detail", async () => {
    const report = {
      ...REPORT,
      voice: { ...REPORT.voice, livekit_health: true },
      reachability: {
        listen_port: 8443,
        required_ports: [{ port: "8443", protocol: "TCP", purpose: "HTTPS <and> WebSocket" }],
        undeterminable: [
          {
            fact: "Whether the port is forwarded",
            why: "Only a probe from outside can see it",
            how_to_check: "Open the server from a phone on mobile data",
          },
        ],
      },
    };
    const { doc, settle } = await show(
      { id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true },
      (p) => (p === DIAG ? { json: report } : stats(p)),
    );
    (doc.querySelector('[data-action="runConnectivityCheck"]') as HTMLButtonElement).click();
    await settle();
    await settle();
    const result = doc.getElementById("connectivityResult")!;
    expect(result.textContent).toContain("Reachable");
    expect(result.textContent).toContain("8443/TCP");
    expect(result.textContent).toContain("HTTPS <and> WebSocket");
    expect(result.innerHTML).toContain("&lt;and&gt;");
    expect(result.textContent).toContain("Whether the port is forwarded");
    expect(result.textContent).toContain("Open the server from a phone on mobile data");
    expect(result.textContent).not.toContain("server.reachability_report_enabled");
  });

  it("shows the server's refusal instead of a result", async () => {
    const { doc, settle } = await show(
      { id: 1, permissions: ADMINISTRATOR, role_position: 100, is_owner: true },
      (p) =>
        p === DIAG
          ? { status: 429, json: { error: "RATE_LIMITED", message: "too many requests" } }
          : stats(p),
    );
    (doc.querySelector('[data-action="runConnectivityCheck"]') as HTMLButtonElement).click();
    await settle();
    await settle();
    expect(doc.getElementById("connectivityResult")!.textContent).toContain("too many requests");
  });

  it("is not offered to a principal without ADMINISTRATOR", async () => {
    const calls: Call[] = [];
    const { doc } = await show(
      { id: 2, permissions: MANAGE_CHANNELS, role_position: 60 },
      stats,
      calls,
    );
    expect(doc.getElementById("connectivityCard")).toBeNull();
    expect(calls.some((c) => c.path === DIAG)).toBe(false);
  });
});
