// Desktop binding for the SocketTransport suite: `platform/desktop`'s socket
// transport. B7-4 ran the same suite file against the in-place seam in
// `lib/ws.ts` first (proving it could fail and pinning today's behaviour),
// then re-bound it here. The legacy binding is deleted with this commit: its
// export is now internal.
//
// The transport loads its native APIs lazily, so "there is no native host"
// is expressed the way the transport sees it: the module's `invoke` accessor
// throws, `ensureApis()` swallows it, and the command that follows fails.
import { vi } from "vitest";
import type { SocketConnection, SocketTransport } from "../../../src/platform/contracts/socket";
import { describeSocketTransportSuite } from "./socket.suite";

const { invokeMock, listenMock, handlers } = vi.hoisted(() => {
  const registry = new Map<string, Set<(e: { payload: unknown }) => void>>();
  return {
    handlers: registry,
    invokeMock: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
    listenMock: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
      if (!registry.has(event)) registry.set(event, new Set());
      registry.get(event)!.add(handler);
      return () => {
        registry.get(event)?.delete(handler);
      };
    }),
  };
});

// A getter, so toggling it is enough to move between "native host present"
// and "no native host at all" with no module reset.
let hostAvailable = true;

vi.mock("@tauri-apps/api/core", () => ({
  get invoke() {
    if (!hostAvailable) throw new Error("no native host");
    return invokeMock;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  get listen() {
    if (!hostAvailable) throw new Error("no native host");
    return listenMock;
  },
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mod = await import("../../../src/platform/desktop/socket");

const sentFrames: string[] = [];
const acceptedPins: { host: string; fingerprint: string }[] = [];
let connectFailure: unknown = null;
let sendFailure: unknown = null;
let lastConnect: Promise<void> = Promise.resolve();

function emit(event: string, payload: unknown): void {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}

describeSocketTransportSuite(async () => {
  hostAvailable = true;
  connectFailure = null;
  sendFailure = null;
  sentFrames.length = 0;
  acceptedPins.length = 0;
  handlers.clear();
  invokeMock.mockReset();
  listenMock.mockClear();
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "ws_connect" && connectFailure !== null) return Promise.reject(connectFailure);
    if (cmd === "ws_send") {
      if (sendFailure !== null) return Promise.reject(sendFailure);
      sentFrames.push(String(args?.message));
    }
    if (cmd === "accept_cert_fingerprint") {
      acceptedPins.push({ host: String(args?.host), fingerprint: String(args?.fingerprint) });
    }
    return Promise.resolve(undefined);
  });

  const transport: SocketTransport = mod.socket;
  const connection: SocketConnection = transport.create();
  // The suite drives one connection; the control below needs the promise the
  // connect attempt settles as, which the contract now declares.
  const subject: SocketConnection = {
    ...connection,
    connect: (options) => {
      lastConnect = connection.connect(options);
      lastConnect.catch(() => undefined);
      return lastConnect;
    },
  };

  return {
    transport,
    subject,
    native: {
      async opens(): Promise<void> {
        await lastConnect;
        emit("ws-state", "open");
      },
      async closes(): Promise<void> {
        await lastConnect;
        emit("ws-state", "closed");
      },
      async delivers(text: string): Promise<void> {
        await lastConnect;
        emit("ws-message", text);
      },
      async emitsCert(status): Promise<void> {
        // The cert-tofu listener is the app-lifetime singleton the app
        // registers at bootstrap; make sure it is up before emitting.
        await connection.startCertListener();
        emit("cert-tofu", {
          host: "chat.example",
          fingerprint: "sha256:abc",
          status,
          message: "Stored: sha256:def",
        });
      },
      connectFailsWith(error: unknown): void {
        connectFailure = error;
      },
      sendFailsWith(error: unknown): void {
        sendFailure = error;
      },
      unavailable(): void {
        hostAvailable = false;
      },
      sent: () => [...sentFrames],
      accepted: () => acceptedPins.map((pin) => ({ ...pin })),
    },
  };
});
