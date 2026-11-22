import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { loggerMock } from "../helpers/loggerMock";
import { wireConnectionBanner } from "../../src/features/connection/connectionBanner";
import type { ServerBannerControl } from "../../src/features/server-rail/ServerBanner";
import { uiStore, setConnectionStatus, setSessionReplaced } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { resetAuthState } from "../helpers/storeSeeds";
import { resetUiState } from "../helpers/dmHarness";

const errorSpy = vi.hoisted(() => vi.fn());
vi.mock("@lib/logger", () => loggerMock({ error: errorSpy }));

type RestartHandler = (payload: { delay_seconds: number }) => void;

function fakeBanner() {
  return {
    element: document.createElement("div"),
    liveElement: document.createElement("div"),
    showRestart: vi.fn(),
    showReconnecting: vi.fn(),
    showDisconnected: vi.fn(),
    showSignedInElsewhere: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
  } satisfies ServerBannerControl;
}

function fakeWs() {
  let handler: RestartHandler | null = null;
  const off = vi.fn(() => {
    handler = null;
  });
  return {
    connect: vi.fn(),
    on: vi.fn((_type: string, h: RestartHandler) => {
      handler = h;
      return off;
    }),
    off,
    restart: (delay: number): void => handler?.({ delay_seconds: delay }),
    hasRestartHandler: (): boolean => handler !== null,
  };
}

describe("wireConnectionBanner", () => {
  let banner: ReturnType<typeof fakeBanner>;
  let ws: ReturnType<typeof fakeWs>;
  let onConnected: Mock<() => void>;
  let teardown: (() => void) | null;

  function wire(): void {
    teardown = wireConnectionBanner({
      getBanner: () => banner,
      // The fake stands in for the WsClient; only connect and on are used.
      ws: ws as unknown as Parameters<typeof wireConnectionBanner>[0]["ws"],
      getHost: () => "host:1",
      onConnected,
    });
  }

  beforeEach(() => {
    resetUiState();
    resetAuthState();
    authStore.setState((s) => ({ ...s, token: "tok" }));
    banner = fakeBanner();
    ws = fakeWs();
    onConnected = vi.fn<() => void>();
    teardown = null;
    errorSpy.mockClear();
  });

  afterEach(() => {
    teardown?.();
    vi.restoreAllMocks();
  });

  it("Use here clears sessionReplaced and reconnects with takeover; no token does nothing", () => {
    setSessionReplaced(true);
    wire();
    expect(banner.showSignedInElsewhere).toHaveBeenCalledTimes(1);
    const useHere = banner.showSignedInElsewhere.mock.calls[0]![0] as () => void;
    useHere();
    expect(uiStore.getState().sessionReplaced).toBe(false);
    expect(ws.connect).toHaveBeenCalledWith({ host: "host:1", token: "tok" }, { takeover: true });

    setSessionReplaced(true);
    ws.connect.mockClear();
    authStore.setState((s) => ({ ...s, token: null }));
    useHere();
    expect(uiStore.getState().sessionReplaced).toBe(true);
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it("Retry reconnects without takeover", () => {
    setConnectionStatus("reconnecting", true);
    wire();
    const opts = banner.showReconnecting.mock.calls[0]![0] as { onRetry: () => void };
    opts.onRetry();
    expect(ws.connect).toHaveBeenCalledTimes(1);
    expect(ws.connect).toHaveBeenCalledWith({ host: "host:1", token: "tok" });
    authStore.setState((s) => ({ ...s, token: null }));
    opts.onRetry();
    expect(ws.connect).toHaveBeenCalledTimes(1);
  });

  it("re-syncs on offline/online only while not connected", () => {
    setConnectionStatus("disconnected");
    wire();
    banner.showDisconnected.mockClear();
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(banner.showDisconnected).toHaveBeenCalledTimes(2);

    setConnectionStatus("connected");
    uiStore.flush();
    banner.hide.mockClear();
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(banner.hide).not.toHaveBeenCalled();
  });

  it("a network flap while connected keeps a restart countdown", () => {
    setConnectionStatus("connected");
    wire();
    banner.hide.mockClear();
    ws.restart(30);
    expect(banner.showRestart).toHaveBeenCalledWith(30);
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(banner.hide).not.toHaveBeenCalled();
    expect(banner.showRestart).toHaveBeenCalledTimes(1);
  });

  it("after teardown no event or restart frame touches the banner and no listener is left", () => {
    setConnectionStatus("disconnected");
    wire();
    teardown!();
    teardown = null;
    banner.showDisconnected.mockClear();
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    setConnectionStatus("reconnecting");
    uiStore.flush();
    setSessionReplaced(true);
    uiStore.flush();
    ws.restart(10);
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(ws.hasRestartHandler()).toBe(false);
    expect(banner.showDisconnected).not.toHaveBeenCalled();
    expect(banner.showReconnecting).not.toHaveBeenCalled();
    expect(banner.showRestart).not.toHaveBeenCalled();
    expect(banner.showSignedInElsewhere).not.toHaveBeenCalled();
  });

  it("a zero-delay server_restart re-syncs instead of counting down", () => {
    setConnectionStatus("reconnecting");
    wire();
    banner.showReconnecting.mockClear();
    ws.restart(0);
    expect(banner.showRestart).not.toHaveBeenCalled();
    expect(banner.showReconnecting).toHaveBeenCalledTimes(1);
  });

  it("runs onConnected when the status turns connected", () => {
    wire();
    setConnectionStatus("connected");
    uiStore.flush();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(banner.hide).toHaveBeenCalled();
  });

  it("a handler that throws logs at error level and the banner keeps working", () => {
    wire();
    onConnected.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    setConnectionStatus("connected");
    uiStore.flush();
    expect(errorSpy).toHaveBeenCalledWith("Connection status handler error", expect.any(Error));

    banner.showRestart.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    ws.restart(5);
    expect(errorSpy).toHaveBeenCalledWith("Server restart handler error", expect.any(Error));
    ws.restart(7);
    expect(banner.showRestart).toHaveBeenLastCalledWith(7);
  });
});
