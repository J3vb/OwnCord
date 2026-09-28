// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// Loads the real admin panel (Server/admin/static, the Go admin panel's SPA)
// into a scripted jsdom window and drives its log stream connection logic
// directly, the same way a browser would. jsdom does
// not implement EventSource, so a minimal fake stands in for it — this test
// only needs its constructor, onmessage and close() to be observable.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const ADMIN_HTML_SOURCE = adminPanelHtml();

const BRIDGE = `<script>
window.__test = {
  state: state,
  connectLogStream: connectLogStream,
  renderLogs: renderLogs
};
</script>`;
if (!ADMIN_HTML_SOURCE.includes("</body>")) {
  throw new Error("expected Server/admin/static/index.html to contain </body>");
}
const ADMIN_HTML = ADMIN_HTML_SOURCE.replace("</body>", `${BRIDGE}\n</body>`);

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function loadAdminPanel(fetchCalls: FetchCall[]): JSDOM {
  return new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const p = String(input).replace(/^\/admin\/api/, "");
        const call: FetchCall = { method, path: p };
        if (typeof opts.body === "string") {
          try {
            call.body = JSON.parse(opts.body);
          } catch {
            /* non-JSON body, leave undefined */
          }
        }
        fetchCalls.push(call);
        if (p === "/setup/status") {
          return { ok: true, status: 200, json: async () => ({ needs_setup: false }) } as Response;
        }
        if (p === "/logs/ticket") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ticket: "t-" + fetchCalls.length }),
          } as Response;
        }
        if (p === "/logs/level" && method === "PATCH") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              level: (opts.body as string) && JSON.parse(opts.body as string).level,
              reverts_at: new Date(Date.now() + 900000).toISOString(),
            }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }) as typeof fetch;
    },
  });
}

interface Bridge {
  state: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  connectLogStream: () => Promise<void>;
  renderLogs: () => string;
}

function backfillEntry(i: number) {
  return {
    ts: "2026-09-12T00:00:00Z",
    level: "INFO",
    source: "server",
    msg: "line " + i,
    attrs: "{}",
  };
}

describe("Server/admin/static — log stream (re)connect (OC-0435)", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
    FakeEventSource.instances = [];
  });

  it("replaces the buffered entries on reconnect instead of appending the server's full replay on top", async () => {
    const fetchCalls: FetchCall[] = [];
    dom = loadAdminPanel(fetchCalls);
    const { window } = dom;

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const bridge = (window as unknown as { __test: Bridge }).__test;
    expect(bridge).toBeTruthy();
    bridge.state.section = "logs";

    // First connect: the server replays its whole ring-buffer backfill.
    await bridge.connectLogStream();
    expect(FakeEventSource.instances.length).toBe(1);
    const first = FakeEventSource.instances[0];
    expect(first).toBeDefined();
    for (let i = 0; i < 5; i++) {
      first?.onmessage?.({ data: JSON.stringify(backfillEntry(i)) });
    }
    expect(bridge.state.logEntries.length).toBe(5);

    // Re-entering the Logs tab (or an SSE error) tears down the old stream
    // and calls connectLogStream() again, exactly like navigateTo/
    // scheduleLogReconnect do.
    await bridge.connectLogStream();
    expect(FakeEventSource.instances.length).toBe(2);
    const second = FakeEventSource.instances[1];
    expect(second).toBeDefined();

    // The old backfill is still on screen: nothing has replaced it yet, and
    // a new stream that never connects must not leave the operator with a
    // blank view (OC-0443).
    expect(bridge.state.logEntries.length).toBe(5);

    // The replacement stream opens — now the buffer is replaced, before a
    // single replayed line has been pushed. The replay is a superset of
    // anything already held, so nothing is lost by clearing at this point.
    second?.onopen?.();
    expect(bridge.state.logEntries.length).toBe(0);

    for (let i = 0; i < 5; i++) {
      second?.onmessage?.({ data: JSON.stringify(backfillEntry(i)) });
    }

    // Not 10: each backfilled line must appear once, not once per connect.
    expect(bridge.state.logEntries.length).toBe(5);
  });

  // OC-0443: the OC-0435 replacement used to happen as soon as the ticket
  // came back, before the replacement EventSource had connected. An SSE
  // outage retries every 1.5s, so every retry blanked the operator's log
  // view and left it blank for as long as the server stayed unreachable —
  // exactly when those buffered lines are most worth reading.
  it("keeps the existing entries on screen when a reconnect's new stream never connects", async () => {
    const fetchCalls: FetchCall[] = [];
    dom = loadAdminPanel(fetchCalls);
    const { window } = dom;

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const bridge = (window as unknown as { __test: Bridge }).__test;
    expect(bridge).toBeTruthy();
    bridge.state.section = "logs";

    await bridge.connectLogStream();
    const first = FakeEventSource.instances[0];
    expect(first).toBeDefined();
    for (let i = 0; i < 5; i++) {
      first?.onmessage?.({ data: JSON.stringify(backfillEntry(i)) });
    }
    expect(bridge.state.logEntries.length).toBe(5);

    // The stream drops and the reconnect's own stream fails too: no open,
    // no message, just an error.
    await bridge.connectLogStream();
    const second = FakeEventSource.instances[1];
    expect(second).toBeDefined();
    second?.onerror?.();

    expect(bridge.state.logEntries.length).toBe(5);
  });

  // The replacement must also survive a stream that delivers without ever
  // firing onopen — the clear is owed to the first sign of the new stream,
  // whichever arrives, and must happen exactly once.
  it("replaces the buffer on the first replayed line when no open event fires", async () => {
    const fetchCalls: FetchCall[] = [];
    dom = loadAdminPanel(fetchCalls);
    const { window } = dom;

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const bridge = (window as unknown as { __test: Bridge }).__test;
    expect(bridge).toBeTruthy();
    bridge.state.section = "logs";

    await bridge.connectLogStream();
    const first = FakeEventSource.instances[0];
    for (let i = 0; i < 5; i++) {
      first?.onmessage?.({ data: JSON.stringify(backfillEntry(i)) });
    }

    await bridge.connectLogStream();
    const second = FakeEventSource.instances[1];
    expect(second).toBeDefined();
    for (let i = 0; i < 5; i++) {
      second?.onmessage?.({ data: JSON.stringify(backfillEntry(i)) });
    }

    expect(bridge.state.logEntries.length).toBe(5);
  });

  // AO-7. The toolbar carried Unicode glyphs ("⏸" is a missing-glyph box in
  // Linux Chromium) and level chips whose on/off state was colour only.
  it("renders level chips as aria-pressed toggles and an icon toolbar", async () => {
    const fetchCalls: FetchCall[] = [];
    dom = loadAdminPanel(fetchCalls);
    const { window } = dom;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const bridge = (window as unknown as { __test: Bridge }).__test;
    const doc = window.document;
    bridge.state.section = "logs";
    doc.getElementById("content")!.innerHTML = bridge.renderLogs();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const toolbar = doc.querySelector(".log-toolbar")!;
    expect(toolbar.textContent).not.toMatch(/[⬇⏸▶]/);
    expect(doc.querySelector('[role="group"][aria-label="Show levels"]')).not.toBeNull();
    const chip = (l: string) =>
      doc.querySelector<HTMLButtonElement>(`.level-toggle[data-level="${l}"]`)!;
    for (const l of ["DEBUG", "INFO", "WARN", "ERROR"]) {
      expect(chip(l).getAttribute("aria-pressed")).toBe("true");
    }

    const es = FakeEventSource.instances[0]!;
    es.onmessage?.({
      data: JSON.stringify({ ...backfillEntry(1), ts: "2026-09-12T08:15:30.250Z" }),
    });
    es.onmessage?.({ data: JSON.stringify({ ...backfillEntry(2), level: "WARN" }) });
    expect(doc.querySelectorAll("#logOutput .log-line")).toHaveLength(2);
    // Local time on screen, the UTC instant in the tooltip (fmtLocal).
    expect(doc.querySelector("#logOutput .log-ts span")!.getAttribute("title")).toBe(
      "2026-09-12T08:15:30.250Z",
    );

    chip("INFO").click();
    expect(chip("INFO").getAttribute("aria-pressed")).toBe("false");
    expect(doc.querySelectorAll("#logOutput .log-line")).toHaveLength(1);
    chip("INFO").click();
    expect(chip("INFO").getAttribute("aria-pressed")).toBe("true");

    const auto = doc.getElementById("autoScrollBtn")!;
    expect(auto.getAttribute("aria-pressed")).toBe("true");
    auto.click();
    expect(auto.getAttribute("aria-pressed")).toBe("false");

    const pause = doc.getElementById("pauseBtn")!;
    expect(pause.textContent).toBe("Pause");
    pause.click();
    expect(pause.textContent).toBe("Resume");
    expect(pause.querySelector("svg")).not.toBeNull();

    // The log scrolls from the keyboard without being a live region.
    const out = doc.getElementById("logOutput")!;
    expect(out.getAttribute("tabindex")).toBe("0");
    expect(out.getAttribute("role")).toBe("region");
  });

  // SRE-07: the timed log-level toggle raises the server's own level for a
  // bounded window, then the server reverts it. The client mirrors the window
  // so the switch does not sit "on" past it.
  it("toggles the server log level for a bounded window, admin-gated", async () => {
    const fetchCalls: FetchCall[] = [];
    dom = loadAdminPanel(fetchCalls);
    const { window } = dom;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const bridge = (window as unknown as { __test: Bridge }).__test;
    const doc = window.document;
    // A non-admin sees the switch disabled with the reason.
    bridge.state.me = { permissions: 0, is_owner: false };
    bridge.state.section = "logs";
    doc.getElementById("content")!.innerHTML = bridge.renderLogs();
    const toggle = doc.getElementById("logLevelToggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(doc.getElementById("logLevelDesc")!.textContent).toContain("administrator");

    // An administrator can raise it; the PATCH carries a positive window.
    bridge.state.me = { permissions: 0x40000000, is_owner: true };
    doc.getElementById("content")!.innerHTML = bridge.renderLogs();
    const adminToggle = doc.getElementById("logLevelToggle") as HTMLButtonElement;
    expect(adminToggle.disabled).toBe(false);
    expect(adminToggle.getAttribute("role")).toBe("switch");
    fetchCalls.length = 0;
    adminToggle.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const patch = fetchCalls.find((c) => c.path === "/logs/level" && c.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch!.body).toMatchObject({ level: "debug" });
    expect(patch!.body.duration_seconds).toBeGreaterThan(0);
    expect(bridge.state.logLevel).toBe("debug");
    expect(adminToggle.getAttribute("aria-checked")).toBe("true");
  });
  // UX clarity: attrs read as chips, an http request as "METHOD path ·
  // status · ms" with the status class carried by a class and the number,
  // and the full attrs behind a per-line details; the filter still searches
  // the raw text.
  it("renders structured log lines with the full attrs behind details", async () => {
    const fetchCalls: FetchCall[] = [];
    dom = loadAdminPanel(fetchCalls);
    const { window } = dom;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const bridge = (window as unknown as { __test: Bridge }).__test;
    const doc = window.document;
    bridge.state.section = "logs";
    doc.getElementById("content")!.innerHTML = bridge.renderLogs();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const es = FakeEventSource.instances[0]!;
    const attrs = JSON.stringify({
      method: "GET",
      path: "/admin/api/channels",
      status: 404,
      duration_ms: 3,
      client_ip: "10.0.0.<b>1</b>",
    });
    es.onmessage?.({ data: JSON.stringify({ ...backfillEntry(1), msg: "http request", attrs }) });
    es.onmessage?.({ data: JSON.stringify({ ...backfillEntry(2), attrs: "not json" }) });

    const [req, raw] = [...doc.querySelectorAll("#logOutput .log-line")];
    const chips = [...req!.querySelectorAll(".log-chips > .log-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["GET /admin/api/channels", "404", "3 ms"]);
    expect(req!.querySelector(".log-status-4xx")?.textContent).toBe("404");
    // The rest of an http line's attrs wait in its details, escaped.
    expect(req!.querySelector(".log-more pre")?.textContent).toContain("10.0.0.<b>1</b>");
    expect(req!.querySelector(".log-more b")).toBeNull();
    expect(JSON.parse(req!.querySelector(".log-more pre")!.textContent!)).toEqual(
      JSON.parse(attrs),
    );
    // Any other line reads as key=value chips; unparseable attrs still show, as text.
    es.onmessage?.({
      data: JSON.stringify({ ...backfillEntry(3), msg: "setup", attrs: '{"owner":"alice"}' }),
    });
    expect(
      doc.querySelectorAll("#logOutput .log-line")[2]!.querySelector(".log-chip")?.textContent,
    ).toBe("owner=alice");
    expect(raw!.querySelector(".log-raw")?.textContent).toBe("not json");

    // The filter matches the raw attrs, including keys no chip shows.
    const search = doc.querySelector<HTMLInputElement>(".log-filter")!;
    search.value = "client_ip";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(doc.querySelectorAll("#logOutput .log-line")).toHaveLength(1);
  });

  // Waiting is grey and never healthy: the dot turns live only once the
  // stream opens, on first connect, after an error, and on resume.
  it("shows a grey dot while connecting or reconnecting and a live dot only once open", async () => {
    const fetchCalls: FetchCall[] = [];
    dom = loadAdminPanel(fetchCalls);
    const { window } = dom;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const bridge = (window as unknown as { __test: Bridge }).__test;
    const doc = window.document;
    bridge.state.section = "logs";
    doc.getElementById("content")!.innerHTML = bridge.renderLogs();
    const conn = () => [
      doc.getElementById("logDot")!.className,
      doc.getElementById("logStatusText")!.textContent,
    ];
    const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(conn()).toEqual(["dot-wait", "Connecting..."]);
    await tick();
    await tick();
    FakeEventSource.instances[0]!.onopen?.();
    expect(conn()).toEqual(["dot-live", "Connected"]);

    FakeEventSource.instances[0]!.onerror?.();
    expect(conn()).toEqual(["dot-wait", "Reconnecting..."]);

    const pause = doc.getElementById("pauseBtn")!;
    pause.click();
    expect(conn()).toEqual(["dot-off", "Paused"]);
    pause.click();
    expect(conn()).toEqual(["dot-wait", "Connecting..."]);
    await tick();
    await tick();
    FakeEventSource.instances.at(-1)!.onopen?.();
    expect(conn()).toEqual(["dot-live", "Connected"]);
  });
});
