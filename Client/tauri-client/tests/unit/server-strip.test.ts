import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServerStrip } from "@components/ServerStrip";

describe("ServerStrip", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createServerStrip>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    comp?.destroy?.();
    container.remove();
  });

  it("mounts with server-strip class", () => {
    comp = createServerStrip();
    comp.mount(container);

    expect(container.querySelector(".server-strip")).not.toBeNull();
  });

  it('renders home icon with "O"', () => {
    comp = createServerStrip();
    comp.mount(container);

    const icons = container.querySelectorAll(".server-icon");
    const homeIcon = icons[0];
    expect(homeIcon).not.toBeUndefined();
    expect(homeIcon?.textContent).toBe("O");
  });

  it("renders separator", () => {
    comp = createServerStrip();
    comp.mount(container);

    expect(container.querySelector(".server-separator")).not.toBeNull();
  });

  it('renders add icon with "+"', () => {
    comp = createServerStrip();
    comp.mount(container);

    const addIcon = container.querySelector(".server-icon.add");
    expect(addIcon).not.toBeNull();
    expect(addIcon?.textContent).toBe("+");
  });

  it("home icon has active class", () => {
    comp = createServerStrip();
    comp.mount(container);

    const icons = container.querySelectorAll(".server-icon");
    const homeIcon = icons[0];
    expect(homeIcon?.classList.contains("active")).toBe(true);
  });

  it("destroy removes DOM", () => {
    comp = createServerStrip();
    comp.mount(container);

    expect(container.querySelector(".server-strip")).not.toBeNull();

    comp.destroy?.();
    expect(container.querySelector(".server-strip")).toBeNull();
  });
});
