import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "../helpers/log-capture";
import { expectConsole } from "../helpers/console";

const hoisted = vi.hoisted(() => ({
  getVersion: vi.fn<() => Promise<string | null>>(),
  release: { current: null as null | (() => void), fail: null as null | (() => void) },
}));
vi.mock("../../src/platform/desktop", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/desktop")>();
  return { desktop: { ...real.desktop, appMetadata: { getVersion: hoisted.getVersion } } };
});
vi.mock("../../src/features/whats-new/changelogSource", () => ({
  loadChangelog: () =>
    new Promise((resolve, reject) => {
      hoisted.release.current = () => resolve([{ version: "2.1.0", body: "- New thing" }]);
      hoisted.release.fail = () => reject(new Error("notes unavailable"));
    }),
}));

// Loaded inside the first test body, so the module's own setup is part of that test.
const load = () => import("../../src/features/whats-new/whatsNewPrompt");
import { markVersionSeen } from "../../src/features/whats-new/seenVersion";

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-testid=whats-new-dialog]");

describe("What's new prompt lifecycle", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    hoisted.release.current = null;
    hoisted.release.fail = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it("logs a failed check under its own component and keeps the app running", async () => {
    const logs = captureLogs();
    markVersionSeen("2.0.0");
    hoisted.getVersion.mockResolvedValue("2.1.0");
    const prompt = (await load()).createWhatsNewPrompt(vi.fn());
    prompt.mount(container);
    await vi.waitFor(() => expect(hoisted.release.fail).not.toBeNull());
    hoisted.release.fail?.();
    await vi.waitFor(() => expect(logs.find("What's new check failed")).toHaveLength(1));
    const entry = logs.find("What's new check failed")[0]!;
    expect(entry.level).toBe("warn");
    expect(entry.component).toBe("whats-new");
    expect(entry.data).toEqual({ error: expect.stringContaining("notes unavailable") });
    expect(dialog()).toBeNull();
    expectConsole("warn", /What's new check failed/);
    prompt.destroy?.();
  });

  it("shows nothing and marks nothing seen when the page goes away while the notes load", async () => {
    markVersionSeen("2.0.0");
    hoisted.getVersion.mockResolvedValue("2.1.0");
    const prompt = (await load()).createWhatsNewPrompt(vi.fn());
    prompt.mount(container);
    await vi.waitFor(() => expect(hoisted.release.current).not.toBeNull());
    prompt.destroy?.();
    hoisted.release.current?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog()).toBeNull();
    expect(localStorage.getItem("owncord:whats-new:seen-version")).toBe("2.0.0");
  });

  it("forgets the dialog once it has closed, so a later teardown has nothing to close", async () => {
    markVersionSeen("2.0.0");
    hoisted.getVersion.mockResolvedValue("2.1.0");
    const prompt = (await load()).createWhatsNewPrompt(vi.fn());
    prompt.mount(container);
    await vi.waitFor(() => expect(hoisted.release.current).not.toBeNull());
    hoisted.release.current?.();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog()).toBeNull();
    prompt.destroy?.();
    expect(dialog()).toBeNull();
  });
});
