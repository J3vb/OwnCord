import { describe, it, expect } from "vitest";
import {
  applyStatusIndicator,
  applyStatusLine,
  showsPhone,
  statusColor,
} from "../../src/lib/ui/statusIndicator";

function dot(): HTMLElement {
  return document.createElement("div");
}

describe("applyStatusIndicator", () => {
  it("draws the phone class with the 'on the phone app' title for an online member on the phone", () => {
    const el = dot();
    const label = applyStatusIndicator(el, "online", true);
    expect(el.classList.contains("status-mobile")).toBe(true);
    expect(el.style.background).toBe("var(--green)");
    expect(el.title).toBe("Online on the phone app");
    expect(label).toBe("Online on the phone app");
  });

  it("keeps the status colour and words each status its own phone title", () => {
    const idle = dot();
    applyStatusIndicator(idle, "idle", true);
    expect(idle.style.background).toBe("var(--yellow)");
    expect(idle.title).toBe("Idle on the phone app");

    const dnd = dot();
    applyStatusIndicator(dnd, "dnd", true);
    expect(dnd.style.background).toBe("var(--red)");
    expect(dnd.title).toBe("Do Not Disturb on the phone app");
  });

  it("stays a round dot for an offline member even when the flag is set", () => {
    const el = dot();
    applyStatusIndicator(el, "offline", true);
    expect(el.classList.contains("status-mobile")).toBe(false);
    expect(el.title).toBe("Offline");
    expect(el.style.background).toBe("var(--text-micro)");
  });

  it("stays round when the member is not on the phone", () => {
    const el = dot();
    applyStatusIndicator(el, "online", false);
    expect(el.classList.contains("status-mobile")).toBe(false);
    expect(el.title).toBe("Online");
  });

  it("goes back to the round dot when the phone flag clears", () => {
    const el = dot();
    applyStatusIndicator(el, "online", true);
    applyStatusIndicator(el, "online", false);
    expect(el.classList.contains("status-mobile")).toBe(false);
    expect(el.title).toBe("Online");
  });

  it("never shows the phone for an invisible status", () => {
    expect(showsPhone("invisible", true)).toBe(false);
    expect(statusColor("invisible")).toBe("var(--text-micro)");
  });
});

describe("applyStatusLine", () => {
  it("swaps the marker's dot for a phone icon and back", () => {
    const marker = document.createElement("span");
    expect(applyStatusLine(marker, "online", true)).toBe("Online on the phone app");
    expect(marker.classList.contains("status-line-phone")).toBe(true);
    expect(marker.querySelector("svg")).not.toBeNull();
    expect(marker.style.background).toBe("");

    expect(applyStatusLine(marker, "online", false)).toBe("Online");
    expect(marker.classList.contains("status-line-phone")).toBe(false);
    expect(marker.querySelector("svg")).toBeNull();
    expect(marker.style.background).toBe("var(--green)");
  });
});
