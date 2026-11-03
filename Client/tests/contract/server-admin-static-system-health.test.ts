// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because the Go module carries no JavaScript engine (see
// docs/contributing.md#testing). It runs the admin System health page
// (js/system-health.js) against a stubbed GET /admin/api/system/health.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import {
  adminHtmlWithBridge,
  jsonResponder,
  loadPanelWithFetch,
  scriptedPanelFetch,
  settlePanel,
} from "../helpers/adminPanelFetch";

const BRIDGE = `<script>
window.__test = {
  get state(){return state}, get sysHealth(){return sysHealth},
  renderSystemHealth: renderSystemHealth, pollSystemHealth: pollSystemHealth,
  sectionAllowed: sectionAllowed, copySystemHealth: copySystemHealth,
};
</script>`;
const ADMIN_HTML = adminHtmlWithBridge(BRIDGE);

const ADMINISTRATOR = 0x40000000;
const MANAGE_CHANNELS = 0x20000;

interface Bridge {
  state: { me: unknown; section: string; token: string };
  sysHealth: { seq: number; timer: unknown; data: unknown; error: string };
  renderSystemHealth: () => Promise<string>;
  pollSystemHealth: (seq: number, token: string) => Promise<void>;
  sectionAllowed: (id: string) => boolean;
  copySystemHealth: () => void;
}

type Responder = (path: string) => Promise<unknown> | unknown;

async function boot(paths: string[], respond: Responder): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const dom = loadPanelWithFetch(
    ADMIN_HTML,
    scriptedPanelFetch(
      ({ path }) => paths.push(path),
      jsonResponder((p) => respond(p)),
    ),
  );
  const bridge = await settlePanel<Bridge>(dom);
  paths.length = 0;
  bridge.state.token = "tok";
  bridge.state.section = "health";
  bridge.state.me = { permissions: ADMINISTRATOR };
  return { dom, bridge };
}

const HEALTH = {
  captured_at: "2026-11-03T19:00:00Z",
  snapshot: {
    captured_at: "2026-11-03T19:00:00Z",
    scope: "database, process and local hub counters",
    database_readable: true,
    connected_users: 14,
    voice_sessions: 3,
    dispatch_alive: true,
    broadcast_drops: 0,
    ws_broadcast_ms: { count: 40, p50: 0.4, p95: 2.5, p99: 3, max: 4 },
    ws_dispatch_lag_ms: { count: 0, p50: 0, p95: 0, p99: 0, max: 0 },
    chat_send_ack_ms: { count: 9, p50: 12, p95: 48, p99: 60, max: 61 },
    goroutines: 211,
    heap_alloc_bytes: 52_428_800,
    gc_cycles: 31,
  },
  hub: { connections: 16, max_connections: 200 },
  database: {
    status: "ok",
    stats: {
      file_bytes: 104_857_600,
      wal_bytes: 4_194_304,
      schema_version: "089_example.sql",
      readers_in_use: 1,
      readers_open: 3,
      readers_max: 8,
      reader_wait_count: 0,
      reader_wait_ms: 0,
      writer_wait_count: 2,
      writer_wait_ms: 15.5,
    },
  },
  process: {
    uptime_seconds: 2 * 86400 + 3 * 3600,
    build: {
      version: "2.8.0",
      go: "go1.27.1",
      os: "linux",
      arch: "amd64",
      revision: "0123456789abcdef",
    },
  },
  livekit: { managed: false },
  signals: [
    { id: "db_writer_wait", label: "Database writer wait", status: "warning", value: "900 ms/min" },
    { id: "reconnects", label: "Client reconnects", status: "ok", value: "0/min" },
    { id: "voice", label: "Voice (LiveKit)", status: "unknown" },
    { id: "job:Backups", label: "Maintenance: Backups", status: "ok" },
    { id: "certificate", label: "TLS certificate", status: "critical", value: "expires in 3 days" },
  ],
};

function render(dom: JSDOM, html: string): Element {
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;
  dom.window.document.getElementById("content")!.replaceChildren(host);
  return host;
}

function fact(host: Element, card: string, label: string): string | undefined {
  const dts = Array.from(host.querySelectorAll(`#${card} dt`));
  const dt = dts.find((d) => d.textContent === label);
  return dt?.nextElementSibling?.textContent ?? undefined;
}

describe("Server/admin/static — System health page", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("is a View Diagnostics page", async () => {
    const booted = await boot([], () => HEALTH);
    dom = booted.dom;
    expect(booted.bridge.sectionAllowed("health")).toBe(true);
    booted.bridge.state.me = { permissions: MANAGE_CHANNELS };
    expect(booted.bridge.sectionAllowed("health")).toBe(false);
  });

  it("shows the connections, database, voice and process cards", async () => {
    const paths: string[] = [];
    const booted = await boot(paths, (p) => (p === "/system/health" ? HEALTH : {}));
    dom = booted.dom;
    const host = render(dom, await booted.bridge.renderSystemHealth());
    expect(paths).toContain("/system/health");

    expect(fact(host, "sysHub", "Users online")).toBe("14");
    expect(fact(host, "sysHub", "Connections")).toBe("16 of 200");
    expect(fact(host, "sysHub", "Message delivery")).toBe("Running");
    expect(fact(host, "sysHub", "Broadcast time (typical / slow)")).toBe("0.4 ms / 2.5 ms");
    // No samples yet is a dash, never "0 ms".
    expect(fact(host, "sysHub", "Delivery lag (typical / slow)")).toBe("–");
    // A figure the hub does not report is a dash, never 0.
    expect(fact(host, "sysHub", "Broadcast queue")).toBe("–");

    expect(fact(host, "sysDatabase", "Database file")).toBe("100.0 MB");
    expect(fact(host, "sysDatabase", "Schema")).toBe("089_example");
    expect(fact(host, "sysDatabase", "Readers in use")).toBe("1 of 8 (3 open)");
    expect(fact(host, "sysDatabase", "Waits for the writer")).toBe("2 (16 ms total)");

    expect(host.querySelector("#sysVoice")?.textContent).toContain("Dashboard's LiveKit card");

    expect(fact(host, "sysProcess", "Version")).toBe("2.8.0");
    expect(fact(host, "sysProcess", "Uptime")).toBe("2d 3h");
    expect(fact(host, "sysProcess", "Build")).toBe("0123456789ab");
  });

  it("lists each card's attention signals and links raised ones to the Dashboard", async () => {
    const booted = await boot([], () => HEALTH);
    dom = booted.dom;
    const host = render(dom, await booted.bridge.renderSystemHealth());
    const db = host.querySelector("#sysDatabase")!;
    expect(db.querySelector(".sys-signals")?.textContent).toContain("Database writer wait");
    expect(db.querySelector(".badge-yellow")?.textContent).toBe("Warning");
    expect(db.querySelector('[data-action="navigateTo"]')?.getAttribute("data-args")).toContain(
      "dashboard",
    );
    // An ok signal shows but raises no link.
    const hub = host.querySelector("#sysHub")!;
    expect(hub.querySelector(".sys-signals")?.textContent).toContain("Client reconnects");
    expect(hub.querySelector('[data-action="navigateTo"]')).toBeNull();
    expect(host.querySelector("#sysProcess .sys-signals")?.textContent).toContain(
      "Maintenance: Backups",
    );
    expect(host.querySelector("#sysProcess .badge-red")?.textContent).toBe("Critical");
  });

  it("shows the managed LiveKit's supervisor state", async () => {
    const managed = {
      ...HEALTH,
      livekit: { managed: true },
      snapshot: {
        ...HEALTH.snapshot,
        livekit_managed: true,
        livekit_healthy: false,
        livekit_gave_up: true,
        livekit_restarts: 5,
      },
    };
    const booted = await boot([], () => managed);
    dom = booted.dom;
    const host = render(dom, await booted.bridge.renderSystemHealth());
    expect(fact(host, "sysVoice", "State")).toBe("Stopped restarting");
    expect(fact(host, "sysVoice", "Restarts")).toBe("5");
  });

  // A locked or slow database: the server answers "timeout" for that card
  // only, and the other cards still fill in.
  it("shows a database that could not be read without hiding the other cards", async () => {
    const booted = await boot([], () => ({
      ...HEALTH,
      database: { status: "timeout", stats: null },
    }));
    dom = booted.dom;
    const host = render(dom, await booted.bridge.renderSystemHealth());
    expect(host.querySelector("#sysDatabase")?.textContent).toContain("Could not read");
    expect(host.querySelector("#sysDatabase dl")).toBeNull();
    expect(fact(host, "sysHub", "Users online")).toBe("14");
  });

  it("keeps the last figures and says so when a refresh fails", async () => {
    let fail = false;
    const booted = await boot([], () =>
      fail ? { __status: 500, body: { message: "boom" } } : HEALTH,
    );
    dom = booted.dom;
    const { bridge } = booted;
    render(dom, await bridge.renderSystemHealth());
    fail = true;
    await bridge.pollSystemHealth(bridge.sysHealth.seq, "tok");
    const body = dom.window.document.getElementById("sysHealthBody")!;
    expect(body.querySelector(".sys-stale")).toBeTruthy();
    expect(body.querySelector("#sysHub")).toBeTruthy();
    expect(bridge.sysHealth.timer).not.toBeNull();
  });

  it("stops polling when the permission is gone", async () => {
    let refuse = false;
    const booted = await boot([], () =>
      refuse ? { __status: 403, body: { message: "no" } } : HEALTH,
    );
    dom = booted.dom;
    const { bridge } = booted;
    render(dom, await bridge.renderSystemHealth());
    refuse = true;
    await bridge.pollSystemHealth(bridge.sysHealth.seq, "tok");
    expect(bridge.sysHealth.timer).toBeNull();
    // The frozen figures say why they stopped refreshing.
    const body = dom.window.document.getElementById("sysHealthBody")!;
    expect(body.querySelector(".sys-stale")?.textContent).toContain("stopped refreshing");
  });

  it("explains a refusal on the first load instead of loading forever", async () => {
    const booted = await boot([], () => ({ __status: 403, body: { message: "no" } }));
    dom = booted.dom;
    const host = render(dom, await booted.bridge.renderSystemHealth());
    expect(host.textContent).toContain("can no longer view this page");
    expect(host.textContent).not.toContain("Loading");
  });

  // Leaving the page while a poll is in flight: the late answer must not
  // repaint or restart the timer.
  it("drops a poll answered after leaving the page and stops polling", async () => {
    let release: ((v: unknown) => void) | undefined;
    let hold = false;
    const booted = await boot([], () =>
      hold
        ? new Promise((resolve) => {
            release = resolve;
          })
        : HEALTH,
    );
    dom = booted.dom;
    const { bridge } = booted;
    render(dom, await bridge.renderSystemHealth());
    const before = bridge.sysHealth.data;

    hold = true;
    const inFlight = bridge.pollSystemHealth(bridge.sysHealth.seq, "tok");
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
    expect(release).toBeDefined();
    bridge.state.section = "users";
    release!({ ...HEALTH, snapshot: { ...HEALTH.snapshot, connected_users: 99 } });
    await inFlight;

    expect(bridge.sysHealth.data).toBe(before);
    expect(bridge.sysHealth.timer).toBeNull();
  });

  it("drops an answer from a superseded render", async () => {
    let release: ((v: unknown) => void) | undefined;
    let hold = false;
    const booted = await boot([], () =>
      hold
        ? new Promise((resolve) => {
            release = resolve;
          })
        : HEALTH,
    );
    dom = booted.dom;
    const { bridge } = booted;
    render(dom, await bridge.renderSystemHealth());
    const oldSeq = bridge.sysHealth.seq;

    hold = true;
    const stale = bridge.pollSystemHealth(oldSeq, "tok");
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
    const staleRelease = release!;
    hold = false;
    render(dom, await bridge.renderSystemHealth());
    expect(bridge.sysHealth.seq).toBe(oldSeq + 1);

    staleRelease({ ...HEALTH, snapshot: { ...HEALTH.snapshot, connected_users: 99 } });
    await stale;
    expect((bridge.sysHealth.data as typeof HEALTH).snapshot.connected_users).toBe(14);
  });

  it("copies the bundle's health snapshot for support", async () => {
    const booted = await boot([], () => HEALTH);
    dom = booted.dom;
    let copied = "";
    Object.defineProperty(dom.window.navigator, "clipboard", {
      value: { writeText: async (t: string) => void (copied = t) },
      configurable: true,
    });
    render(dom, await booted.bridge.renderSystemHealth());
    booted.bridge.copySystemHealth();
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
    const parsed = JSON.parse(copied) as { health: typeof HEALTH.snapshot; build: unknown };
    expect(parsed.health).toEqual(HEALTH.snapshot);
    expect(parsed.build).toEqual(HEALTH.process.build);
  });
});
