// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// Loads the real Server/admin/static/index.html (the Go admin panel's
// single-file SPA) into a scripted jsdom window and drives its inline log
// stream connection logic directly, the same way a browser would. jsdom does
// not implement EventSource, so a minimal fake stands in for it — this test
// only needs its constructor, onmessage and close() to be observable.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

const ADMIN_HTML_PATH = path.resolve(__dirname, "../../../Server/admin/static/index.html");
const ADMIN_HTML_SOURCE = readFileSync(ADMIN_HTML_PATH, "utf8");

const BRIDGE = `<script>
window.__test = {
  state: state,
  connectLogStream: connectLogStream
};
</script>`;
if (!ADMIN_HTML_SOURCE.includes("</body>")) {
  throw new Error("expected Server/admin/static/index.html to contain </body>");
}
const ADMIN_HTML = ADMIN_HTML_SOURCE.replace("</body>", `${BRIDGE}\n</body>`);

interface FetchCall {
  method: string;
  path: string;
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
        fetchCalls.push({ method, path: p });
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
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }) as typeof fetch;
    },
  });
}

interface Bridge {
  state: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  connectLogStream: () => Promise<void>;
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

describe("Server/admin/static/index.html — log stream (re)connect (OC-0435)", () => {
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
});
