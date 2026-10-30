// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because the Go module carries no JavaScript engine (see
// docs/contributing.md#testing). It runs the admin Dashboard's health row
// (js/health.js) against a stubbed GET /admin/api/system/stats.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = {
  get state(){return state}, get health(){return health},
  renderDashboard: renderDashboard, startHealthPoll: startHealthPoll, pollHealth: pollHealth,
};
</script>`;
const ADMIN_HTML = adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`);

const ADMINISTRATOR = 0x40000000;
const MANAGE_CHANNELS = 0x20000;

interface Bridge {
  state: { me: unknown; section: string; token: string };
  health: { seq: number; timer: unknown; data: unknown };
  renderDashboard: () => Promise<string>;
  startHealthPoll: () => Promise<void>;
  pollHealth: (seq: number, token: string) => Promise<void>;
}

type Responder = (path: string) => Promise<unknown> | unknown;

async function boot(paths: string[], respond: Responder): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = (async (input: string) => {
        const p = String(input).replace(/^\/admin\/api/, "");
        paths.push(p);
        const json = p === "/setup/status" ? { needs_setup: false } : await respond(p);
        return { ok: true, status: 200, json: async () => json ?? {} } as Response;
      }) as typeof fetch;
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  paths.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  bridge.state.token = "tok";
  bridge.state.section = "dashboard";
  return { dom, bridge };
}

const T = 1_793_386_035;
// Two minutes of 5-second samples ending at T.
function series(cpu: (i: number) => number | null, n = 24) {
  return Array.from({ length: n }, (_, i) => ({
    t: T - (n - 1 - i) * 5,
    process_cpu: cpu(i) === null ? null : 3.1,
    machine_cpu: cpu(i),
    process_memory: 195_035_136 + i * 1000,
    memory_used: 9_771_487_232,
  }));
}

const STATS = {
  interval_seconds: 5,
  window_seconds: 3600,
  uptime_seconds: 6 * 86400 + 4 * 3600 + 120,
  online_users: 14,
  cpu_cores: 8,
  memory_total: 17_179_869_184,
  memory_scope: "machine",
  current: {
    t: T,
    process_cpu: 3.1,
    machine_cpu: 7.4,
    process_memory: 195_035_136,
    memory_used: 9_771_487_232,
  },
  series: series(() => 7.4),
  disk: {
    free: 32_212_254_720,
    total: 128_849_018_880,
    min_free: 1_073_741_824,
    low: false,
    uploads: 41_016_705_024,
  },
};

function render(dom: JSDOM, html: string): Element {
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;
  dom.window.document.getElementById("content")!.replaceChildren(host);
  return host;
}

const tile = (host: Element, id: string) => host.querySelector(`#${id}`)!;
const text = (host: Element, id: string, part: string) =>
  tile(host, id).querySelector(`.${part}`)?.textContent;

describe("Server/admin/static — Dashboard health row", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("shows CPU, RAM, disk free and uptime with one-hour lines", async () => {
    const paths: string[] = [];
    const booted = await boot(paths, (p) => (p.startsWith("/system/stats") ? STATS : {}));
    dom = booted.dom;
    booted.bridge.state.me = { permissions: ADMINISTRATOR };
    const host = render(dom, await booted.bridge.renderDashboard());
    expect(paths).toContain("/system/stats?window=1h");

    expect(host.querySelector("#healthRow")).toBeTruthy();
    expect(text(host, "healthCpu", "health-value")).toBe("7.4%");
    expect(text(host, "healthCpu", "health-sub")).toBe("OwnCord 3.1% · machine 7.4% · 8 cores");
    expect(tile(host, "healthCpu").querySelector(".health-spark-line")?.getAttribute("d")).toMatch(
      /^M0\.0 /,
    );
    expect(text(host, "healthRam", "health-value")).toBe("186.0 MB");
    expect(text(host, "healthRam", "health-sub")).toBe("machine 9.1 / 16 GB used");
    expect(tile(host, "healthRam").querySelector(".health-spark")).toBeTruthy();
    expect(text(host, "healthDisk", "health-value")).toBe("30.00 GB");
    expect(text(host, "healthDisk", "health-sub")).toBe("of 120.00 GB · uploads 38.20 GB");
    expect(tile(host, "healthDisk").querySelector(".health-meter")).toBeTruthy();
    expect(text(host, "healthUptime", "health-value")).toBe("6d 4h");
    expect(text(host, "healthUptime", "health-sub")).toBe("14 online");
    // Nothing is high, so no tile is tinted.
    expect(host.querySelector(".health-tile.warn, .health-tile.crit")).toBeNull();
  });

  // CPU needs two readings: for the first 5 seconds the server sends null,
  // which shows as a dash, never as 0%.
  it("shows a dash, never 0%, before the first CPU figure and before any reading", async () => {
    const first = {
      ...STATS,
      current: { ...STATS.current, process_cpu: null, machine_cpu: null },
      series: [{ ...STATS.series[0], process_cpu: null, machine_cpu: null }],
    };
    let answer: unknown = first;
    const booted = await boot([], () => answer);
    dom = booted.dom;
    booted.bridge.state.me = { permissions: ADMINISTRATOR };
    let host = render(dom, await booted.bridge.renderDashboard());
    expect(text(host, "healthCpu", "health-value")).toBe("–");
    expect(text(host, "healthCpu", "health-sub")).toBe("Measuring… · 8 cores");
    expect(tile(host, "healthCpu").textContent).not.toContain("0%");
    expect(tile(host, "healthCpu").querySelector(".health-spark")).toBeNull();
    expect(text(host, "healthRam", "health-value")).toBe("186.0 MB");

    // A server with nothing measured yet: every figure is a dash.
    answer = { interval_seconds: 5, window_seconds: 3600, current: null, series: [], disk: {} };
    host = render(dom, await booted.bridge.renderDashboard());
    for (const id of ["healthCpu", "healthRam", "healthDisk", "healthUptime"]) {
      expect(text(host, id, "health-value")).toBe("–");
    }
  });

  it("turns tiles yellow or red when CPU stays high, memory is nearly full or the disk is low", async () => {
    let answer: unknown = {
      ...STATS,
      current: { ...STATS.current, machine_cpu: 85, memory_used: 16_900_000_000 },
      series: series((i) => (i < 1 ? 10 : 85)),
      disk: { ...STATS.disk, free: 500_000_000, low: true },
    };
    const booted = await boot([], () => answer);
    dom = booted.dom;
    booted.bridge.state.me = { permissions: ADMINISTRATOR };
    let host = render(dom, await booted.bridge.renderDashboard());
    expect(tile(host, "healthCpu").classList.contains("warn")).toBe(true);
    expect(tile(host, "healthCpu").querySelector(".badge")?.textContent).toBe("High");
    expect(tile(host, "healthRam").classList.contains("crit")).toBe(true);
    expect(tile(host, "healthDisk").classList.contains("crit")).toBe(true);
    expect(tile(host, "healthDisk").querySelector(".badge")?.textContent).toBe("Low");

    // One busy sample is not sustained load.
    answer = { ...STATS, series: series((i) => (i === 23 ? 99 : 5)) };
    host = render(dom, await booted.bridge.renderDashboard());
    expect(tile(host, "healthCpu").classList.contains("warn")).toBe(false);
    expect(tile(host, "healthCpu").classList.contains("crit")).toBe(false);
  });

  it("is not requested or shown without View Diagnostics", async () => {
    const paths: string[] = [];
    const booted = await boot(paths, () => STATS);
    dom = booted.dom;
    booted.bridge.state.me = { permissions: MANAGE_CHANNELS };
    const host = render(dom, await booted.bridge.renderDashboard());
    expect(paths.some((p) => p.startsWith("/system/stats"))).toBe(false);
    expect(host.querySelector("#healthRow")).toBeNull();
    expect(booted.bridge.health.timer).toBeNull();
  });

  it("repaints on each poll and schedules the next one", async () => {
    let cpu = 7.4;
    const booted = await boot([], () => ({
      ...STATS,
      current: { ...STATS.current, machine_cpu: cpu },
    }));
    dom = booted.dom;
    booted.bridge.state.me = { permissions: ADMINISTRATOR };
    render(dom, await booted.bridge.renderDashboard());
    expect(booted.bridge.health.timer).not.toBeNull();

    cpu = 42;
    await booted.bridge.pollHealth(booted.bridge.health.seq, "tok");
    const doc = dom.window.document;
    expect(doc.querySelector("#healthCpu .health-value")?.textContent).toBe("42%");
    expect(booted.bridge.health.timer).not.toBeNull();
  });

  // Leaving the Dashboard while a poll is in flight: the late answer must
  // not repaint or restart the timer.
  it("drops a poll answered after leaving the Dashboard and stops polling", async () => {
    let release: ((v: unknown) => void) | undefined;
    let hold = false;
    const booted = await boot([], (p) => {
      if (!p.startsWith("/system/stats")) return {};
      if (!hold) return STATS;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    dom = booted.dom;
    const { bridge } = booted;
    bridge.state.me = { permissions: ADMINISTRATOR };
    render(dom, await bridge.renderDashboard());
    const before = bridge.health.data;

    hold = true;
    const inFlight = bridge.pollHealth(bridge.health.seq, "tok");
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
    expect(release).toBeDefined();
    bridge.state.section = "users";
    release!({ ...STATS, current: { ...STATS.current, machine_cpu: 99 } });
    await inFlight;

    expect(bridge.health.data).toBe(before);
    expect(bridge.health.timer).toBeNull();
    expect(dom.window.document.querySelector("#healthCpu .health-value")?.textContent).toBe("7.4%");
  });

  // A re-render (Refresh, or leaving and coming back) starts a new
  // generation; the old loop's late answer is dropped.
  it("drops an answer from a superseded render", async () => {
    let release: ((v: unknown) => void) | undefined;
    let hold = false;
    const booted = await boot([], (p) => {
      if (!p.startsWith("/system/stats")) return {};
      if (!hold) return STATS;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    dom = booted.dom;
    const { bridge } = booted;
    bridge.state.me = { permissions: ADMINISTRATOR };
    render(dom, await bridge.renderDashboard());
    const oldSeq = bridge.health.seq;

    hold = true;
    const stale = bridge.pollHealth(oldSeq, "tok");
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
    const staleRelease = release!;
    hold = false;
    await bridge.startHealthPoll();
    expect(bridge.health.seq).toBe(oldSeq + 1);
    const timer = bridge.health.timer;

    staleRelease({ ...STATS, current: { ...STATS.current, machine_cpu: 99 } });
    await stale;
    expect((bridge.health.data as typeof STATS).current.machine_cpu).toBe(7.4);
    expect(bridge.health.timer).toBe(timer);
  });

  it("stops polling when the session ends", async () => {
    const booted = await boot([], () => STATS);
    dom = booted.dom;
    const { bridge } = booted;
    bridge.state.me = { permissions: ADMINISTRATOR };
    render(dom, await bridge.renderDashboard());
    const seq = bridge.health.seq;
    bridge.state.token = "";
    await bridge.pollHealth(seq, "tok");
    expect(bridge.health.timer).toBeNull();
  });
  // A hung first request must not hold the rest of the Dashboard; the row
  // shows dashes and fills in when the answer arrives.
  it("renders the Dashboard without waiting on a hung first request", async () => {
    let release: ((v: unknown) => void) | undefined;
    const booted = await boot([], (p) =>
      p.startsWith("/system/stats")
        ? new Promise((resolve) => {
            release = resolve;
          })
        : {},
    );
    dom = booted.dom;
    const { bridge } = booted;
    bridge.state.me = { permissions: ADMINISTRATOR };
    const host = render(dom, await bridge.renderDashboard());
    expect(text(host, "healthCpu", "health-value")).toBe("–");

    release!(STATS);
    await new Promise((resolve) => dom!.window.setTimeout(resolve, 0));
    expect(dom.window.document.querySelector("#healthCpu .health-value")?.textContent).toBe("7.4%");
  }, 10_000);

  // Another session signing in on the same page never sees the last one's
  // figures, even when its own first request fails.
  it("clears the previous session's figures on a new sign-in", async () => {
    let fail = false;
    const booted = await boot([], (p) => {
      if (p.startsWith("/system/stats") && fail) throw new Error("down");
      return p.startsWith("/system/stats") ? STATS : {};
    });
    dom = booted.dom;
    const { bridge } = booted;
    bridge.state.me = { permissions: ADMINISTRATOR };
    render(dom, await bridge.renderDashboard());
    expect(bridge.health.data).not.toBeNull();

    fail = true;
    bridge.state.token = "other";
    const host = render(dom, await bridge.renderDashboard());
    expect(bridge.health.data).toBeNull();
    expect(text(host, "healthCpu", "health-value")).toBe("–");
  });
});
