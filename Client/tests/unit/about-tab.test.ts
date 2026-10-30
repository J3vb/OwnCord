import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetVersion, mockLoad } = vi.hoisted(() => ({
  mockGetVersion: vi.fn<() => Promise<string | null>>(),
  mockLoad: vi.fn<() => Promise<{ version: string; body: string }[]>>(),
}));
vi.mock("../../src/platform/desktop", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/desktop")>();
  return { desktop: { ...real.desktop, appMetadata: { getVersion: mockGetVersion } } };
});
vi.mock("../../src/features/whats-new/changelogSource", () => ({ loadChangelog: mockLoad }));

const { mockInstall, mockSubscribeInstall } = vi.hoisted(() => ({
  mockInstall: vi.fn<(serverUrl: string) => Promise<void>>(),
  mockSubscribeInstall: vi.fn(),
}));
vi.mock("@lib/net/updater", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/net/updater")>();
  return {
    ...real,
    downloadAndInstallUpdate: mockInstall,
    subscribeToUpdateInstall: mockSubscribeInstall,
  };
});

import { buildAboutTab } from "../../src/components/settings/AboutTab";
import { setAvailableUpdate } from "../../src/features/updates/availableUpdate";
import type { UpdateInstallState } from "../../src/lib/net/updater";
import { expectConsole } from "../helpers/console";

const VERSIONS = [
  { version: "2.1.0", body: "- New thing" },
  { version: "2.0.0", body: "- Old thing" },
];

describe("About tab", () => {
  let controller: AbortController;
  let installListener: (state: UpdateInstallState) => void = () => {};
  beforeEach(() => {
    controller = new AbortController();
    mockLoad.mockResolvedValue(VERSIONS);
    mockInstall.mockResolvedValue(undefined);
    mockSubscribeInstall.mockImplementation((listener: (state: UpdateInstallState) => void) => {
      installListener = listener;
      listener({ status: "idle" });
      return () => {};
    });
  });
  afterEach(() => {
    controller.abort();
    setAvailableUpdate(null);
  });

  it("hides the update card while no newer version is on offer", () => {
    mockGetVersion.mockResolvedValue("2.1.0");
    const el = buildAboutTab(controller.signal);
    expect(el.querySelector<HTMLElement>("[data-testid=about-update]")!.hidden).toBe(true);
  });

  it("shows the offered version with its own notes and installs it", async () => {
    mockGetVersion.mockResolvedValue("2.1.0");
    const el = buildAboutTab(controller.signal);
    setAvailableUpdate({ version: "2.2.0", body: "- Shiny thing", serverUrl: "https://s.example" });
    const card = el.querySelector<HTMLElement>("[data-testid=about-update]")!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector(".about-update-title")!.textContent).toBe(
      "Version 2.2.0 is available",
    );
    expect(card.textContent).toContain("What's coming in 2.2.0");
    expect(card.textContent).toContain("Shiny thing");
    const notes = card.querySelector<HTMLElement>(".about-update-notes")!;
    expect(notes.tabIndex).toBe(0);
    expect(notes.getAttribute("aria-label")).toBe("Release notes for 2.2.0");
    await vi.waitFor(() =>
      expect(card.textContent).toContain("You have 2.1.0. The app restarts to finish the update."),
    );

    const install = card.querySelector<HTMLButtonElement>(".about-update-install")!;
    install.click();
    expect(mockInstall).toHaveBeenCalledWith("https://s.example");

    installListener({ status: "downloading", progress: null });
    expect(install.disabled).toBe(true);
    expect(card.textContent).toContain("Downloading update…");
  });

  it("links the release on GitHub when the offer came without notes", () => {
    mockGetVersion.mockResolvedValue(null);
    const el = buildAboutTab(controller.signal);
    setAvailableUpdate({ version: "2.2.0", body: " ", serverUrl: "https://s.example" });
    const card = el.querySelector<HTMLElement>("[data-testid=about-update]")!;
    expect(card.querySelector(".about-notes-missing")?.getAttribute("href")).toBe(
      "https://github.com/J3vb/OwnCord/releases/tag/v2.2.0",
    );
    expect(card.textContent).toContain("The app restarts to finish the update.");
    setAvailableUpdate(null);
    expect(card.hidden).toBe(true);
  });

  it("shows the version, its notes, the update check and the repository link", async () => {
    mockGetVersion.mockResolvedValue("2.1.0");
    const el = buildAboutTab(controller.signal);
    await vi.waitFor(() =>
      expect(el.querySelector("[data-testid=about-version]")!.textContent).toBe("OwnCord v2.1.0"),
    );
    await vi.waitFor(() =>
      expect(el.querySelector("[data-testid=about-notes]")!.textContent).toContain("New thing"),
    );
    expect(el.textContent).toContain("What's new in 2.1.0");
    // Long notes scroll from the keyboard: the box is a named, focusable region.
    const notes = el.querySelector<HTMLElement>("[data-testid=about-notes]")!;
    expect(notes.tabIndex).toBe(0);
    expect(notes.getAttribute("role")).toBe("region");
    expect(notes.getAttribute("aria-label")).toBe("Release notes");
    expect(el.querySelector(".update-check-btn")).not.toBeNull();
    const repo = el.querySelector<HTMLAnchorElement>(".about-repo-link")!;
    expect(repo.getAttribute("href")).toBe("https://github.com/J3vb/OwnCord");
    expect(repo.getAttribute("target")).toBe("_blank");
  });

  it("lists the earlier versions, rendering each on first open", async () => {
    mockGetVersion.mockResolvedValue("2.1.0");
    const el = buildAboutTab(controller.signal);
    await vi.waitFor(() => expect(el.querySelector("[data-testid=about-history]")).not.toBeNull());
    const rows = [
      ...el.querySelectorAll<HTMLDetailsElement>("[data-testid=about-history] details"),
    ];
    expect(rows.map((r) => r.querySelector("summary")!.textContent)).toEqual(["Version 2.0.0 "]);
    expect(rows[0]!.textContent).not.toContain("Old thing");
    rows[0]!.open = true;
    rows[0]!.dispatchEvent(new Event("toggle"));
    expect(rows[0]!.textContent).toContain("Old thing");
  });

  it("points at GitHub when this version has no notes, and keeps the version", async () => {
    mockGetVersion.mockResolvedValue("2.2.0-dev");
    const el = buildAboutTab(controller.signal);
    await vi.waitFor(() =>
      expect(el.querySelector(".about-notes-missing")?.getAttribute("href")).toBe(
        "https://github.com/J3vb/OwnCord/releases/tag/v2.2.0-dev",
      ),
    );
    expect(el.querySelector("[data-testid=about-version]")!.textContent).toBe("OwnCord v2.2.0-dev");
    expect(el.querySelectorAll("[data-testid=about-history] details")).toHaveLength(2);
  });

  it("still shows the version when the notes fail to load", async () => {
    mockGetVersion.mockResolvedValue("2.1.0");
    mockLoad.mockRejectedValue(new Error("chunk failed"));
    const el = buildAboutTab(controller.signal);
    await vi.waitFor(() => expect(el.textContent).toContain("Couldn't load the release notes"));
    expect(el.querySelector("[data-testid=about-version]")!.textContent).toBe("OwnCord v2.1.0");
    expectConsole("warn", /Release notes unavailable/);
  });

  it("says OwnCord, never vnull, when the host reports no version", async () => {
    mockGetVersion.mockResolvedValue(null);
    const el = buildAboutTab(controller.signal);
    await vi.waitFor(() => expect(el.querySelector(".about-notes-missing")).not.toBeNull());
    expect(el.querySelector("[data-testid=about-version]")!.textContent).toBe("OwnCord");
    expect(el.textContent).not.toContain("vnull");
  });
});
