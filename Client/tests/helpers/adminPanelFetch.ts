// Shared setup for the contract tests that drive the admin panel
// (Server/admin/static) in jsdom with a scripted `fetch`. Each test file keeps
// its own bridge script and its own responder; the page loading, the request
// log and the bootstrap wait live here.
import { afterEach, expect } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "./admin-panel";

export interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

export interface PanelReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type PanelResponder = (path: string, method: string) => PanelReply | Promise<PanelReply>;

/**
 * index.html with its scripts inlined and `bridgeScript` appended before
 * `</body>`. Classic-script bindings never land on `window`, so the bridge
 * copies the ones a test drives onto `window.__test`.
 */
export function adminHtmlWithBridge(bridgeScript: string): string {
  const source = adminPanelHtml();
  if (!source.includes("</body>")) {
    throw new Error("expected Server/admin/static/index.html to contain </body>");
  }
  return source.replace("</body>", `${bridgeScript}\n</body>`);
}

/**
 * The panel in a scripted jsdom window whose `fetch` logs every call to
 * `calls` and answers through `respond`. `/setup/status` answers "set up"
 * before `respond` is asked.
 */
export function loadAdminPanel(
  html: string,
  calls: FetchCall[],
  respond: PanelResponder,
  prepare?: (window: JSDOM["window"]) => void,
): JSDOM {
  return loadPanelWithFetch(
    html,
    scriptedPanelFetch(
      ({ method, path, body }) => calls.push({ method, path, body }),
      (path, method) =>
        path === "/setup/status" ? { json: { needs_setup: false } } : respond(path, method),
    ),
    prepare,
  );
}

const loadedPanels: JSDOM[] = [];

// Every panel this helper loads is closed when the test that opened it ends.
afterEach(() => {
  for (const dom of loadedPanels.splice(0)) dom.window.close();
});

/** The panel in a scripted jsdom window whose `fetch` is `fetchImpl`. */
export function loadPanelWithFetch(
  html: string,
  fetchImpl: typeof fetch,
  prepare?: (window: JSDOM["window"]) => void,
): JSDOM {
  const dom = new JSDOM(html, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      prepare?.(window);
      window.fetch = fetchImpl;
    },
  });
  loadedPanels.push(dom);
  return dom;
}

/** Lets the panel's own bootstrap settle, then returns its test bridge. */
export async function settlePanel<Bridge>(dom: JSDOM): Promise<Bridge> {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  return bridge;
}

export interface PanelRequest {
  method: string;
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A `fetch` that hands each request to `record` and answers it from `answer`. */
export function scriptedPanelFetch(
  record: (call: PanelRequest) => void,
  answer: PanelResponder,
): typeof fetch {
  return (async (input: string, opts: Record<string, unknown> = {}) => {
    const method = String((opts.method as string) || "GET").toUpperCase();
    const path = String(input).replace(/^\/admin\/api/, "");
    let body: unknown = opts.body;
    if (typeof opts.body === "string") {
      try {
        body = JSON.parse(opts.body);
      } catch {
        body = opts.body;
      }
    }
    record({
      method,
      url: String(input),
      path,
      body,
      headers: (opts.headers as Record<string, string>) ?? {},
    });
    const reply = await answer(path, method);
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(reply.headers),
      json: async () => reply.json ?? {},
      text: async () => reply.text ?? JSON.stringify(reply.json ?? {}),
    } as Response;
  }) as typeof fetch;
}

/**
 * Loads the panel, lets its own bootstrap (checkAuth, GET /setup/status)
 * settle, drops that traffic from `calls`, and returns the test bridge.
 */
export async function bootAdminPanel<Bridge>(
  html: string,
  calls: FetchCall[],
  respond: PanelResponder,
  prepare?: (window: JSDOM["window"]) => void,
): Promise<{ dom: JSDOM; bridge: Bridge; doc: Document }> {
  const dom = loadAdminPanel(html, calls, respond, prepare);
  const bridge = await settlePanel<Bridge>(dom);
  calls.length = 0;
  return { dom, bridge, doc: dom.window.document };
}

/**
 * A responder for tests that script bare JSON: `/setup/status` answers "set
 * up", an `{ __status, body }` value answers a refusal, and anything else is
 * the 200 body. `respond` may return a promise to hold a request open.
 */
export function jsonResponder(respond: (path: string, method: string) => unknown): PanelResponder {
  return async (path, method) => {
    if (path === "/setup/status") return { json: { needs_setup: false } };
    const out = (await respond(path, method)) ?? {};
    if (typeof out === "object" && "__status" in out) {
      const refusal = out as { __status: number; body?: unknown };
      return { status: Number(refusal.__status), json: refusal.body };
    }
    return { json: out };
  };
}

export interface SentBody {
  call: string;
  body: unknown;
}

/** Records each request as "METHOD path", and its body when it has one. */
export function recordLabelled(calls: string[], sent: SentBody[]): (request: PanelRequest) => void {
  return ({ method, path, body }) => {
    calls.push(`${method} ${path}`);
    if (typeof body !== "undefined") sent.push({ call: `${method} ${path}`, body });
  };
}

/** Replaces window.confirm and records the messages it was asked. */
export function stubConfirm(dom: JSDOM, answer: boolean): string[] {
  const asked: string[] = [];
  dom.window.confirm = (message?: string) => {
    asked.push(String(message ?? ""));
    return answer;
  };
  return asked;
}

/** Renders the Settings page into `#content`. */
export async function mountSettings(
  bridge: { renderSettings: () => Promise<string> },
  doc: Document,
): Promise<void> {
  const content = doc.getElementById("content");
  if (!content) throw new Error("expected #content");
  content.innerHTML = await bridge.renderSettings();
}
