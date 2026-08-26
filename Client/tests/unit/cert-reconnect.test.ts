import { describe, it, expect, vi } from "vitest";
import { reconnectAfterCertAccept } from "../../src/lib/cert-reconnect";

function fakeWs() {
  const listeners = new Set<(state: string) => void>();
  return {
    connect: vi.fn(),
    onStateChange: vi.fn((l: (state: string) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
    fire(state: string): void {
      for (const l of listeners) l(state);
    },
  };
}

describe("reconnectAfterCertAccept", () => {
  it("reconnects and navigates to main once the state change reaches 'connected'", () => {
    const ws = fakeWs();
    const router = { getCurrentPage: vi.fn(() => "connect"), navigate: vi.fn() };

    reconnectAfterCertAccept(ws, router, "h.example", "tok");

    expect(ws.connect).toHaveBeenCalledWith({ host: "h.example", token: "tok" });
    expect(router.navigate).not.toHaveBeenCalled();

    ws.fire("connecting");
    expect(router.navigate).not.toHaveBeenCalled();

    ws.fire("connected");
    expect(router.navigate).toHaveBeenCalledWith("main");
    expect(router.navigate).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes after firing once, so a later state change does not navigate twice", () => {
    const ws = fakeWs();
    const router = { getCurrentPage: vi.fn(() => "connect"), navigate: vi.fn() };

    reconnectAfterCertAccept(ws, router, "h.example", "tok");
    ws.fire("connected");
    ws.fire("connected");

    expect(router.navigate).toHaveBeenCalledTimes(1);
  });

  it("does not register a navigator when already on the main page", () => {
    const ws = fakeWs();
    const router = { getCurrentPage: vi.fn(() => "main"), navigate: vi.fn() };

    reconnectAfterCertAccept(ws, router, "h.example", "tok");

    expect(ws.onStateChange).not.toHaveBeenCalled();
    expect(ws.connect).toHaveBeenCalledWith({ host: "h.example", token: "tok" });
  });
});
