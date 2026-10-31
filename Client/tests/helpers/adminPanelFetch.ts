// Shared setup for the contract tests that drive the admin panel
// (Server/admin/static) in jsdom with a scripted `fetch`. Each test file keeps
// its own bridge script and its own responder; the page loading, the request
// log and the bootstrap wait live here.
import { expect } from "vitest";
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

export type PanelResponder = (path: string, method: string) => PanelReply;

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
export function loadAdminPanel(html: string, calls: FetchCall[], respond: PanelResponder): JSDOM {
  return new JSDOM(html, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = scriptedPanelFetch(
        ({ method, path, body }) => calls.push({ method, path, body }),
        (path, method) =>
          path === "/setup/status" ? { json: { needs_setup: false } } : respond(path, method),
      );
    },
  });
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
    let body: unknown;
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
    const reply = answer(path, method);
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
): Promise<{ dom: JSDOM; bridge: Bridge; doc: Document }> {
  const dom = loadAdminPanel(html, calls, respond);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  calls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  return { dom, bridge, doc: dom.window.document };
}
