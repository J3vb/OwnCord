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
  clearConfigSecret: typeof clearConfigSecret==='function'?clearConfigSecret:undefined,
  clearConfigSecretValue: typeof clearConfigSecretValue==='function'?clearConfigSecretValue:undefined,
  resetConfigKey: typeof resetConfigKey==='function'?resetConfigKey:undefined,
  configMovedAddress: typeof configMovedAddress==='function'?configMovedAddress:undefined
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
  clearConfigSecretValue?: (key: string) => Promise<void>;
  resetConfigKey?: (key: string) => Promise<void>;
  configMovedAddress?: () => string;
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
      allow_empty: true,
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

async function boot(
  calls: FetchCall[],
  settings: unknown = SETTINGS,
  patchSettings?: unknown,
): Promise<{ dom: JSDOM; bridge: Bridge }> {
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
        const json =
          path === "/config/settings"
            ? method === "PATCH" && patchSettings
              ? patchSettings
              : settings
            : {};
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
    // Configured in config.yaml but with no panel override: no no-op Remove.
    expect(doc.querySelector('[data-action="clearConfigSecret"]')).toBeNull();
    // data_dir is shown read-only with where to change it, never as a control.
    expect(doc.querySelector('[data-config-key="server.data_dir"]')).toBeNull();
  });

  it("sends a secret only when one is typed, and removes the override with null", async () => {
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
    expect(patches(calls)[0]?.body).toEqual({ "gif.api_key": null });
  });

  it("clears a secret whose rule allows an empty value by sending an empty string", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const doc = await render(dom, booted.bridge);

    expect(
      doc.querySelector('[data-action="clearConfigSecretValue"]'),
    ).not.toBeNull();
    calls.length = 0;
    await fn(booted.bridge.clearConfigSecretValue, "clearConfigSecretValue")("gif.api_key");
    expect(patches(calls)[0]?.body).toEqual({ "gif.api_key": "" });
  });

  it("offers no Clear value action for a secret whose rule requires a value", async () => {
    const calls: FetchCall[] = [];
    const settings = {
      restart_pending: false,
      settings: [
        {
          key: "voice.livekit_api_key",
          type: "secret",
          value: null,
          override: null,
          configured: true,
          override_set: true,
          env_locked: false,
          requires_confirmation: false,
        },
      ],
    };
    const booted = await boot(calls, settings);
    dom = booted.dom;
    const doc = await render(dom, booted.bridge);

    expect(doc.querySelector('[data-action="clearConfigSecretValue"]')).toBeNull();
    expect(doc.querySelector('[data-action="clearConfigSecret"]')).not.toBeNull();
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
    // A successful save dismisses the confirmation dialog.
    expect(modal.classList.contains("visible")).toBe(false);
  });

  it("keeps Save usable after the confirmation is cancelled", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const doc = await render(dom, booted.bridge);

    control(doc, "server.port").value = "9443";
    fn(booted.bridge.markConfigChanged, "markConfigChanged")();
    await fn(booted.bridge.saveServerConfig, "saveServerConfig")();
    expect(doc.getElementById("modal")!.classList.contains("visible")).toBe(true);
    expect(patches(calls)).toHaveLength(0);

    doc.querySelector<HTMLButtonElement>('#modal [data-action="closeModal"]')!.click();
    expect(doc.getElementById("modal")!.classList.contains("visible")).toBe(false);
    expect((doc.getElementById("saveConfigBtn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not send a null reset when a numeric field without an override is cleared", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const doc = await render(dom, booted.bridge);

    control(doc, "server.port").value = "";
    fn(booted.bridge.markConfigChanged, "markConfigChanged")();
    await fn(booted.bridge.saveServerConfig, "saveServerConfig")();
    expect(patches(calls)).toHaveLength(0);
    expect(doc.getElementById("modal")!.classList.contains("visible")).toBe(false);
  });

  it("lets a confirmed save be retried after the server refuses it", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const doc = await render(dom, booted.bridge);

    control(doc, "server.port").value = "9443";
    fn(booted.bridge.markConfigChanged, "markConfigChanged")();
    await fn(booted.bridge.saveServerConfig, "saveServerConfig")();
    const typed = doc.getElementById("typedConfirm") as HTMLInputElement;
    typed.value = "CONFIRM";

    const win = dom.window as unknown as { fetch: typeof fetch };
    let refuse = true;
    win.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
      const method = String((opts.method as string) || "GET").toUpperCase();
      const path = String(input).replace(/^\/admin\/api/, "");
      calls.push({
        method,
        path,
        body: typeof opts.body === "string" ? JSON.parse(opts.body) : undefined,
        headers: { ...(opts.headers as Record<string, string>) },
      });
      const json = path === "/config/settings" ? SETTINGS : {};
      if (refuse) {
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          json: async () => ({ message: "server.port is not available on this host" }),
          text: async () => "",
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => json,
        text: async () => JSON.stringify(json),
      } as Response;
    }) as typeof fetch;

    await fn(booted.bridge.confirmServerConfig, "confirmServerConfig")();
    expect(patches(calls)).toHaveLength(1);
    expect(doc.getElementById("modal")!.classList.contains("visible")).toBe(true);

    refuse = false;
    await fn(booted.bridge.confirmServerConfig, "confirmServerConfig")();
    expect(patches(calls)).toHaveLength(2);
    expect(patches(calls)[1]!.headers["X-OwnCord-Confirm"]).toBe("server.port");
    expect(doc.getElementById("modal")!.classList.contains("visible")).toBe(false);
  });

  it("routes Reset of a lock-out-capable key through the typed confirmation", async () => {
    const calls: FetchCall[] = [];
    const settings = {
      restart_pending: false,
      settings: [
        {
          key: "server.port",
          type: "int",
          value: 8443,
          override: 9443,
          fallback: 8443,
          env_locked: false,
          requires_confirmation: true,
        },
      ],
    };
    const booted = await boot(calls, settings);
    dom = booted.dom;
    await render(dom, booted.bridge);

    await fn(booted.bridge.resetConfigKey, "resetConfigKey")("server.port");
    // Nothing is sent until CONFIRM is typed.
    expect(patches(calls)).toHaveLength(0);
    const modal = dom.window.document.getElementById("modal")!;
    expect(modal.classList.contains("visible")).toBe(true);
    const typed = dom.window.document.getElementById("typedConfirm") as HTMLInputElement;
    typed.value = "CONFIRM";
    await fn(booted.bridge.confirmServerConfig, "confirmServerConfig")();

    expect(patches(calls)).toHaveLength(1);
    expect(patches(calls)[0]!.body).toEqual({ "server.port": null });
    expect(patches(calls)[0]!.headers["X-OwnCord-Confirm"]).toBe("server.port");
  });

  it("uses the config.yaml fallback address after a reset moves the port", async () => {
    const calls: FetchCall[] = [];
    const initial = {
      restart_pending: false,
      settings: [
        {
          key: "server.port",
          type: "int",
          value: 9443,
          override: 9443,
          fallback: 8443,
          env_locked: false,
          requires_confirmation: true,
        },
      ],
    };
    const afterReset = {
      restart_pending: true,
      settings: [
        {
          key: "server.port",
          type: "int",
          value: 9443,
          override: null,
          fallback: 8443,
          env_locked: false,
          requires_confirmation: true,
        },
      ],
    };
    const booted = await boot(calls, initial, afterReset);
    dom = booted.dom;
    await render(dom, booted.bridge);

    await fn(booted.bridge.resetConfigKey, "resetConfigKey")("server.port");
    const typed = dom.window.document.getElementById("typedConfirm") as HTMLInputElement;
    typed.value = "CONFIRM";
    await fn(booted.bridge.confirmServerConfig, "confirmServerConfig")();

    expect(fn(booted.bridge.configMovedAddress, "configMovedAddress")()).toBe(
      "https://localhost:8443/admin",
    );
  });
});
