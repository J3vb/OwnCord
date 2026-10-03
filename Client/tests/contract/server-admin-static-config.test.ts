// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// Drives the admin panel's owner-only "Server configuration" page: the
// config.yaml settings the owner may override from the panel
// (GET/PATCH /admin/api/config/settings), saved to an overrides file and
// applied at the next restart (POST /admin/api/restart).
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const ADMIN_HTML_SOURCE = adminPanelHtml();

// Classic scripts: top-level bindings never land on `window`, so a bridge
// script copies them onto a test-only global. Each is looked up with typeof so
// a missing function fails its own assertion instead of the whole bridge.
const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  PERM: PERM,
  visibleNav: visibleNav,
  renderServerConfig: typeof renderServerConfig==='function'?renderServerConfig:undefined,
  markConfigChanged: typeof markConfigChanged==='function'?markConfigChanged:undefined,
  saveServerConfig: typeof saveServerConfig==='function'?saveServerConfig:undefined,
  resetConfigKey: typeof resetConfigKey==='function'?resetConfigKey:undefined,
  restartForConfig: typeof restartForConfig==='function'?restartForConfig:undefined
};
</script>`;
const ADMIN_HTML = ADMIN_HTML_SOURCE.replace("</body>", `${BRIDGE}\n</body>`);

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

type Responder = (path: string, method: string) => { status?: number; json?: unknown };

interface Bridge {
  state: any;
  PERM: Record<string, number>;
  visibleNav: () => Array<{ id?: string }>;
  renderServerConfig?: () => Promise<string>;
  markConfigChanged?: () => void;
  saveServerConfig?: () => Promise<void>;
  resetConfigKey?: (key: string) => Promise<void>;
  restartForConfig?: () => Promise<void>;
}

async function boot(
  fetchCalls: FetchCall[],
  respond: Responder,
): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const p = String(input).replace(/^\/admin\/api/, "");
        let body: unknown;
        if (typeof opts.body === "string") {
          try {
            body = JSON.parse(opts.body);
          } catch {
            body = opts.body;
          }
        }
        fetchCalls.push({ method, path: p, body });
        const r = respond(p, method);
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
  fetchCalls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  bridge.state.me = { permissions: bridge.PERM.ADMINISTRATOR, is_owner: true };
  return { dom, bridge };
}

function fn<T>(f: T | undefined, name: string): T {
  if (typeof f !== "function") throw new Error(`expected the admin panel to define ${name}()`);
  return f;
}

const CONFIG_SETTINGS = {
  restart_pending: false,
  settings: [
    {
      key: "logging.level",
      type: "string",
      value: "info",
      override: null,
      env_locked: false,
      options: ["debug", "info", "warn", "error"],
    },
    { key: "push.enabled", type: "bool", value: false, override: null, env_locked: false },
    { key: "server.allowed_origins", type: "list", value: [], override: null, env_locked: false },
    { key: "server.max_ws_connections", type: "int", value: 100, override: 100, env_locked: false },
    {
      key: "push.contact",
      type: "string",
      value: "ops@example.com",
      override: null,
      env_locked: true,
    },
    {
      key: "security.auth_rate_limit_multiplier",
      type: "float",
      value: 1,
      override: null,
      env_locked: false,
    },
  ],
};

async function renderInto(dom: JSDOM, bridge: Bridge): Promise<Document> {
  const html = await fn(bridge.renderServerConfig, "renderServerConfig")();
  const content = dom.window.document.getElementById("content");
  if (!content) throw new Error("expected #content in the static shell");
  content.innerHTML = html;
  return dom.window.document;
}

function control(doc: Document, key: string): HTMLInputElement | HTMLSelectElement {
  const el = doc.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-config-key="${key}"]`);
  if (!el) throw new Error(`expected a control with data-config-key="${key}"`);
  return el;
}

describe("Server/admin/static — Server configuration page", () => {
  let dom: JSDOM | undefined;

  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("is an owner-only page", async () => {
    const booted = await boot([], () => ({ json: {} }));
    dom = booted.dom;
    expect(booted.bridge.visibleNav().some((n) => n.id === "config")).toBe(true);
    booted.bridge.state.me = { permissions: booted.bridge.PERM.ADMINISTRATOR, is_owner: false };
    expect(booted.bridge.visibleNav().some((n) => n.id === "config")).toBe(false);
  });

  it("renders one control per setting, grouped by section, with env-locked rows disabled", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls, (p) =>
      p === "/config/settings" ? { json: CONFIG_SETTINGS } : { json: {} },
    );
    dom = booted.dom;
    const doc = await renderInto(dom, booted.bridge);

    expect(calls.some((c) => c.method === "GET" && c.path === "/config/settings")).toBe(true);
    expect(doc.querySelectorAll("[data-config-key]").length).toBe(CONFIG_SETTINGS.settings.length);
    // One card per config section: logging, push, server, security.
    expect(doc.querySelectorAll("#content section.section-card").length).toBe(4);
    // An enum renders its options; the env-pinned value cannot be edited.
    const level = control(doc, "logging.level");
    expect(level.tagName).toBe("SELECT");
    expect(Array.from((level as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
    expect(control(doc, "push.contact").disabled).toBe(true);
    expect(doc.getElementById("content")!.textContent).toMatch(/environment/i);
    // Every change needs a restart, and the page says so.
    expect(doc.getElementById("content")!.textContent).toMatch(/restart/i);
    // A saved override can be reset to the config.yaml value.
    const reset = doc.querySelector('[data-action="resetConfigKey"]');
    expect(reset?.getAttribute("data-args") ?? "").toContain("server.max_ws_connections");
  });

  it("saves only the changed keys, with typed values", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls, (p) =>
      p === "/config/settings" ? { json: CONFIG_SETTINGS } : { json: {} },
    );
    dom = booted.dom;
    const doc = await renderInto(dom, booted.bridge);

    control(doc, "server.max_ws_connections").value = "250";
    control(doc, "server.allowed_origins").value = "https://a.example, https://b.example";
    fn(booted.bridge.markConfigChanged, "markConfigChanged")();
    await fn(booted.bridge.saveServerConfig, "saveServerConfig")();

    const patches = calls.filter((c) => c.method === "PATCH" && c.path === "/config/settings");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({
      "server.max_ws_connections": 250,
      "server.allowed_origins": ["https://a.example", "https://b.example"],
    });
  });

  it("shows the environment-pinned value on an env-locked row, not a stale override", async () => {
    const calls: FetchCall[] = [];
    const settings = {
      restart_pending: false,
      settings: [
        {
          key: "logging.level",
          type: "string",
          value: "warn",
          override: "debug",
          env_locked: true,
          options: ["debug", "info", "warn", "error"],
        },
      ],
    };
    const booted = await boot(calls, (p) =>
      p === "/config/settings" ? { json: settings } : { json: {} },
    );
    dom = booted.dom;
    const doc = await renderInto(dom, booted.bridge);

    const level = control(doc, "logging.level") as HTMLSelectElement;
    expect(level.disabled).toBe(true);
    expect(level.value).toBe("warn");
  });

  it("does not write a spurious override for an enum value outside its options", async () => {
    const calls: FetchCall[] = [];
    const settings = {
      restart_pending: false,
      settings: [
        {
          key: "logging.level",
          type: "string",
          value: "verbose",
          override: null,
          env_locked: false,
          options: ["debug", "info", "warn", "error"],
        },
        {
          key: "server.max_ws_connections",
          type: "int",
          value: 100,
          override: null,
          env_locked: false,
        },
      ],
    };
    const booted = await boot(calls, (p) =>
      p === "/config/settings" ? { json: settings } : { json: {} },
    );
    dom = booted.dom;
    const doc = await renderInto(dom, booted.bridge);

    const level = control(doc, "logging.level") as HTMLSelectElement;
    expect(level.value).toBe("verbose");

    control(doc, "server.max_ws_connections").value = "250";
    fn(booted.bridge.markConfigChanged, "markConfigChanged")();
    await fn(booted.bridge.saveServerConfig, "saveServerConfig")();

    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/config/settings");
    expect(patch?.body).toEqual({ "server.max_ws_connections": 250 });
  });

  it("resets a key by sending null", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls, (p) =>
      p === "/config/settings" ? { json: CONFIG_SETTINGS } : { json: {} },
    );
    dom = booted.dom;
    await renderInto(dom, booted.bridge);

    await fn(booted.bridge.resetConfigKey, "resetConfigKey")("server.max_ws_connections");
    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/config/settings");
    expect(patch?.body).toEqual({ "server.max_ws_connections": null });
  });

  it("links to the Settings page for the server name", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls, (p) =>
      p === "/config/settings" ? { json: CONFIG_SETTINGS } : { json: {} },
    );
    dom = booted.dom;
    const doc = await renderInto(dom, booted.bridge);

    const link = doc.querySelector<HTMLElement>(
      '#content [data-action="navigateTo"][data-args*="settings"]',
    );
    expect(link).toBeTruthy();
    link!.click();
    expect(booted.bridge.state.section).toBe("settings");
  });

  it("offers Restart now once a change is pending, and it posts /restart", async () => {
    const calls: FetchCall[] = [];
    const pending = { ...CONFIG_SETTINGS, restart_pending: true };
    const booted = await boot(calls, (p, m) => {
      if (p === "/config/settings") return { json: pending };
      if (p === "/restart" && m === "POST") return { status: 202, json: { restarting: true } };
      return { json: {} };
    });
    dom = booted.dom;
    const doc = await renderInto(dom, booted.bridge);

    expect(doc.querySelector('[data-action="restartForConfig"]')).toBeTruthy();
    await fn(booted.bridge.restartForConfig, "restartForConfig")();
    expect(calls.some((c) => c.method === "POST" && c.path === "/restart")).toBe(true);
  });
});
