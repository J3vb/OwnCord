import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
// Same stylesheet order as main.ts: tokens, the border-box reset, then app.
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/app.css";
import { DECK_FOLD_QUERY } from "../../src/features/members/memberColumn";

// jsdom lays nothing out, so Command Deck's 1200px fold of the member column
// can only be checked in a real browser, as Classic's 900px one is in
// member-column.test.ts.
function mountColumn(): HTMLElement {
  const app = document.createElement("div");
  app.className = "app app-layout";
  const chat = document.createElement("main");
  chat.style.flex = "1";
  const column = document.createElement("aside");
  column.id = "member-column";
  column.className = "member-column";
  // The controller's inline width, which the fold must beat.
  column.style.width = "320px";
  const handle = document.createElement("div");
  handle.className = "member-column-resize";
  const body = document.createElement("div");
  body.className = "member-column-body";
  body.textContent = "Buddies";
  column.append(handle, body);
  app.append(chat, column);
  document.body.appendChild(app);
  return column;
}

describe("Command Deck fold (real layout)", () => {
  afterEach(() => {
    document.documentElement.classList.remove("layout-deck");
    document.body.replaceChildren();
  });

  it("under Deck 1201px keeps the column in flow; 1200px makes it a fixed 280px overlay", async () => {
    document.documentElement.classList.add("layout-deck");
    const column = mountColumn();
    const handle = column.querySelector<HTMLElement>(".member-column-resize")!;

    await page.viewport(1201, 800);
    expect(window.innerWidth).toBe(1201);
    expect(getComputedStyle(column).position).not.toBe("fixed");
    expect(getComputedStyle(handle).display).not.toBe("none");
    expect(column.getBoundingClientRect().width).toBe(320);

    await page.viewport(1200, 800);
    expect(window.innerWidth).toBe(1200);
    expect(getComputedStyle(column).position).toBe("fixed");
    expect(getComputedStyle(handle).display).toBe("none");
    const box = column.getBoundingClientRect();
    expect(box.width).toBe(280);
    expect(box.right).toBe(1200);
    // From 900 to 1200px the Deck overlay has no shadow; its frame border separates it.
    expect(getComputedStyle(column).boxShadow).toBe("none");
  });

  it("under Deck at 600px wide or less the overlay stays 280px, not the full width", async () => {
    document.documentElement.classList.add("layout-deck");
    const column = mountColumn();
    await page.viewport(600, 500);
    expect(getComputedStyle(column).position).toBe("fixed");
    expect(column.getBoundingClientRect().width).toBe(280);
  });

  it("without layout-deck 1000px keeps the column in flow (Classic unchanged)", async () => {
    const column = mountColumn();
    await page.viewport(1000, 700);
    expect(getComputedStyle(column).position).not.toBe("fixed");
    expect(column.getBoundingClientRect().width).toBe(320);
  });

  it("at each width the fold query agrees with the computed position", async () => {
    document.documentElement.classList.add("layout-deck");
    const column = mountColumn();
    for (const width of [1333, 1201, 1200, 1100, 940, 900, 899, 640]) {
      await page.viewport(width, 700);
      const folded = window.matchMedia(DECK_FOLD_QUERY).matches;
      expect(folded, `${width}px`).toBe(width <= 1200);
      expect(getComputedStyle(column).position === "fixed", `${width}px`).toBe(folded);
    }
  });
});
