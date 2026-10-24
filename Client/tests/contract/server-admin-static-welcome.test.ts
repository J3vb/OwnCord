// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// WP 8.6: the Settings page's "Welcome messages" card, driven against the real
// admin scripts in jsdom.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = { renderSettings: renderSettings, saveSettings: saveSettings };
</script>`;
const source = adminPanelHtml();
if (!source.includes("</body>")) {
  throw new Error("expected Server/admin/static/index.html to contain </body>");
}
const ADMIN_HTML = source.replace("</body>", `${BRIDGE}\n</body>`);

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}
interface Reply {
  status?: number;
  json?: unknown;
}
interface Bridge {
  renderSettings: () => Promise<string>;
  saveSettings: () => Promise<void>;
}

const CHANNELS = [
  { id: 1, name: "general", type: "text", archived: false },
  { id: 2, name: "lounge", type: "voice", archived: false },
  { id: 3, name: "old-news", type: "text", archived: true },
  { id: 4, name: "hello", type: "text", archived: false },
];

async function boot(
  calls: FetchCall[],
  respond: (path: string, method: string) => Reply,
): Promise<{ dom: JSDOM; bridge: Bridge; doc: Document }> {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const path = String(input).replace(/^\/admin\/api/, "");
        const body = typeof opts.body === "string" ? (JSON.parse(opts.body) as unknown) : undefined;
        calls.push({ method, path, body });
        const r =
          path === "/setup/status" ? { json: { needs_setup: false } } : respond(path, method);
        const status = r.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: new Headers(),
          json: async () => r.json ?? {},
          text: async () => JSON.stringify(r.json ?? {}),
        } as Response;
      }) as typeof fetch;
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  calls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  return { dom, bridge, doc: dom.window.document };
}

async function mountSettings(bridge: Bridge, doc: Document): Promise<void> {
  const content = doc.getElementById("content");
  if (!content) throw new Error("expected #content");
  content.innerHTML = await bridge.renderSettings();
}

describe("Server/admin/static — Welcome messages card (WP 8.6)", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  function responder(opts: { channels: unknown; welcome?: string }) {
    return (path: string, method: string): Reply => {
      if (path === "/settings" && method === "GET") {
        return {
          json: {
            server_name: "T",
            registration_mode: "invite",
            ...(opts.welcome === undefined ? {} : { welcome_channel_id: opts.welcome }),
          },
        };
      }
      if (path === "/settings" && method === "PATCH") return { json: {} };
      if (path === "/channels")
        return opts.channels ? { json: opts.channels } : { status: 403, json: { error: "no" } };
      return { json: {} };
    };
  }

  it("offers Off then every non-archived text channel, with the hint", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, responder({ channels: CHANNELS }));
    dom = b.dom;
    await mountSettings(b.bridge, b.doc);
    const sel = b.doc.getElementById("s-welcome_channel_id") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Off", "general", "hello"]);
    expect(sel.value).toBe("");
    expect(b.doc.getElementById("s-welcome_channel_id-desc")?.textContent).toBe(
      "A line greets each new member in this channel.",
    );
  });

  it("saves a chosen channel and clears it back to empty, sending nothing when unchanged", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, responder({ channels: CHANNELS, welcome: "4" }));
    dom = b.dom;
    await mountSettings(b.bridge, b.doc);
    const sel = b.doc.getElementById("s-welcome_channel_id") as HTMLSelectElement;
    expect(sel.value).toBe("4");

    (b.doc.getElementById("saveSettingsBtn") as HTMLButtonElement).disabled = false;
    await b.bridge.saveSettings();
    expect(calls.find((c) => c.path === "/settings" && c.method === "PATCH")).toBeUndefined();

    sel.value = "";
    (b.doc.getElementById("saveSettingsBtn") as HTMLButtonElement).disabled = false;
    await b.bridge.saveSettings();
    expect(calls.find((c) => c.path === "/settings" && c.method === "PATCH")?.body).toEqual({
      welcome_channel_id: "",
    });
  });

  it("keeps a saved channel that was archived since, marked, so a save does not clear it", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, responder({ channels: CHANNELS, welcome: "3" }));
    dom = b.dom;
    await mountSettings(b.bridge, b.doc);
    const sel = b.doc.getElementById("s-welcome_channel_id") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toContain("old-news (archived)");
    expect(sel.value).toBe("3");
  });

  it("shows a disabled select outside the save when the channel list is unreadable", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, responder({ channels: null, welcome: "4" }));
    dom = b.dom;
    await mountSettings(b.bridge, b.doc);
    expect(b.doc.getElementById("s-welcome_channel_id")).toBeNull();
    const sel = b.doc.getElementById("s-welcome_channel_unavailable") as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
    (b.doc.getElementById("saveSettingsBtn") as HTMLButtonElement).disabled = false;
    await b.bridge.saveSettings();
    expect(calls.find((c) => c.path === "/settings" && c.method === "PATCH")).toBeUndefined();
  });
});
