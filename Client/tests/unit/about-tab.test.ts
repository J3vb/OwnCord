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

import { buildAboutTab } from "../../src/components/settings/AboutTab";
import { expectConsole } from "../helpers/console";

const VERSIONS = [
  { version: "2.1.0", body: "- New thing" },
  { version: "2.0.0", body: "- Old thing" },
];

describe("About tab", () => {
  let controller: AbortController;
  beforeEach(() => {
    controller = new AbortController();
    mockLoad.mockResolvedValue(VERSIONS);
  });
  afterEach(() => controller.abort());

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
