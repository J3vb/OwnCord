import { describe, it, expect, vi, afterEach } from "vitest";
import { createIcon, type IconName } from "../../src/lib/icons";

describe("createIcon template cache", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns distinct nodes with identical markup", () => {
    const a = createIcon("pin", 16);
    const b = createIcon("pin", 16);
    expect(a).not.toBe(b);
    expect(a.outerHTML).toBe(b.outerHTML);
    expect(a.getAttribute("data-icon")).toBe("pin");
    expect(a.getAttribute("aria-hidden")).toBe("true");
    expect(a.classList.contains("icon")).toBe(true);
    const host = document.createElement("div");
    host.append(a, b);
    expect(host.querySelectorAll("svg")).toHaveLength(2);
  });

  it("parses innerHTML once for two calls of one name", () => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
    const set = vi.fn(function (this: Element, v: string) {
      desc.set!.call(this, v);
    });
    Object.defineProperty(Element.prototype, "innerHTML", { ...desc, set, configurable: true });
    try {
      createIcon("mic-off", 20);
      createIcon("mic-off", 20);
      expect(set).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(Element.prototype, "innerHTML", desc);
    }
  });

  it("applies size per call and does not leak mutations", () => {
    const a = createIcon("send", 12);
    const b = createIcon("send", 32);
    expect(a.getAttribute("width")).toBe("12");
    expect(b.getAttribute("height")).toBe("32");
    a.setAttribute("stroke", "red");
    expect(createIcon("send", 12).getAttribute("stroke")).toBe("currentColor");
  });

  it("builds every child shape with its attributes", () => {
    const svg = createIcon("ellipsis", 16);
    const circles = [...svg.children];
    expect(circles.map((c) => c.localName)).toEqual(["circle", "circle", "circle"]);
    expect(circles.map((c) => c.getAttribute("cx"))).toEqual(["12", "19", "5"]);
    expect(circles.every((c) => c.namespaceURI === "http://www.w3.org/2000/svg")).toBe(true);
    circles[0]!.setAttribute("r", "9");
    expect(createIcon("ellipsis", 16).children[0]!.getAttribute("r")).toBe("1");
  });

  it("caches no element to clone, so the page holds no detached icon nodes", () => {
    createIcon("flag", 16);
    const clone = vi.spyOn(Node.prototype, "cloneNode");
    createIcon("flag", 16);
    expect(clone).not.toHaveBeenCalled();
  });

  it("unknown name still returns an empty svg", () => {
    const svg = createIcon("no-such-icon" as IconName, 10);
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.childNodes).toHaveLength(0);
    expect(svg.getAttribute("data-icon")).toBe("no-such-icon");
  });
});
