import { describe, it, expect, afterEach } from "vitest";
import { createTestHarness, type TestHarness, type Mountable } from "../helpers/test-harness";

describe("createTestHarness", () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  it("appends container to document.body on creation", () => {
    harness = createTestHarness();
    expect(document.body.contains(harness.container)).toBe(true);
  });

  it("mount() calls the component's mount method with the container", () => {
    harness = createTestHarness();
    let mountedOn: HTMLElement | null = null;

    const fakeComponent: Mountable = {
      mount(el: HTMLElement) {
        mountedOn = el;
        el.innerHTML = '<span class="test-child">hello</span>';
      },
    };

    harness.mount(fakeComponent);
    expect(mountedOn).toBe(harness.container);
    expect(harness.container.innerHTML).toContain("test-child");
  });

  it("query() finds elements within the container", () => {
    harness = createTestHarness();
    harness.container.innerHTML = '<div class="target">found</div>';

    const el = harness.query(".target");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("found");
  });

  it("queryAll() returns all matching elements within the container", () => {
    harness = createTestHarness();
    harness.container.innerHTML =
      '<span class="item">a</span><span class="item">b</span>';

    const els = harness.queryAll(".item");
    expect(els.length).toBe(2);
  });

  it("click() dispatches a click on the matched element", () => {
    harness = createTestHarness();
    let clicked = false;

    const btn = document.createElement("button");
    btn.className = "click-me";
    btn.addEventListener("click", () => { clicked = true; });
    harness.container.appendChild(btn);

    harness.click(".click-me");
    expect(clicked).toBe(true);
  });

  it("click() throws when no element matches the selector", () => {
    harness = createTestHarness();

    expect(() => harness.click(".nonexistent")).toThrow(
      'click(".nonexistent"): no element found in container',
    );
  });

  it("cleanup() removes the container from document.body", () => {
    harness = createTestHarness();
    const container = harness.container;

    expect(document.body.contains(container)).toBe(true);
    harness.cleanup();
    expect(document.body.contains(container)).toBe(false);
  });

  it("cleanup() is safe to call multiple times", () => {
    harness = createTestHarness();
    harness.cleanup();
    // Should not throw
    harness.cleanup();
  });
});
