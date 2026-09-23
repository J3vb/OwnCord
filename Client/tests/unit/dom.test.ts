import { describe, it, expect, vi } from "vitest";
import {
  createElement,
  setText,
  appendChildren,
  clearChildren,
  qs,
  setOwnedTimeout,
} from "../../src/lib/dom";

describe("createElement", () => {
  it("creates an element with the given tag", () => {
    const el = createElement("div");
    expect(el.tagName).toBe("DIV");
  });

  it("sets text content safely", () => {
    const el = createElement("span", {}, "<script>xss</script>");
    expect(el.textContent).toBe("<script>xss</script>");
    expect(el.innerHTML).toBe("&lt;script&gt;xss&lt;/script&gt;");
  });

  it("sets class attribute", () => {
    const el = createElement("div", { class: "foo bar" });
    expect(el.className).toBe("foo bar");
  });

  it("sets data attributes", () => {
    const el = createElement("div", { "data-id": "42" });
    expect(el.dataset["id"]).toBe("42");
  });

  it("sets aria attributes", () => {
    const el = createElement("button", { "aria-label": "Close" });
    expect(el.getAttribute("aria-label")).toBe("Close");
  });

  it("sets regular attributes", () => {
    const el = createElement("input", { type: "text", id: "name" });
    expect(el.getAttribute("type")).toBe("text");
    expect(el.id).toBe("name");
  });
});

describe("setText", () => {
  it("sets text content safely", () => {
    const el = document.createElement("div");
    setText(el, "<b>bold</b>");
    expect(el.textContent).toBe("<b>bold</b>");
    expect(el.children.length).toBe(0);
  });
});

describe("appendChildren", () => {
  it("appends element children", () => {
    const parent = document.createElement("div");
    const child1 = document.createElement("span");
    const child2 = document.createElement("p");
    appendChildren(parent, child1, child2);
    expect(parent.children.length).toBe(2);
  });

  it("appends string children as text nodes", () => {
    const parent = document.createElement("div");
    appendChildren(parent, "hello ", "world");
    expect(parent.textContent).toBe("hello world");
    expect(parent.childNodes.length).toBe(2);
  });

  it("appends mixed children", () => {
    const parent = document.createElement("div");
    const span = createElement("span", {}, "bold");
    appendChildren(parent, "text ", span);
    expect(parent.childNodes.length).toBe(2);
    expect(parent.textContent).toBe("text bold");
  });
});

describe("clearChildren", () => {
  it("removes all children", () => {
    const parent = document.createElement("div");
    parent.appendChild(document.createElement("span"));
    parent.appendChild(document.createElement("p"));
    parent.appendChild(document.createTextNode("text"));
    expect(parent.childNodes.length).toBe(3);
    clearChildren(parent);
    expect(parent.childNodes.length).toBe(0);
  });

  it("handles already empty element", () => {
    const parent = document.createElement("div");
    clearChildren(parent);
    expect(parent.childNodes.length).toBe(0);
  });
});

describe("qs", () => {
  it("qs finds element by selector", () => {
    const container = document.createElement("div");
    const child = document.createElement("span");
    child.className = "target";
    container.appendChild(child);
    document.body.appendChild(container);

    expect(qs(".target")).toBe(child);

    document.body.removeChild(container);
  });

  it("qs returns null when not found", () => {
    expect(qs(".nonexistent-class-12345")).toBeNull();
  });

  it("qs scopes to parent", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    child.className = "scoped";
    parent.appendChild(child);

    const other = document.createElement("div");
    expect(qs(".scoped", other)).toBeNull();
    expect(qs(".scoped", parent)).toBe(child);
  });
});

describe("setOwnedTimeout", () => {
  it("runs the step after the delay while its owner is live", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      setOwnedTimeout(new AbortController().signal, fn, 100);
      vi.advanceTimersByTime(99);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the pending step when its owner aborts", () => {
    vi.useFakeTimers();
    try {
      const owner = new AbortController();
      const fn = vi.fn();
      setOwnedTimeout(owner.signal, fn, 100);
      owner.abort();
      vi.advanceTimersByTime(100);
      expect(fn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules nothing once its owner has aborted", () => {
    vi.useFakeTimers();
    try {
      const owner = new AbortController();
      owner.abort();
      const fn = vi.fn();
      setOwnedTimeout(owner.signal, fn, 0);
      expect(vi.getTimerCount()).toBe(0);
      vi.runAllTimers();
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops its abort registration when it fires, so re-arming never accumulates", () => {
    vi.useFakeTimers();
    try {
      const owner = new AbortController();
      const remove = vi.spyOn(owner.signal, "removeEventListener");
      const fn = vi.fn();
      setOwnedTimeout(owner.signal, fn, 10);
      vi.advanceTimersByTime(10);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });
});
