// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// The sensitive rows of the owner-only "Server configuration" page: secrets
// are write-only fields, and a key that can lock the owner out (listener,
// TLS, admin perimeter, data paths, the executed LiveKit binary) is saved only
// after a typed confirmation, which the PATCH carries in X-OwnCord-Confirm.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  PERM: PERM,
  renderServerConfig: typeof renderServerConfig==='function'?renderServerConfig:undefined,
  markConfigChanged: typeof markConfigChanged==='function'?markConfigChanged:undefined,
  saveServerConfig: typeof saveServerConfig==='function'?saveServerConfig:undefined,
  confirmServerConfig: typeof confirmServerConfig==='function'?confirmServerConfig:undefined,
  clearConfigSecret: typeof clearConfigSecret==='function'?clearConfigSecret:undefined
};
</script>`;
const ADMIN_HTML = adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`);

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

interface Bridge {
  state: any;
  PERM: Record<string, number>;
  renderServerConfig?: () => Promise<string>;
  markConfigChanged?: () => void;
  saveServerConfig?: () => Promise<void>;
  confirmServerConfig?: () => Promise<void>;
  clearConfigSecret?: (key: string) => Promise<void>;
}

const GIF_SECRET = "klipy-secret-never-rendered";

const SETTINGS = {
  restart_pending: false,
  settings: [
    {
      key: "gif.api_key",
      type: "secret",
      value: null,
      override: null,
      configured: true,
      override_set: false,
      env_locked: false,
      requires_confirmation: false,
    },
    {
      key: "server.port",
      type: "int",
      value: 8443,
      override: null,
      env_locked: false,
      requires_confirmation: true,
    },
    {
      key: "server.name",
      type: "string",
      value: "OwnCord Server",
      override: null,
      env_locked: false,
      requires_confirmation: false,
    },
  ],
};

async function boot(calls: FetchCall[]): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const path = String(input).replace(/^\/admin\/api/, "");
        let body: unknown;
        if (typeof opts.body === "string") body = JSON.parse(opts.body);
        const headers = { ...(opts.headers as Record<string, string>) };
        calls.push({ method, path, body, headers });
        const json = path === "/config/settings" ? SETTINGS : {};
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => json,
          text: async () => JSON.stringify(json),
        } as Response;
      }) as typeof fetch;
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  calls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  bridge.state.me = { permissions: bridge.PERM.ADMINISTRATOR, is_owner: true };
  return { dom, bridge };
}

function fn<T>(f: T | undefined, name: string): T {
  if (typeof f !== "function") throw new Error(`expected the admin panel to define ${name}()`);
  return f;
}

async function render(dom: JSDOM, bridge: Bridge): Promise<Document> {
  const html = await fn(bridge.renderServerConfig, "renderServerConfig")();
  dom.window.document.getElementById("content")!.innerHTML = html;
  return dom.window.document;
}

function control(doc: Document, key: string): HTMLInputElement {
  const el = doc.querySelector<HTMLInputElement>(`[data-config-key="${key}"]`);
  if (!el) throw new Error(`expected a control with data-config-key="${key}"`);
  return el;
}

const patches = (calls: FetchCall[]) =>
  calls.filter((c) => c.method === "PATCH" && c.path === "/config/settings");

describe("Server/admin/static — sensitive server configuration", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("renders a secret as an empty write-only field that says whether one is set", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const doc = await render(dom, booted.bridge);

    const secret = control(doc, "gif.api_key");
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    expect(secret.getAttribute("autocomplete")).toBe("new-password");
    expect(doc.getElementById("content")!.innerHTML).not.toContain(GIF_SECRET);
    expect(doc.getElementById("content")!.textContent).toMatch(/configured/i);
    // data_dir is shown read-only with where to change it, never as a control.
    expect(doc.querySelector('[data-config-key="server.data_dir"]')).toBeNull();
  });

  it("sends a secret only when one is typed, and clears it with an empty string", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const doc = await render(dom, booted.bridge);

    control(doc, "server.name").value = "Renamed";
    fn(booted.bridge.markConfigChanged, "markConfigChanged")();
    await fn(booted.bridge.saveServerConfig, "saveServerConfig")();
    expect(patches(calls)).toHaveLength(1);
    expect(patches(calls)[0]!.body).toEqual({ "server.name": "Renamed" });

    calls.length = 0;
    const doc2 = await render(dom, booted.bridge);
    control(doc2, "gif.api_key").value = "new-key-123";
    fn(booted.bridge.markConfigChanged, "markConfigChanged")();
    await fn(booted.bridge.saveServerConfig, "saveServerConfig")();
    expect(patches(calls)[0]?.body).toEqual({ "gif.api_key": "new-key-123" });

    calls.length = 0;
    await fn(booted.bridge.clearConfigSecret, "clearConfigSecret")("gif.api_key");
    expect(patches(calls)[0]?.body).toEqual({ "gif.api_key": "" });
  });

  it("asks for a typed confirmation before saving a lock-out-capable key", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const doc = await render(dom, booted.bridge);

    control(doc, "server.port").value = "9443";
    fn(booted.bridge.markConfigChanged, "markConfigChanged")();
    await fn(booted.bridge.saveServerConfig, "saveServerConfig")();
    // Nothing is sent yet: a dialog names the key and wants CONFIRM typed.
    expect(patches(calls)).toHaveLength(0);
    const modal = doc.getElementById("modal")!;
    expect(modal.classList.contains("visible")).toBe(true);
    expect(modal.textContent).toContain("server.port");
    const typed = doc.getElementById("typedConfirm") as HTMLInputElement | null;
    expect(typed).toBeTruthy();

    const confirmSave = fn(booted.bridge.confirmServerConfig, "confirmServerConfig");
    await confirmSave();
    expect(patches(calls)).toHaveLength(0);

    typed!.value = "CONFIRM";
    await confirmSave();
    expect(patches(calls)).toHaveLength(1);
    expect(patches(calls)[0]!.body).toEqual({ "server.port": 9443 });
    expect(patches(calls)[0]!.headers["X-OwnCord-Confirm"]).toBe("server.port");
  });
});
