import type { Page } from "@playwright/test";
import type { TestServer } from "./server";

/** Test-only replacement for native IPC. HTTP/WS bytes go to the real server;
 * no responses, auth, messages, membership or E2EE offers are fabricated.
 * Windows native tests separately cover the Rust IPC/TLS boundary. */
export async function installRealTransport(page: Page, server: TestServer) {
  const errors: string[] = [];
  const requests = new Map<
    number,
    { url: string; method: string; headers: [string, string][]; data: number[] | null }
  >();
  const bodies = new Map<number, number[]>();
  const settings: Record<string, unknown> = {};
  const secrets = new Map<string, unknown>();
  let resource = 0;
  let socket: WebSocket | undefined;
  let online = true;
  let closed = false;
  const pendingEvents = new Set<Promise<void>>();
  const emit = (event: string, payload: unknown) => {
    if (closed) return;
    const pending = page
      .evaluate(
        ({ event, payload }) => {
          (window as unknown as { __ocEmit: (event: string, payload: unknown) => void }).__ocEmit(
            event,
            payload,
          );
        },
        { event, payload },
      )
      .catch((error: Error) => {
        if (!closed) errors.push(error.message);
      });
    pendingEvents.add(pending);
    void pending.finally(() => pendingEvents.delete(pending));
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeBinding(
    "__ocInvoke",
    async (_source, command: string, args: Record<string, any> = {}) => {
      switch (command) {
        case "start_http_proxy":
        case "start_livekit_proxy":
          return server.port;
        case "plugin:http|fetch": {
          const request = args.clientConfig;
          const url = new URL(request.url);
          if (url.origin !== server.origin)
            throw new Error(`Unexpected real-stack destination: ${url.origin}`);
          const id = ++resource;
          requests.set(id, request);
          return id;
        }
        case "plugin:http|fetch_send": {
          const request = requests.get(args.rid);
          if (!request) throw new Error(`Unknown HTTP resource ${args.rid}`);
          requests.delete(args.rid);
          if (!online) throw new Error("Test transport offline");
          const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.data === null ? undefined : new Uint8Array(request.data),
            signal: AbortSignal.timeout(15_000),
          });
          const id = ++resource;
          bodies.set(id, Array.from(new Uint8Array(await response.arrayBuffer())));
          return {
            status: response.status,
            statusText: response.statusText,
            url: request.url,
            headers: Array.from(response.headers),
            rid: id,
          };
        }
        case "plugin:http|fetch_read_body": {
          const body = bodies.get(args.rid);
          bodies.delete(args.rid);
          return body ? [...body, 0] : [1];
        }
        case "plugin:http|fetch_cancel":
          requests.delete(args.rid);
          return;
        case "plugin:http|fetch_cancel_body":
          bodies.delete(args.rid);
          return;
        case "ws_connect": {
          if (!online) throw new Error("Test transport offline");
          socket?.close();
          const url = new URL(args.url);
          if (url.host !== new URL(server.origin).host)
            throw new Error(`Unexpected WS host: ${url.host}`);
          url.protocol = "ws:";
          const own = new WebSocket(url);
          socket = own;
          own.addEventListener("open", () => {
            if (socket === own) emit("ws-state", "open");
          });
          own.addEventListener("message", (event) => {
            if (socket === own) emit("ws-message", String(event.data));
          });
          own.addEventListener("close", () => {
            if (socket === own) emit("ws-state", "closed");
          });
          own.addEventListener("error", () => {
            /* close is the reconnect signal */
          });
          return;
        }
        case "ws_send":
          if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("WS is not open");
          socket.send(args.message);
          return;
        case "ws_disconnect":
          socket?.close();
          socket = undefined;
          return;
        case "get_settings":
          return settings;
        case "save_settings":
          settings[args.key] = args.value;
          return;
        case "save_identity_key":
          secrets.set(`identity:${args.host}`, args.key);
          return;
        case "load_identity_key":
          return secrets.get(`identity:${args.host}`) ?? null;
        case "delete_identity_key":
          secrets.delete(`identity:${args.host}`);
          return;
        case "store_identity_pin":
          secrets.set(`pin:${args.host}:${args.userId}`, args.pin);
          return;
        case "get_identity_pin":
          return secrets.get(`pin:${args.host}:${args.userId}`) ?? null;
        case "save_credential":
          secrets.set(`credential:${args.host}`, args);
          return;
        case "load_credential":
          return secrets.get(`credential:${args.host}`) ?? null;
        case "delete_credential":
          secrets.delete(`credential:${args.host}`);
          return;
        case "check_client_update":
          return { available: false, version: null, body: null };
        case "plugin:path|resolve_directory":
          return "/test-logs";
        case "plugin:path|join":
          return args.paths.join("/");
        case "plugin:fs|read_dir":
        case "plugin:window|available_monitors":
          return [];
        case "plugin:fs|exists":
        case "ptt_polling_supported":
        case "plugin:autostart|is_enabled":
          return false;
        case "plugin:app|version":
          return "e2e";
        case "plugin:deep-link|get_current":
        case "plugin:deep-link|register":
        case "plugin:fs|mkdir":
        case "plugin:fs|write_text_file":
        case "plugin:fs|remove":
        case "stop_http_proxy":
        case "stop_livekit_proxy":
        case "ptt_set_key":
        case "ptt_stop":
        case "plugin:window|set_title":
        case "plugin:window|is_maximized":
        case "plugin:window|set_focus":
        case "plugin:window|show":
        case "plugin:window|inner_size":
        case "plugin:window|outer_position":
        case "plugin:notification|is_permission_granted":
          return null;
        default: {
          const message = `Unexpected real-stack IPC: ${command}`;
          errors.push(message);
          throw new Error(message);
        }
      }
    },
  );
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, any>;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Set<number>>();
    let id = 0;
    w.__ocEmit = (event: string, payload: unknown) => {
      for (const callback of listeners.get(event) ?? [])
        callbacks.get(callback)?.({ event, payload, id: callback });
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event: string, id: number) {
        listeners.get(event)?.delete(id);
        callbacks.delete(id);
      },
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback(callback: (event: unknown) => void) {
        callbacks.set(++id, callback);
        return id;
      },
      unregisterCallback(callback: number) {
        callbacks.delete(callback);
      },
      convertFileSrc(path: string) {
        return path;
      },
      async invoke(command: string, args: Record<string, any> = {}) {
        if (command === "plugin:event|listen") {
          const set = listeners.get(args.event) ?? new Set<number>();
          set.add(args.handler);
          listeners.set(args.event, set);
          return args.handler;
        }
        if (command === "plugin:event|unlisten") {
          listeners.get(args.event)?.delete(args.eventId);
          callbacks.delete(args.eventId);
          return;
        }
        return w.__ocInvoke(command, args);
      },
    };
  });
  return {
    errors,
    async offline() {
      online = false;
      socket?.close();
    },
    online() {
      online = true;
    },
    async close() {
      closed = true;
      socket?.close();
      socket = undefined;
      await Promise.all(pendingEvents);
    },
  };
}
