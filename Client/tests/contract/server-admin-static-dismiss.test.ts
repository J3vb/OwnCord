// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because the Go module carries no JavaScript engine (see
// docs/contributing.md#testing). It runs the admin panel's dismissable
// notices (dashboard warning cards and the update strip) against stubbed
// /admin/api responses.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = { get state(){return state}, renderContent: renderContent };
</script>`;
const ADMIN_HTML = adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`);

const ADMINISTRATOR = 0x40000000;

interface Bridge {
  state: { me: unknown; section: string };
  renderContent: () => void;
}

const warning = (over: Record<string, unknown> = {}) => ({
  id: "db_writer_wait",
  severity: "warning",
  title: "Database writes are queueing",
  detail: "9000.0 ms/min",
  action: "Check Server Logs.",
  first_observed: "2026-09-23T11:50:00Z",
  last_observed: "2026-09-23T12:00:00Z",
  occurrences: 3,
  recovered_at: null,
  ...over,
});

interface Server {
  warnings: unknown[];
  update: Record<string, unknown>;
  config?: Record<string, unknown>;
  signals?: unknown[];
}

async function boot(server: Server, userId = 1) {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = (async (input: string) => {
        const p = String(input).replace(/^\/admin\/api/, "");
        const json =
          p === "/setup/status"
            ? { needs_setup: false }
            : p === "/attention"
              ? {
                  evaluated_at: "2026-09-23T12:00:00Z",
                  signals: server.signals ?? [],
                  warnings: server.warnings,
                }
              : p === "/updates"
                ? server.update
                : p === "/config/settings"
                  ? (server.config ?? {})
                  : {};
        return { ok: true, status: 200, json: async () => json } as Response;
      }) as typeof fetch;
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  bridge.state.me = { id: userId, permissions: ADMINISTRATOR, is_owner: true };
  bridge.state.section = "dashboard";
  return { dom, bridge };
}

async function paint(dom: JSDOM, bridge: Bridge): Promise<Element> {
  bridge.renderContent();
  await new Promise((resolve) => dom.window.setTimeout(resolve, 20));
  return dom.window.document.getElementById("content") as Element;
}

function click(dom: JSDOM, el: Element | null): void {
  if (!el) throw new Error("control not found");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}

const cards = (c: Element) => Array.from(c.querySelectorAll(".attn-warning:not(.ok)"));

describe("Server/admin/static — dismissable notices", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("dismisses a warning card, keeps it hidden across reloads, and shows it again when its content changes", async () => {
    const server: Server = { warnings: [warning()], update: {} };
    const booted = await boot(server);
    dom = booted.dom;
    let content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(1);
    const btn = content.querySelector(".attn-warning .notice-dismiss");
    expect(btn?.getAttribute("aria-label")).toContain("Dismiss");

    click(dom, btn);
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 20));
    content = dom.window.document.getElementById("content") as Element;
    expect(cards(content)).toHaveLength(0);
    // Persisted in the browser, so a fresh render (a reload) keeps it hidden.
    expect(dom.window.localStorage.length).toBeGreaterThan(0);
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(0);

    // Same problem, newer sighting: still dismissed.
    server.warnings = [warning({ last_observed: "2026-09-23T13:00:00Z" })];
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(0);

    // A live measurement drifting in the detail text does not bring it back.
    server.warnings = [warning({ detail: "20000.0 ms/min" })];
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(0);

    // The warning clears, then the same warning returns as a new incident.
    server.warnings = [];
    content = await paint(dom, booted.bridge);
    server.warnings = [warning({ first_observed: "2026-09-24T08:00:00Z" })];
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(1);

    // The problem changed (new severity, then new title): it shows again.
    click(dom, content.querySelector(".attn-warning .notice-dismiss"));
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(0);
    server.warnings = [warning({ first_observed: "2026-09-24T08:00:00Z", severity: "critical" })];
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(1);
    server.warnings = [
      warning({
        first_observed: "2026-09-24T08:00:00Z",
        severity: "critical",
        title: "Writes are badly queueing",
      }),
    ];
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(1);
  });

  it("headline and checks count only the warnings still shown", async () => {
    const server: Server = { warnings: [warning({ severity: "critical" })], update: {} };
    const booted = await boot(server);
    dom = booted.dom;
    let content = await paint(dom, booted.bridge);
    const title = () => content.querySelector("#attnTitle");
    expect(title()?.textContent).toContain("1 problem needs your attention");
    click(dom, content.querySelector(".attn-warning .notice-dismiss"));
    content = await paint(dom, booted.bridge);
    expect(title()?.textContent).toBe("Everything is running normally");
    expect(content.querySelector(".health-hero.ok")).toBeTruthy();
    expect(content.querySelector('[data-action="restoreDismissed"]')?.textContent).toContain(
      "1 dismissed",
    );
  });

  it("closes the health checks once their only warning is dismissed", async () => {
    const okSignal = {
      id: "disk",
      label: "Disk space",
      status: "ok",
      detail: "",
      observed_at: "2026-09-23T12:00:00Z",
    };
    const server: Server = { warnings: [warning()], update: {}, signals: [okSignal] };
    const booted = await boot(server);
    dom = booted.dom;
    let content = await paint(dom, booted.bridge);
    const checks = () => content.querySelector("#healthChecks") as HTMLDetailsElement;
    expect(checks().open).toBe(true);
    click(dom, content.querySelector(".attn-warning .notice-dismiss"));
    content = await paint(dom, booted.bridge);
    expect(checks().open).toBe(false);
  });

  it("counts the dismissed update strip in the restore link and restores it", async () => {
    const server: Server = {
      warnings: [warning()],
      update: { update_available: true, current: "v1.0.0", latest: "v1.1.0" },
    };
    const booted = await boot(server);
    dom = booted.dom;
    let content = await paint(dom, booted.bridge);
    click(dom, content.querySelector(".update-strip .notice-dismiss"));
    content = await paint(dom, booted.bridge);
    click(dom, content.querySelector(".attn-warning .notice-dismiss"));
    content = await paint(dom, booted.bridge);
    expect(content.querySelector('[data-action="restoreDismissed"]')?.textContent).toContain(
      "2 dismissed",
    );
    click(dom, content.querySelector('[data-action="restoreDismissed"]'));
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(1);
    expect(content.querySelector(".update-strip")).toBeTruthy();
  });

  it("keeps dismissals per admin and can bring them back", async () => {
    const server: Server = { warnings: [warning()], update: {} };
    const booted = await boot(server, 1);
    dom = booted.dom;
    let content = await paint(dom, booted.bridge);
    click(dom, content.querySelector(".attn-warning .notice-dismiss"));
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(0);

    const restore = content.querySelector('[data-action="restoreDismissed"]');
    expect(restore?.textContent).toContain("1 dismissed");

    booted.bridge.state.me = { id: 2, permissions: ADMINISTRATOR, is_owner: true };
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(1);

    booted.bridge.state.me = { id: 1, permissions: ADMINISTRATOR, is_owner: true };
    content = await paint(dom, booted.bridge);
    click(dom, content.querySelector('[data-action="restoreDismissed"]'));
    content = await paint(dom, booted.bridge);
    expect(cards(content)).toHaveLength(1);
  });

  it("dismisses the update strip per version", async () => {
    const server: Server = {
      warnings: [],
      update: { update_available: true, current: "v1.0.0", latest: "v1.1.0" },
    };
    const booted = await boot(server);
    dom = booted.dom;
    let content = await paint(dom, booted.bridge);
    expect(content.querySelector(".update-strip")).toBeTruthy();
    click(dom, content.querySelector(".update-strip .notice-dismiss"));
    content = await paint(dom, booted.bridge);
    expect(content.querySelector(".update-strip")).toBeNull();

    server.update = { update_available: true, current: "v1.0.0", latest: "v1.2.0" };
    content = await paint(dom, booted.bridge);
    expect(content.querySelector(".update-strip")).toBeTruthy();
  });

  it("never offers a dismiss on the pending-restart banner", async () => {
    const server: Server = {
      warnings: [],
      update: {},
      config: { restart_pending: true, settings: [] },
    };
    const booted = await boot(server);
    dom = booted.dom;
    booted.bridge.state.section = "config";
    const content = await paint(dom, booted.bridge);
    expect(content.querySelector('[data-action="restartForConfig"]')).toBeTruthy();
    expect(content.querySelector(".notice-dismiss")).toBeNull();
  });
});
