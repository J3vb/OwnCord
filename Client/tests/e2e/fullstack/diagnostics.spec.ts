import { test, expect } from "./fixtures";
import { openSettings, switchSettingsTab } from "../helpers";

async function openDiagnostics(page: import("@playwright/test").Page) {
  await openSettings(page);
  await switchSettingsTab(page, "Logs");
  await page.getByRole("button", { name: "Start connection test", exact: true }).click();
}

test("connection test exercises the real HTTP and authenticated socket paths without joining voice", async ({
  alice,
}) => {
  await openDiagnostics(alice);
  await expect(alice.getByTestId("diagnostics-status")).toContainText("Test complete");
  for (const stage of ["connection", "authentication", "websocket", "microphone"]) {
    await expect(alice.getByTestId(`diagnostic-${stage}`)).toHaveAttribute("data-status", "passed");
  }
  await expect(alice.getByTestId("diagnostic-signaling")).toHaveAttribute(
    "data-status",
    "not-tested",
  );
  await expect(alice.getByTestId("diagnostic-media")).toContainText("Join a call");
  await expect(alice.locator(".voice-widget")).not.toHaveClass(/visible/);
});

test("connection test exposes HTTP and microphone failures at their actual boundaries", async ({
  alice,
  aliceTransport,
}) => {
  aliceTransport.failHttpRequests(({ path }) => path === "/api/v1/health");
  await alice.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await openDiagnostics(alice);
  await expect(alice.getByTestId("diagnostics-status")).toContainText("Test complete");
  await expect(alice.getByTestId("diagnostic-connection")).toHaveAttribute("data-status", "failed");
  await expect(alice.getByTestId("diagnostic-websocket")).toHaveAttribute("data-status", "passed");
  await expect(alice.getByTestId("diagnostic-microphone")).toContainText(
    "Microphone access was denied",
  );
  await expect(alice.getByTestId("diagnostic-media")).toHaveAttribute("data-status", "not-tested");
});

test("connection test does not accept an offline application socket as healthy", async ({
  alice,
  aliceTransport,
}) => {
  await aliceTransport.offline();
  await expect(alice.locator(".reconnecting-banner")).toBeVisible();
  await openDiagnostics(alice);
  await expect(alice.getByTestId("diagnostics-status")).toContainText("Test complete");
  await expect(alice.getByTestId("diagnostic-websocket")).toHaveAttribute("data-status", "failed");
  aliceTransport.online();
});

declare global {
  interface Window {
    __diagnosticLateMic?: {
      release(): Promise<void>;
      tracks: MediaStreamTrack[];
    };
  }
}

for (const action of ["cancel", "close"] as const) {
  test(`a microphone prompt resolved after ${action} cannot leak capture or stale results`, async ({
    alice,
  }) => {
    await alice.evaluate(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      let resolve!: (stream: MediaStream) => void;
      navigator.mediaDevices.getUserMedia = () =>
        new Promise<MediaStream>((done) => {
          resolve = done;
        });
      const late = {
        tracks: [] as MediaStreamTrack[],
        async release() {
          const stream = await original({ audio: true });
          late.tracks.push(...stream.getTracks());
          resolve(stream);
        },
      };
      window.__diagnosticLateMic = late;
    });
    await openDiagnostics(alice);
    await expect(alice.getByTestId("diagnostic-microphone")).toHaveAttribute(
      "data-status",
      "running",
    );
    if (action === "cancel")
      await alice.getByRole("button", { name: "Cancel test", exact: true }).click();
    else await alice.locator(".settings-close-btn").click();
    await alice.evaluate(() => window.__diagnosticLateMic!.release());
    await expect
      .poll(() =>
        alice.evaluate(() => window.__diagnosticLateMic!.tracks.map((track) => track.readyState)),
      )
      .toEqual(["ended"]);
    if (action === "cancel") {
      await expect(alice.getByTestId("diagnostics-status")).toHaveText("Test cancelled.");
      await expect(alice.getByTestId("diagnostic-microphone")).toHaveCount(0);
    } else {
      await openSettings(alice);
      await expect(alice.getByTestId("diagnostics-status")).toHaveText("Ready to test.");
      await expect(alice.getByTestId("diagnostic-microphone")).toHaveCount(0);
    }
  });
}
