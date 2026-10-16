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

  it("renders exactly 5 toggles (no dead showSpoilers)", () => {
    const section = buildTextImagesTab(ac.signal);
    container.appendChild(section);

    const toggles = container.querySelectorAll(".toggle");
    expect(toggles.length).toBe(5);

    const labels = container.querySelectorAll(".setting-label");
    const labelTexts = Array.from(labels).map((l) => l.textContent);

    expect(labelTexts).toContain("Link Preview");
    expect(labelTexts).toContain("Show Embeds");
    expect(labelTexts).toContain("Inline Attachment Preview");
    expect(labelTexts).toContain("Animate GIFs");
    expect(labelTexts).toContain("Animate emoji");

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
