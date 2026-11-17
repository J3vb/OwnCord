import { describe, it, expect, afterEach } from "vitest";
import { buildSettingsSection } from "../../src/features/settings/settingsSection";
import { buildAccessibilityTab } from "../../src/features/settings/AccessibilityTab";
import { buildTextImagesTab } from "../../src/features/settings/TextImagesTab";

describe("buildSettingsSection", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("puts an h2 heading above a fresh card, with the section's own attributes", () => {
    const { el, head, heading, card } = buildSettingsSection({
      label: "Sounds",
      headingAttrs: { id: "sounds-title", tabindex: "-1" },
      attrs: { class: "my-part", "data-testid": "sounds", "aria-labelledby": "sounds-title" },
    });
    expect(el.tagName).toBe("SECTION");
    expect(el.className).toBe("settings-section my-part");
    expect(el.getAttribute("data-testid")).toBe("sounds");
    expect(el.getAttribute("aria-labelledby")).toBe("sounds-title");
    expect([...el.children]).toEqual([head, card]);
    expect(head.className).toBe("settings-section-head");
    expect([...head.children]).toEqual([heading]);
    expect(heading.tagName).toBe("H2");
    expect(heading.className).toBe("settings-section-label");
    expect(heading.id).toBe("sounds-title");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(heading.textContent).toBe("Sounds");
    expect(card.tagName).toBe("DIV");
    expect(card.className).toBe("settings-card");
  });

  it("makes a given element the card instead of nesting it in another one", () => {
    const details = document.createElement("details");
    details.className = "disclose";
    const { el, card } = buildSettingsSection({ label: "Danger zone", card: details });
    expect(card).toBe(details);
    expect(details.className).toBe("disclose settings-card");
    expect(el.lastElementChild).toBe(details);
    expect(el.querySelectorAll(".settings-card")).toHaveLength(1);
    expect(el.className).toBe("settings-section");
  });

  it.each([
    ["Accessibility", buildAccessibilityTab],
    ["Text & Images", buildTextImagesTab],
  ])("gives every %s row a section card under an h2", (_name, build) => {
    const ac = new AbortController();
    const pane = build(ac.signal);
    document.body.appendChild(pane);
    // The page title is the h1 above the pane: no heading level is skipped.
    expect(pane.querySelectorAll("h1, h3, h4, h5, h6")).toHaveLength(0);
    const sections = [...pane.querySelectorAll(":scope > .settings-section")];
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.querySelector(":scope > .settings-section-head > h2")!.textContent).not.toBe(
        "",
      );
      expect(section.querySelectorAll(":scope > .settings-card")).toHaveLength(1);
    }
    for (const row of pane.querySelectorAll(".setting-row:not(.nested)")) {
      expect(row.parentElement!.classList.contains("settings-card")).toBe(true);
    }
    ac.abort();
  });
});
