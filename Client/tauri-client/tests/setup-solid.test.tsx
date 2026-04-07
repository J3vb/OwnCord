/**
 * Phase B Step 6 — mountSolid adapter lifecycle smoke tests (T-500).
 *
 * Verifies that the mountSolid adapter in @lib/solidMount correctly inserts a
 * Solid reactive root into the DOM and that destroy() disposes the root and
 * removes the host element, preventing memory leaks across test suites.
 *
 * These tests complement Badge.test.tsx (which validates the Solid rendering
 * pipeline end-to-end) by proving the *adapter* contract used by vanilla-DOM
 * container components.
 */
import { describe, it, expect } from "vitest";
import { mountSolid } from "@lib/solidMount";

describe("mountSolid adapter", () => {
  it("appends a data-solid-root host element to the parent on mount", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const handle = mountSolid(() => <span>test</span>, parent);

    expect(parent.querySelector("[data-solid-root]")).not.toBeNull();
    expect(handle.el.dataset.solidRoot).toBe("true");
    expect(handle.el.parentElement).toBe(parent);

    handle.destroy();
    parent.remove();
  });

  it("removes the host element from the DOM after destroy()", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const handle = mountSolid(() => <span>cleanup-check</span>, parent);
    expect(parent.children).toHaveLength(1);

    handle.destroy();

    expect(parent.querySelector("[data-solid-root]")).toBeNull();
    expect(parent.children).toHaveLength(0);

    parent.remove();
  });

  it("supports multiple independent mounts under the same parent", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const a = mountSolid(() => <span>a</span>, parent);
    const b = mountSolid(() => <span>b</span>, parent);

    expect(parent.querySelectorAll("[data-solid-root]")).toHaveLength(2);

    a.destroy();
    expect(parent.querySelectorAll("[data-solid-root]")).toHaveLength(1);

    b.destroy();
    expect(parent.querySelectorAll("[data-solid-root]")).toHaveLength(0);

    parent.remove();
  });

  it("exposes the host element via handle.el", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const handle = mountSolid(() => <span>el-check</span>, parent);

    expect(handle.el).toBeInstanceOf(HTMLElement);
    expect(handle.el).toBe(parent.firstElementChild);

    handle.destroy();
    parent.remove();
  });
});
