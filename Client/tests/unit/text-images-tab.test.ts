import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildTextImagesTab } from "@components/settings/TextImagesTab";

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

  it("renders exactly 4 toggles (no dead animateEmoji or showSpoilers)", () => {
    const section = buildTextImagesTab(ac.signal);
    container.appendChild(section);

    const toggles = container.querySelectorAll(".toggle");
    expect(toggles.length).toBe(4);

    const labels = container.querySelectorAll(".setting-label");
    const labelTexts = Array.from(labels).map((l) => l.textContent);

    expect(labelTexts).toContain("Link Preview");
    expect(labelTexts).toContain("Show Embeds");
    expect(labelTexts).toContain("Inline Attachment Preview");
    expect(labelTexts).toContain("Animate GIFs");

    // Dead toggles should NOT be present
    expect(labelTexts).not.toContain("Animate Emoji");
    expect(labelTexts).not.toContain("Show Spoiler Content");
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
