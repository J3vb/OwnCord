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
    panel.element.querySelector<HTMLButtonElement>("[data-testid=diagnostics-start]")!.click();
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

  describe("status-first results", () => {
    const row = (stage: string) =>
      panel.element.querySelector<HTMLElement>(`[data-testid="diagnostic-${stage}"]`)!;
    const summary = () => panel.element.querySelector<HTMLElement>("[role=status]")!;

    it("answers first: a clean run says everything tested works, with the counts", async () => {
      start();
      await vi.waitFor(() => expect(status()).toContain("Test complete"));
      expect(status()).toContain("Everything tested is working.");
      expect(status()).toContain("3 passed · 3 not tested");
      expect(summary().dataset.state).toBe("ok");
    });

    it("names the problem count and turns critical when a stage fails", async () => {
      getMe.mockRejectedValue(new Error("401"));
      start();
      await vi.waitFor(() => expect(status()).toContain("Test complete"));
      expect(status()).toContain("1 problem found.");
      expect(status()).toContain("2 passed · 1 failed · 3 not tested");
      expect(summary().dataset.state).toBe("crit");
    });

    it("shows each stage as a list row with a status icon, name and short result", async () => {
      start();
      await vi.waitFor(() => expect(status()).toContain("Test complete"));
      const passed = row("connection");
      expect(passed.tagName).toBe("LI");
      expect(passed.closest("ul")).not.toBeNull();
      expect(passed.querySelector(".st-ic.st-ok svg")).not.toBeNull();
      expect(passed.querySelector(".status-name")!.textContent).toBe("Server connection");
      expect(passed.querySelector(".status-result")!.textContent).toBe("Passed");
      // A passing stage keeps its full sentence as detail, off the scan line.
      expect(passed.title).toContain("certificate-checked connection");

      // A stage that was not tested shows what to do next, in words.
      const media = row("media");
      expect(media.querySelector(".st-ic.st-pending svg")).not.toBeNull();
      expect(media.querySelector(".status-result")!.textContent).toContain("Not tested");
      expect(media.querySelector(".status-result")!.textContent).toContain(
        "Join a call with another person",
      );
    });

    it("shows a failed stage's fix beside a critical icon", async () => {
      getMe.mockRejectedValue(new Error("401"));
      start();
      await vi.waitFor(() => expect(status()).toContain("Test complete"));
      const auth = row("authentication");
      expect(auth.dataset.status).toBe("failed");
      expect(auth.querySelector(".st-ic.st-crit svg")).not.toBeNull();
      expect(auth.querySelector(".status-result")!.textContent).toContain("Failed");
      expect(auth.querySelector(".status-result")!.textContent).toContain("sign in again");
    });

    it("offers Run again as a secondary action once results are shown, and resets with them", async () => {
      const startButton = () =>
        panel.element.querySelector<HTMLButtonElement>("[data-testid=diagnostics-start]")!;
      expect(startButton().textContent).toBe("Start connection test");
      expect(startButton().classList.contains("secondary")).toBe(true);
      start();
      await vi.waitFor(() => expect(startButton().textContent).toBe("Run again"));
      scope.dispose();
      scope = new SessionScope({ host: "server.test", generation: 2 });
      expect(startButton().textContent).toBe("Start connection test");
    });

    it("keeps the test's limits behind a closed disclosure", () => {
      const limits = [...panel.element.querySelectorAll("details")].find((d) =>
        d.querySelector("summary")!.textContent!.includes("What this test does not check"),
      );
      expect(limits).toBeDefined();
      expect(limits!.open).toBe(false);
      expect(limits!.textContent).toContain("Results describe this device and this moment.");
    });
  });
});
