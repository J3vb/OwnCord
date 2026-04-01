import { describe, it, expect } from "vitest";
import { createIcon } from "../../src/lib/icons";
import type { IconName } from "../../src/lib/icons";

// All icon names exported from icons.ts
const ALL_ICON_NAMES: IconName[] = [
  "mic",
  "mic-off",
  "headphones",
  "headphones-off",
  "camera",
  "camera-off",
  "monitor",
  "monitor-off",
  "phone",
  "phone-off",
  "volume-2",
  "volume-x",
  "pin",
  "pin-off",
  "users",
  "settings",
  "smile",
  "send",
  "reply",
  "pencil",
  "trash-2",
  "file-text",
  "download",
  "chevron-down",
  "chevron-right",
  "x",
  "eye",
  "eye-off",
  "play",
  "pause",
  "check",
  "external-link",
  "loader",
  "arrow-right",
  "hash",
  "triangle-alert",
];

describe("createIcon", () => {
  it("returns a valid SVGSVGElement", () => {
    const svg = createIcon("mic");
    expect(svg).toBeInstanceOf(SVGSVGElement);
  });

  it("default size is 24", () => {
    const svg = createIcon("mic");
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
  });

  it("respects a custom size", () => {
    const svg = createIcon("mic", 16);
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
  });

  it("sets viewBox to '0 0 24 24'", () => {
    const svg = createIcon("send");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("sets fill to 'none'", () => {
    const svg = createIcon("send");
    expect(svg.getAttribute("fill")).toBe("none");
  });

  it("sets stroke to 'currentColor'", () => {
    const svg = createIcon("send");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });

  it("sets stroke-width to '2'", () => {
    const svg = createIcon("send");
    expect(svg.getAttribute("stroke-width")).toBe("2");
  });

  it("sets stroke-linecap to 'round'", () => {
    const svg = createIcon("send");
    expect(svg.getAttribute("stroke-linecap")).toBe("round");
  });

  it("sets stroke-linejoin to 'round'", () => {
    const svg = createIcon("send");
    expect(svg.getAttribute("stroke-linejoin")).toBe("round");
  });

  it("applies the 'icon' CSS class", () => {
    const svg = createIcon("pin");
    expect(svg.classList.contains("icon")).toBe(true);
  });

  it("sets data-icon attribute to the icon name", () => {
    const svg = createIcon("volume-2");
    expect(svg.getAttribute("data-icon")).toBe("volume-2");
  });

  it("sets aria-hidden to 'true'", () => {
    const svg = createIcon("x");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("every IconName produces a non-empty SVG", () => {
    for (const name of ALL_ICON_NAMES) {
      const svg = createIcon(name);
      expect(
        svg.innerHTML.trim().length,
        `Expected non-empty innerHTML for icon "${name}"`,
      ).toBeGreaterThan(0);
    }
  });

  it("data-icon attribute matches the requested name for every IconName", () => {
    for (const name of ALL_ICON_NAMES) {
      const svg = createIcon(name);
      expect(svg.getAttribute("data-icon"), `data-icon mismatch for "${name}"`).toBe(name);
    }
  });
});
