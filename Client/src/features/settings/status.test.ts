// Status icons, disclosures, status rows and reveal toggles used by the
// settings tabs: the markup the stylesheet and assistive tech depend on.
import { afterEach, describe, expect, it } from "vitest";
import {
  createDisclosure,
  createRevealToggle,
  createStatusRow,
  setStatusIcon,
  statusIcon,
} from "./status";

afterEach(() => {
  document.body.replaceChildren();
});

function iconSvg(el: Element): SVGSVGElement {
  return el.querySelector("svg")!;
}

describe("status icons", () => {
  it("draws an 18px icon in a span classed by its kind", () => {
    const icon = statusIcon("warn");
    expect(icon.className).toBe("st-ic st-warn");
    expect(icon.children).toHaveLength(1);
    const svg = iconSvg(icon);
    expect(svg.getAttribute("width")).toBe("18");
    expect(svg.getAttribute("height")).toBe("18");
  });

  it("draws a different icon for each kind", () => {
    const shapes = (["ok", "warn", "crit", "pending"] as const).map(
      (kind) => iconSvg(statusIcon(kind)).innerHTML,
    );
    expect(new Set(shapes).size).toBe(4);
  });

  it("repoints an existing icon at a new kind, keeping one drawing", () => {
    const icon = statusIcon("ok");
    const before = iconSvg(icon).innerHTML;
    setStatusIcon(icon, "crit");
    expect(icon.className).toBe("st-ic st-crit");
    expect(icon.children).toHaveLength(1);
    const svg = iconSvg(icon);
    expect(svg.innerHTML).not.toBe(before);
    expect(svg.innerHTML).toBe(iconSvg(statusIcon("crit")).innerHTML);
    expect(svg.getAttribute("width")).toBe("18");
  });

  it("fills an empty span when pointed at a kind", () => {
    const span = document.createElement("span");
    setStatusIcon(span, "pending");
    expect(span.className).toBe("st-ic st-pending");
    expect(span.querySelectorAll("svg")).toHaveLength(1);
    expect(iconSvg(span).getAttribute("width")).toBe("18");
  });
});

describe("createDisclosure", () => {
  it("builds a closed details with a chevron, a label and a count", () => {
    const { details, count } = createDisclosure("Advanced");
    expect(details.tagName).toBe("DETAILS");
    expect(details.className).toBe("disclose");
    expect(details.open).toBe(false);
    expect(count.className).toBe("disclose-count");
    const label = details.querySelector("summary .disclose-label")!;
    expect(label.tagName).toBe("SPAN");
    expect(label.textContent).toBe("Advanced");
    expect(details.querySelector("summary svg")?.getAttribute("width")).toBe("16");
    // The label, a space and the count make one accessible name.
    count.textContent = "3 items";
    expect(details.querySelector("summary")!.textContent).toBe("Advanced 3 items");
  });
});

describe("createStatusRow", () => {
  it("lays out icon, name, result and body with their classes", () => {
    const { row, icon, result, body } = createStatusRow("Microphone", "row-mic");
    expect(row.tagName).toBe("LI");
    expect(row.className).toBe("status-item");
    expect(row.getAttribute("data-testid")).toBe("row-mic");
    expect(icon.className).toBe("st-ic st-pending");
    expect(result.className).toBe("status-result");
    expect(body.className).toBe("status-body");
    expect(body.tagName).toBe("DIV");
    expect(row.querySelector(".status-name")?.textContent).toBe("Microphone");
    expect([...row.children]).toEqual([icon, row.querySelector(".status-name"), result, body]);
  });
});

function setup(): {
  panel: HTMLDivElement;
  button: HTMLButtonElement;
  ac: AbortController;
} {
  const ac = new AbortController();
  const panel = document.createElement("div");
  document.body.appendChild(panel);
  const button = createRevealToggle("Show details", panel, ac.signal, "reveal-x");
  document.body.appendChild(button);
  return { panel, button, ac };
}

const idNumber = (el: HTMLElement): number => Number(el.id.replace("settings-reveal-", ""));

describe("createRevealToggle", () => {
  it("starts hidden, with the button describing the panel it controls", () => {
    const { panel, button } = setup();
    expect(panel.hidden).toBe(true);
    expect(button.type).toBe("button");
    expect(button.className).toBe("ac-btn secondary");
    expect(button.textContent).toBe("Show details");
    expect(button.getAttribute("data-testid")).toBe("reveal-x");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panel.id).toMatch(/^settings-reveal-\d+$/);
    expect(button.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("gives each panel its own increasing id and keeps an id it already has", () => {
    const a = setup();
    const b = setup();
    expect(idNumber(a.panel)).toBeGreaterThan(0);
    expect(idNumber(b.panel)).toBe(idNumber(a.panel) + 1);

    const own = document.createElement("div");
    own.id = "mine";
    const button = createRevealToggle("x", own, new AbortController().signal, "t");
    expect(own.id).toBe("mine");
    expect(button.getAttribute("aria-controls")).toBe("mine");
  });

  it("shows and hides the panel on click, keeping aria-expanded in step", () => {
    const { panel, button } = setup();
    button.click();
    expect(panel.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    button.click();
    expect(panel.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("stops responding once the tab's signal aborts", () => {
    const { panel, button, ac } = setup();
    ac.abort();
    button.click();
    expect(panel.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
