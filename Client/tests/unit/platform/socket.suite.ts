// Behaviour suite for the `SocketTransport` contract
// (`src/platform/contracts/socket.ts`). Run now against the legacy binding
// (`socket.legacy.test.ts`, the transport `lib/ws.ts` builds in place) and
// again in B7-4 against `platform/desktop` — a green run before and after
// that move is the evidence the move changed nothing.
//
// Asserts only what the CALLER receives: the four listener groups, the
// promise a command settles as, and the frames that reach the transport.
// Never a command name and never an argument shape — the modules' existing
// unit tests own that wiring.
//
// Every native event arrives after the transport has registered its
// listener, so the control's `opens`/`closes`/`delivers`/`emitsCert` are
// async: awaiting them is what makes the arrival ordered after the
// registration the binding performs on `connect()`.
import { beforeEach, describe, expect, test } from "vitest";
import type {
  SocketCertEvent,
  SocketConnection,
  SocketConnectionState,
  SocketTransport,
} from "../../../src/platform/contracts/socket";

/** A small control handle the legacy/desktop binding supplies so the suite
 *  never has to know how "the connection opens, fails, or the native host is
 *  missing" is actually wired for that binding. */
export interface NativeControl {
  /** The proxy reports the connection open. */
  opens(): Promise<void>;
  /** The proxy reports the connection closed. */
  closes(): Promise<void>;
  /** One inbound frame, as the native transport delivered it. */
  delivers(text: string): Promise<void>;
  /** One certificate event, as the native transport delivered it. */
  emitsCert(status: SocketCertEvent["status"]): Promise<void>;
  /** The handshake fails with this error. */
  connectFailsWith(error: unknown): void;
  /** A command fails with this error. */
  sendFailsWith(error: unknown): void;
  /** There is no native host at all. */
  unavailable(): void;
  /** The frames the transport has actually been asked to put on the wire. */
  sent(): readonly string[];
  /** The host/fingerprint pairs the native side has been asked to accept. */
  accepted(): readonly { host: string; fingerprint: string }[];
}

export interface SocketSubject {
  /** The capability the app takes a transport from. */
  readonly transport: SocketTransport;
  /** The transport it handed back, which the tests below drive. */
  readonly subject: SocketConnection;
  readonly native: NativeControl;
}

const connectOptions = { url: "wss://chat.example:8443/api/v1/ws", token: "tok" };

export function describeSocketTransportSuite(
  makeSubject: () => Promise<SocketSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("SocketTransport", () => {
    let ctx: SocketSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("create", () => {
      // The app takes a fresh transport per client — a new login must not
      // inherit the previous connection's listeners, and neither must a test.
      check("hands back an independent transport per call", () => {
        expect(ctx.transport.create()).not.toBe(ctx.subject);
      });
    });

    describe("state", () => {
      check("reports the proxy's connection opening to a subscriber", async () => {
        const states: SocketConnectionState[] = [];
        ctx.subject.onStateChange((state) => states.push(state));
        ctx.subject.connect(connectOptions);
        await ctx.native.opens();
        expect(states).toContain("connected");
      });

      check("reports the proxy's connection closing to a subscriber", async () => {
        const states: SocketConnectionState[] = [];
        ctx.subject.onStateChange((state) => states.push(state));
        ctx.subject.connect(connectOptions);
        await ctx.native.opens();
        await ctx.native.closes();
        expect(states.at(-1)).toBe("disconnected");
      });

      check("stops reporting once a subscriber unsubscribes", async () => {
        const states: SocketConnectionState[] = [];
        const unsubscribe = ctx.subject.onStateChange((state) => states.push(state));
        ctx.subject.connect(connectOptions);
        await ctx.native.opens();
        // The live subscription is what makes the silence below mean
        // something: a subject that never reports at all is silent too.
        expect(states).toContain("connected");
        const reported = states.length;
        unsubscribe();
        await ctx.native.closes();
        expect(states).toHaveLength(reported);
      });

      check("reports a failed handshake to the state subscribers", async () => {
        const states: SocketConnectionState[] = [];
        ctx.subject.onStateChange((state) => states.push(state));
        ctx.native.connectFailsWith(new Error("connection refused"));
        await ctx.subject.connect(connectOptions);
        expect(states.at(-1)).toBe("disconnected");
      });

      check("rejects the connect attempt when there is no native host", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.connect(connectOptions)).rejects.toThrow();
      });
    });

    describe("messages", () => {
      check("hands an inbound frame to a subscriber, verbatim", async () => {
        const frames: string[] = [];
        ctx.subject.onMessage((text) => frames.push(text));
        ctx.subject.connect(connectOptions);
        await ctx.native.opens();
        await ctx.native.delivers('{"type":"pong","payload":{}}');
        expect(frames).toEqual(['{"type":"pong","payload":{}}']);
      });

      check("stops delivering frames once a subscriber unsubscribes", async () => {
        const frames: string[] = [];
        const unsubscribe = ctx.subject.onMessage((text) => frames.push(text));
        ctx.subject.connect(connectOptions);
        await ctx.native.opens();
        await ctx.native.delivers('{"type":"pong","payload":{}}');
        expect(frames).toHaveLength(1);
        unsubscribe();
        await ctx.native.delivers('{"type":"pong","payload":{}}');
        expect(frames).toHaveLength(1);
      });
    });

    describe("send", () => {
      check("puts the caller's frame on the wire", async () => {
        ctx.subject.connect(connectOptions);
        await ctx.native.opens();
        await ctx.subject.send('{"type":"ping","payload":{}}');
        expect(ctx.native.sent()).toEqual(['{"type":"ping","payload":{}}']);
      });

      check("rejects when the native send fails", async () => {
        ctx.subject.connect(connectOptions);
        await ctx.native.opens();
        ctx.native.sendFailsWith(new Error("channel full"));
        await expect(ctx.subject.send('{"type":"ping","payload":{}}')).rejects.toThrow();
      });
    });

    describe("certificates", () => {
      check("routes a first-use certificate to the first-use subscribers", async () => {
        const events: SocketCertEvent[] = [];
        ctx.subject.onCertFirstUse((event) => events.push(event));
        await ctx.native.emitsCert("first_use");
        expect(events).toHaveLength(1);
        expect(events[0]!.status).toBe("first_use");
      });

      check(
        "routes a mismatch to the mismatch subscribers, and not the first-use ones",
        async () => {
          const firstUse: SocketCertEvent[] = [];
          const mismatch: SocketCertEvent[] = [];
          ctx.subject.onCertFirstUse((event) => firstUse.push(event));
          ctx.subject.onCertMismatch((event) => mismatch.push(event));
          await ctx.native.emitsCert("mismatch");
          expect(mismatch).toHaveLength(1);
          expect(firstUse).toEqual([]);
        },
      );

      check("resolves acceptCertificate once the native side has stored it", async () => {
        await expect(
          ctx.subject.acceptCertificate("chat.example", "sha256:abc"),
        ).resolves.toBeUndefined();
        expect(ctx.native.accepted()).toEqual([
          { host: "chat.example", fingerprint: "sha256:abc" },
        ]);
      });

      check("rejects acceptCertificate when there is no native host", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.acceptCertificate("chat.example", "sha256:abc")).rejects.toThrow();
      });
    });

    describe("disconnect", () => {
      check("stops delivering frames after an intentional close", async () => {
        const frames: string[] = [];
        ctx.subject.onMessage((text) => frames.push(text));
        ctx.subject.connect(connectOptions);
        await ctx.native.opens();
        await ctx.native.delivers('{"type":"chat_message","payload":{}}');
        expect(frames).toHaveLength(1);
        ctx.subject.disconnect();
        await ctx.native.delivers('{"type":"chat_message","payload":{}}');
        expect(frames).toHaveLength(1);
      });

      check("goes quiet after an intentional close, rather than reporting a lost one", async () => {
        const states: SocketConnectionState[] = [];
        ctx.subject.onStateChange((state) => states.push(state));
        ctx.subject.connect(connectOptions);
        await ctx.native.opens();
        expect(states).toContain("connected");
        const reported = states.length;
        ctx.subject.disconnect();
        await ctx.native.closes();
        expect(states).toHaveLength(reported);
      });
    });
  });
}
