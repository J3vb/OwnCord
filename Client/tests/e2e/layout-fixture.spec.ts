import { test, expect } from "./fixtures";
import { startFullSession } from "./helpers";

/**
 * The fixture seed: a plain boot runs the layout the project's `screenLayout`
 * option names, a spec's own earlier script wins, and every page of a context
 * agrees. Runs in the parity job (Classic) and the Deck job (Command Deck).
 */
test.describe("layout fixture", () => {
  test("a plain boot runs the layout the project sets", async ({ page, screenLayout }) => {
    await startFullSession(page);
    const html = page.locator("html");
    if (screenLayout === "deck") await expect(html).toHaveClass(/layout-deck/);
    else await expect(html).not.toHaveClass(/layout-deck/);
  });

  test("a spec's own earlier script wins over the seed", async ({ page, screenLayout }) => {
    const other = screenLayout === "deck" ? "classic" : "deck";
    await page.addInitScript((value) => {
      localStorage.setItem("owncord:settings:screenLayout", JSON.stringify(value));
    }, other);
    await startFullSession(page);
    const html = page.locator("html");
    if (other === "deck") await expect(html).toHaveClass(/layout-deck/);
    else await expect(html).not.toHaveClass(/layout-deck/);
  });

  test("a second page of the context runs the same layout", async ({ page, context }) => {
    await startFullSession(page);
    const first = await page.evaluate(() => localStorage.getItem("owncord:settings:screenLayout"));
    const second = await context.newPage();
    await second.goto("/");
    await expect
      .poll(() => second.evaluate(() => localStorage.getItem("owncord:settings:screenLayout")))
      .toBe(first);
    const deck = await page.evaluate(() =>
      document.documentElement.classList.contains("layout-deck"),
    );
    await expect
      .poll(() => second.evaluate(() => document.documentElement.classList.contains("layout-deck")))
      .toBe(deck);
  });
});
