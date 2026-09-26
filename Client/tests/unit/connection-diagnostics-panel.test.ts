import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@lib/api";
import type { WsClient } from "@lib/ws";
import { SessionScope } from "@lib/sessionScope";
import { configureConnectionDiagnostics } from "@lib/connectionDiagnostics";
import { createConnectionDiagnosticsPanel } from "@components/settings/ConnectionDiagnosticsPanel";

vi.mock("@lib/livekitSession", () => ({ getRoomForStats: () => null }));

describe("connection diagnostics session ownership in settings", () => {
  let scope: SessionScope;
  let ac: AbortController;
  let panel: ReturnType<typeof createConnectionDiagnosticsPanel>;
  let health: ReturnType<typeof vi.fn>;
  let getMe: ReturnType<typeof vi.fn>;
  const start = () => {
    const buttons = [...panel.element.querySelectorAll("button")];
    buttons.find((button) => button.textContent === "Start connection test")!.click();
  };
  const status = () => panel.element.querySelector("[role=status]")!.textContent;

  beforeEach(() => {
    scope = new SessionScope({ host: "server.test", generation: 1 });
    ac = new AbortController();
    health = vi.fn().mockResolvedValue({});
    getMe = vi.fn().mockResolvedValue({ id: 1 });
    configureConnectionDiagnostics(
      {
        getSession: () => scope,
        getConfig: () => ({ host: "server.test", token: "[redacted]" }),
        getHealth: health,
        getMe,
      } as unknown as ApiClient,
      { ping: vi.fn().mockResolvedValue(undefined) } as unknown as WsClient,
    );
    panel = createConnectionDiagnosticsPanel(ac.signal);
    panel.element.querySelector("input")!.checked = false;
    document.body.appendChild(panel.element);
  });
  afterEach(() => {
    panel.cleanup();
    panel.element.remove();
    ac.abort();
    scope.dispose();
  });

  it("clears completed results after a same-server account switch and tests the next session afresh", async () => {
    start();
    await vi.waitFor(() => expect(status()).toContain("Test complete"));
    expect(panel.element.querySelectorAll('[data-status="passed"]').length).toBe(3);
    scope.dispose();
    scope = new SessionScope({ host: "server.test", generation: 2 });
    expect(status()).toContain("session changed");
    expect(panel.element.querySelectorAll("[data-status]")).toHaveLength(0);
    start();
    await vi.waitFor(() => expect(status()).toContain("Test complete"));
    expect(health).toHaveBeenCalledTimes(2);
    expect(getMe).toHaveBeenCalledTimes(2);
  });

  it("does not update a closed settings pane after an unabortable health request resolves", async () => {
    let resolve!: (value: unknown) => void;
    health.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    start();
    expect(status()).toBe("Testing…");
    panel.cleanup();
    const closedContents = panel.element.textContent;
    resolve({});
    await vi.waitFor(() => expect(getMe).not.toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 0));
    expect(panel.element.textContent).toBe(closedContents);
    expect(getMe).not.toHaveBeenCalled();
  });
});
