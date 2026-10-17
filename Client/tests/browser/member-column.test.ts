import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../src/styles/app.css";

// jsdom lays nothing out, so the 900px breakpoint of the member column's
// overlay can only be checked in a real browser (3C-6c).
function mountColumn(): HTMLElement {
  const app = document.createElement("div");
  app.className = "app-layout";
  const chat = document.createElement("main");
  chat.style.flex = "1";
  const column = document.createElement("aside");
  column.id = "member-column";
  column.className = "member-column";
  const handle = document.createElement("div");
  handle.className = "member-column-resize";
  column.appendChild(handle);
  app.append(chat, column);
  document.body.appendChild(app);
  return column;
}

describe("member column overlay breakpoint (real layout)", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("a 900px-wide viewport keeps the column in flow; 899px makes it fixed", async () => {
    const column = mountColumn();
    const handle = column.querySelector<HTMLElement>(".member-column-resize")!;

    await page.viewport(900, 600);
    expect(window.innerWidth).toBe(900);
    expect(getComputedStyle(column).position).toBe("relative");
    expect(getComputedStyle(handle).display).not.toBe("none");

    await page.viewport(899, 600);
    expect(window.innerWidth).toBe(899);
    const style = getComputedStyle(column);
    expect(style.position).toBe("fixed");
    expect(getComputedStyle(handle).display).toBe("none");
    const box = column.getBoundingClientRect();
    expect(box.right).toBe(899);
    expect(box.width).toBeLessThanOrEqual(280);
    expect(box.top).toBe(0);
    expect(box.height).toBe(600);
  });
});
