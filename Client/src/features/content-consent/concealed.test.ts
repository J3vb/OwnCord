// The concealed stand-in: names the host, loads nothing until its button is used.
import { describe, expect, it, vi } from "vitest";

import { renderConcealedItem } from "./concealed";

describe("concealed external item", () => {
  it("is one plain button inside an embed wrapper that names the host", () => {
    const wrap = renderConcealedItem("https://cdn.example.org/a/b.png?x=1", vi.fn());
    expect(wrap.className).toBe("msg-embed msg-embed-concealed");
    const buttons = wrap.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    const button = buttons[0]!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toBe("btn-ghost");
    expect(button.textContent).toContain("cdn.example.org");
    expect(button.textContent).not.toContain("/a/b.png");
  });

  it("falls back to the raw text when the address does not parse", () => {
    const wrap = renderConcealedItem("not a url", vi.fn());
    expect(wrap.querySelector("button")!.textContent).toContain("not a url");
  });

  it("calls back only when the button is activated", () => {
    const onActivate = vi.fn();
    const wrap = renderConcealedItem("https://cdn.example.org/a.png", onActivate);
    expect(onActivate).not.toHaveBeenCalled();
    wrap.querySelector("button")!.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
