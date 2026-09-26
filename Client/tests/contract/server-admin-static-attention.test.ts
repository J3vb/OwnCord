// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because the Go module carries no JavaScript engine (see
// docs/contributing.md#testing). It runs the admin panel's attention card
// (RI-07) against a stubbed GET /admin/api/attention.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const ADMIN_HTML_SOURCE = adminPanelHtml();
const BRIDGE = `<script>
window.__test = { get state(){return state}, renderDashboard: renderDashboard };
</script>`;
const ADMIN_HTML = ADMIN_HTML_SOURCE.replace("</body>", `${BRIDGE}\n</body>`);

const ADMINISTRATOR = 0x40000000;
const MANAGE_CHANNELS = 0x20000;

type Responder = (path: string) => { status?: number; json?: unknown };

interface Bridge {
  state: { me: unknown };
  renderDashboard: () => Promise<string>;
}

async function boot(paths: string[], respond: Responder): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = (async (input: string) => {
        const p = String(input).replace(/^\/admin\/api/, "");
        paths.push(p);
        const r = p === "/setup/status" ? { json: { needs_setup: false } } : respond(p);
        const status = r.status ?? 200;
        return { ok: status < 300, status, json: async () => r.json ?? {} } as Response;
      }) as typeof fetch;
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  paths.length = 0;
  return { dom, bridge: (dom.window as unknown as { __test: Bridge }).__test };
}

function render(dom: JSDOM, html: string): Element {
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;
  const panel = host.querySelector("#attentionPanel");
  expect(panel).toBeTruthy();
  return panel as Element;
}

const REPORT = {
  evaluated_at: "2026-09-23T12:00:00Z",
  signals: [
    {
      id: "disk",
      label: "Disk space",
      status: "unknown",
      detail: "disk space is not measured on this server",
      observed_at: "2026-09-23T12:00:00Z",
    },
    {
      id: "backup",
      label: "Last successful backup",
      status: "ok",
      value: "2026-09-23 03:00 UTC",
      observed_at: "2026-09-23T12:00:00Z",
    },
    {
      id: "db_writer_wait",
      label: "Database writer wait",
      status: "warning",
      value: "9000.0 ms/min",
      threshold: "raise at 5000.0 ms/min",
      observed_at: "2026-09-23T12:00:00Z",
    },
  ],
  warnings: [
    {
      id: "db_writer_wait",
      severity: "warning",
      title: "Database writes are queueing <b>now</b>",
      detail: "9000.0 ms/min",
      action: "Check Server Logs for long-running writes.",
      first_observed: "2026-09-23T11:50:00Z",
      last_observed: "2026-09-23T12:00:00Z",
      occurrences: 3,
      recovered_at: null,
    },
    {
      id: "job:Backups",
      severity: "warning",
      title: "Maintenance job failing: Backups",
      detail: "",
      action: "Search Server Logs.",
      first_observed: "2026-09-23T08:00:00Z",
      last_observed: "2026-09-23T09:00:00Z",
      occurrences: 1,
      recovered_at: "2026-09-23T09:15:00Z",
    },
  ],
};

describe("Server/admin/static — attention panel (RI-07)", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("shows warnings with action, observed times, occurrences and recovery, and unknown apart from healthy", async () => {
    const paths: string[] = [];
    const booted = await boot(paths, (p) => (p === "/attention" ? { json: REPORT } : { json: {} }));
    dom = booted.dom;
    booted.bridge.state.me = { permissions: ADMINISTRATOR };
    const panel = render(dom, await booted.bridge.renderDashboard());
    expect(paths).toContain("/attention");

    expect(panel.querySelector("h3")?.textContent).toBe("Attention (1)");
    const [active, recovered] = Array.from(panel.querySelectorAll(".attn-warning"));
    if (!active || !recovered) throw new Error("expected an active and a recovered warning");
    expect(active.getAttribute("data-id")).toBe("db_writer_wait");
    expect(active.querySelector(".badge")?.textContent).toBe("Warning");
    // Escaped, not markup.
    expect(active.querySelector("strong")?.textContent).toBe(
      "Database writes are queueing <b>now</b>",
    );
    expect(active.querySelector(".attn-action")?.textContent).toBe(
      "Check Server Logs for long-running writes.",
    );
    expect(active.textContent).toContain("First seen");
    expect(active.textContent).toContain("3 occurrences");
    expect(active.textContent).not.toContain("recovered");

    expect(recovered.querySelector(".badge")?.textContent).toBe("Recovered");
    expect(recovered.textContent).toContain("recovered ");

    const badge = (id: string) =>
      panel.querySelector(`tr[data-signal="${id}"] .badge`)?.textContent;
    expect(badge("disk")).toBe("Unknown");
    expect(badge("backup")).toBe("Healthy");
    expect(badge("db_writer_wait")).toBe("Warning");
    expect(panel.querySelector('tr[data-signal="disk"]')?.textContent).toContain("not measured");
  });

  it("says so when nothing is active, and when the server has not evaluated yet", async () => {
    const paths: string[] = [];
    let report: unknown = { ...REPORT, warnings: [] };
    const booted = await boot(paths, (p) => (p === "/attention" ? { json: report } : { json: {} }));
    dom = booted.dom;
    booted.bridge.state.me = { permissions: ADMINISTRATOR };
    let panel = render(dom, await booted.bridge.renderDashboard());
    expect(panel.querySelector(".attn-none")?.textContent).toBe("No active warnings.");

    report = { evaluated_at: null, signals: [], warnings: [] };
    panel = render(dom, await booted.bridge.renderDashboard());
    expect(panel.querySelector(".attn-pending")).toBeTruthy();
    expect(panel.querySelector(".attn-none")).toBeNull();
  });

  it("reports a failed load instead of an empty panel", async () => {
    const paths: string[] = [];
    const booted = await boot(paths, (p) =>
      p === "/attention"
        ? { status: 500, json: { message: "attention service unavailable" } }
        : { json: {} },
    );
    dom = booted.dom;
    booted.bridge.state.me = { permissions: ADMINISTRATOR };
    const panel = render(dom, await booted.bridge.renderDashboard());
    expect(panel.textContent).toContain("attention service unavailable");
  });

  it("is not requested without ADMINISTRATOR", async () => {
    const paths: string[] = [];
    const booted = await boot(paths, () => ({ json: {} }));
    dom = booted.dom;
    booted.bridge.state.me = { permissions: MANAGE_CHANNELS };
    const html = await booted.bridge.renderDashboard();
    expect(paths).not.toContain("/attention");
    expect(html).not.toContain("attentionPanel");
  });
});
