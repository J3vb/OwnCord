// Browser binding for the SocketTransport suite (6.13c): the browser
// platform's transport over the page's own `WebSocket`. "The native host" is
// an in-test WebSocket class the binding drives; "no native host" is a page
// with no WebSocket at all. The browser keeps certificate trust itself, so the
// suite runs with `certificates: false`; the full suite runs against the
// desktop transport in `socket.desktop.test.ts`.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SocketConnection,
  SocketConnectionState,
  SocketTransport,
} from "../../../src/platform/contracts/socket";
import { sessionToken } from "../../../src/platform/browser/session";
import { socket } from "../../../src/platform/browser/socket";
import { describeSocketTransportSuite } from "./socket.suite";

type Listener = (event: Event) => void;

let handshakeFailure: unknown = null;
let sendFailure: unknown = null;

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    if (handshakeFailure !== null) {
      setTimeout(() => {
        this.dispatch("error", new Event("error"));
        this.fireClose();
      }, 0);
    }
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(text: string): void {
    if (sendFailure !== null) throw sendFailure;
    this.sent.push(text);
  }

  close(): void {
    this.closeCalls++;
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => this.fireClose(), 0);
  }

  fireOpen(): void {
    this.readyState = 1;
    this.dispatch("open", new Event("open"));
  }

  fireMessage(data: unknown): void {
    this.dispatch("message", new MessageEvent("message", { data }));
  }

  fireClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close", new CloseEvent("close", { code: 1006 }));
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function latest(): FakeWebSocket {
  const instance = FakeWebSocket.instances.at(-1);
  if (instance === undefined) throw new Error("no socket was opened"); // i18n-exempt: test diagnostic
  return instance;
}

function install(): void {
  handshakeFailure = null;
  sendFailure = null;
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describeSocketTransportSuite(
  async () => {
    install();
    const transport: SocketTransport = socket;
    const connection: SocketConnection = transport.create();
    let lastConnect: Promise<void> = Promise.resolve();
    // The suite drives one connection; the control below needs the promise
    // the connect attempt settles as.
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
          latest().fireOpen();
          await lastConnect;
        },
        async closes(): Promise<void> {
          await lastConnect;
          latest().fireClose();
        },
        async delivers(text: string): Promise<void> {
          await lastConnect;
          latest().fireMessage(text);
        },
        async emitsCert(): Promise<void> {
          throw new Error("the browser reports no certificate events"); // i18n-exempt: test diagnostic
        },
        connectFailsWith(error: unknown): void {
          handshakeFailure = error;
        },
        sendFailsWith(error: unknown): void {
          sendFailure = error;
        },
        unavailable(): void {
          vi.stubGlobal("WebSocket", undefined);
        },
        sent: () => [...latest().sent],
        accepted: () => [],
      },
    };
  },
  { certificates: false },
);

describe("browser socket", () => {
  const options = { url: "wss://chat.example/api/v1/ws", token: "tok" };
  let connection: SocketConnection;
  let states: SocketConnectionState[];
  let frames: string[];

  beforeEach(() => {
    install();
    connection = socket.create();
    states = [];
    frames = [];
    connection.onStateChange((state) => states.push(state));
    connection.onMessage((text) => frames.push(text));
  });

  it("dials the URL it was given", () => {
    void connection.connect(options);
    expect(latest().url).toBe(options.url);
  });

  it("stale generation close ignored", async () => {
    const first = connection.connect(options);
    const stale = latest();
    const second = connection.connect(options);
    const live = latest();
    expect(live).not.toBe(stale);
    // The superseded attempt settles, and its socket is closed.
    await first;
    expect(stale.closeCalls).toBeGreaterThan(0);

    live.fireOpen();
    await second;
    const reported = states.length;
    expect(states.at(-1)).toBe("connected");

    stale.fireClose();
    stale.fireMessage('{"type":"stale"}');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toHaveLength(reported);
    expect(frames).toEqual([]);

    live.fireMessage('{"type":"live"}');
    await connection.send('{"type":"ping"}');
    expect(frames).toEqual(['{"type":"live"}']);
    expect(live.sent).toEqual(['{"type":"ping"}']);
    expect(stale.sent).toEqual([]);
  });

  it("holds the dialled token as the tab's session until it disconnects", async () => {
    void connection.connect(options);
    expect(sessionToken()).toBe("tok");
    latest().fireClose();
    // A lost connection reconnects with the same session.
    expect(sessionToken()).toBe("tok");

    const other = socket.create();
    void other.connect({ ...options, token: "tok-2" });
    await connection.disconnect();
    // The connection that took over keeps its own session.
    expect(sessionToken()).toBe("tok-2");
    await other.disconnect();
    expect(sessionToken()).toBeNull();
  });

  it("settles a connect that a disconnect cancels", async () => {
    const attempt = connection.connect(options);
    await connection.disconnect();
    await expect(attempt).resolves.toBeUndefined();
    latest().fireOpen();
    expect(states).not.toContain("connected");
  });

  it("rejects a send before the connection opens", async () => {
    void connection.connect(options);
    await expect(connection.send("x")).rejects.toThrow();
    expect(latest().sent).toEqual([]);
  });

  it("rejects a send after the connection closed", async () => {
    const attempt = connection.connect(options);
    latest().fireOpen();
    await attempt;
    latest().fireClose();
    await expect(connection.send("x")).rejects.toThrow();
  });

  it("reports a lost connection once", async () => {
    const attempt = connection.connect(options);
    latest().fireOpen();
    await attempt;
    latest().fireClose();
    latest().fireClose();
    expect(states.filter((state) => state === "disconnected")).toHaveLength(1);
  });

  it("delivers only text frames", async () => {
    const attempt = connection.connect(options);
    latest().fireOpen();
    await attempt;
    latest().fireMessage(new ArrayBuffer(4));
    latest().fireMessage("text");
    expect(frames).toEqual(["text"]);
  });

  it("reports a URL the page cannot dial as a failed handshake", async () => {
    class Refusing {
      constructor() {
        throw new SyntaxError("bad url");
      }
    }
    vi.stubGlobal("WebSocket", Refusing);
    await expect(connection.connect(options)).resolves.toBeUndefined();
    expect(states.at(-1)).toBe("disconnected");
  });

  describe("handshake timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports a socket that never opens as disconnected, once, and settles", async () => {
      vi.useFakeTimers();
      let settled = false;
      const attempt = connection.connect(options).then(() => {
        settled = true;
      });
      const socket = latest();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      expect(states).not.toContain("disconnected");
      await vi.advanceTimersByTimeAsync(1);
      await attempt;
      expect(settled).toBe(true);
      expect(socket.closeCalls).toBeGreaterThan(0);
      // The close that follows the give-up is not a second report.
      await vi.runAllTimersAsync();
      socket.fireClose();
      expect(states.filter((state) => state === "disconnected")).toHaveLength(1);
      expect(states.at(-1)).toBe("disconnected");
      await expect(connection.send("x")).rejects.toThrow();
    });

    it("leaves an opened connection alone", async () => {
      vi.useFakeTimers();
      const attempt = connection.connect(options);
      latest().fireOpen();
      await attempt;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(states).not.toContain("disconnected");
      await expect(connection.send("x")).resolves.toBeUndefined();
    });

    it("a superseded attempt's timer does nothing to the live attempt", async () => {
      vi.useFakeTimers();
      void connection.connect(options);
      await vi.advanceTimersByTimeAsync(6_000);
      const second = connection.connect(options);
      const live = latest();
      // Past the first attempt's deadline, short of the second's.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(states).not.toContain("disconnected");
      expect(live.closeCalls).toBe(0);
      live.fireOpen();
      await second;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(states.at(-1)).toBe("connected");
      expect(states).not.toContain("disconnected");
    });
  });

  it("never reports a certificate event and needs no certificate listener", async () => {
    const certs: unknown[] = [];
    connection.onCertFirstUse((event) => certs.push(event));
    connection.onCertMismatch((event) => certs.push(event));
    await expect(connection.startCertListener()).resolves.toBeUndefined();
    const attempt = connection.connect(options);
    latest().fireOpen();
    await attempt;
    expect(certs).toEqual([]);
  });
});

describe("browser socket scheme", () => {
  function pageAt(protocol: string, host: string): void {
    vi.stubGlobal("location", { protocol, host });
  }

  async function dial(url: string): Promise<string> {
    install();
    const connection = socket.create();
    void connection.connect({ url, token: "t" }).catch(() => undefined);
    const dialled = latest().url;
    await connection.disconnect();
    return dialled;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  it("http page dials ws:", async () => {
    pageAt("http:", "chat.example:8080");
    expect(await dial("wss://chat.example:8080/api/v1/ws")).toBe(
      "ws://chat.example:8080/api/v1/ws",
    );
  });

  it("http page leaves another host's wss: alone", async () => {
    pageAt("http:", "chat.example:8080");
    expect(await dial("wss://other.example:8080/api/v1/ws")).toBe(
      "wss://other.example:8080/api/v1/ws",
    );
  });

  it("http page on the default port dials ws:", async () => {
    pageAt("http:", "localhost");
    expect(await dial("wss://localhost/api/v1/ws")).toBe("ws://localhost/api/v1/ws");
  });

  it("http page on a bracketed IPv6 loopback dials ws:", async () => {
    pageAt("http:", "[::1]:8443");
    expect(await dial("wss://[::1]:8443/api/v1/ws")).toBe("ws://[::1]:8443/api/v1/ws");
  });

  it("https page keeps wss:", async () => {
    pageAt("https:", "chat.example");
    expect(await dial("wss://chat.example/api/v1/ws")).toBe("wss://chat.example/api/v1/ws");
  });
});
