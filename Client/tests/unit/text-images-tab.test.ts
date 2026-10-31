import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildTextImagesTab } from "../../src/features/settings/TextImagesTab";

describe("TextImagesTab", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
  });

  it("renders 5 media toggles and 5 chat bar toggles (no dead showSpoilers)", () => {
    const section = buildTextImagesTab(ac.signal);
    container.appendChild(section);

    const toggles = container.querySelectorAll(".toggle");
    expect(toggles.length).toBe(10);

    const labels = container.querySelectorAll(".setting-label");
    const labelTexts = Array.from(labels).map((l) => l.textContent);

    expect(labelTexts).toContain("Link Preview");
    expect(labelTexts).toContain("Show Embeds");
    expect(labelTexts).toContain("Inline Attachment Preview");
    expect(labelTexts).toContain("Animate GIFs");
    expect(labelTexts).toContain("Animate emoji");
    expect(labelTexts).toContain("Show emoji button");
    expect(labelTexts).toContain("Show sticker button");
    expect(labelTexts).toContain("Show GIF button");
    expect(labelTexts).toContain("Show Poll button");
    expect(labelTexts).toContain("Show voice message button");

    // Dead toggles should NOT be present
    expect(labelTexts).not.toContain("Show Spoiler Content");
  });

  it("Animate emoji is on by default and writes its pref when switched", () => {
    const section = buildTextImagesTab(ac.signal);
    container.appendChild(section);
    const toggle = container.querySelector<HTMLElement>('.toggle[aria-label="Animate emoji"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(localStorage.getItem("owncord:settings:animateEmoji")).toBe("false");
    toggle.click();
    expect(localStorage.getItem("owncord:settings:animateEmoji")).toBe("true");
  });

  it("chat bar toggles are on by default and write their pref when switched", () => {
    const section = buildTextImagesTab(ac.signal);
    container.appendChild(section);
    const toggle = container.querySelector<HTMLElement>('.toggle[aria-label="Show GIF button"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(localStorage.getItem("owncord:settings:composerShowGif")).toBe("false");
    toggle.click();
    expect(localStorage.getItem("owncord:settings:composerShowGif")).toBe("true");
  });

  it("persists toggle state to localStorage", () => {
    const section = buildTextImagesTab(ac.signal);
    container.appendChild(section);

    const toggles = container.querySelectorAll(".toggle");
    // Link Preview is first, default on
    const linkToggle = toggles[0] as HTMLElement;
    expect(linkToggle.classList.contains("on")).toBe(true);

    linkToggle.click();
    expect(linkToggle.classList.contains("on")).toBe(false);
    expect(localStorage.getItem("owncord:settings:showLinkPreviews")).toBe("false");
  });
});
