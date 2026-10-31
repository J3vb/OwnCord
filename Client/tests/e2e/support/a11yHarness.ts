/**
 * Scaffolding the accessibility specs share: a signed-in boot under chosen
 * appearance preferences, the four-theme by High Contrast contrast matrix,
 * and the pointer-target, reduced-motion and 940x500 reflow checks.
 */
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  ROUTE_HEALTH,
  ROUTE_LOGIN,
  buildTauriMockScript,
  navigateToMainPageReady,
} from "../helpers";
import { type AppearancePrefs, contrastMeter, setAppearance } from "./accessibility";

export const THEMES = ["dark", "neon-glow", "midnight", "light"] as const;

/** Every theme, High Contrast and a custom accent. */
export const APPEARANCE_MATRIX: AppearancePrefs[] = [
  { theme: "dark" },
  { theme: "midnight" },
  { theme: "neon-glow" },
  { theme: "light" },
  { theme: "dark", highContrast: true },
  { theme: "light", accent: "#fee75c" }, // below 3:1 on light: falls back (Q8)
];

type MockRoutes = Parameters<typeof buildTauriMockScript>[0]["httpRoutes"];

/** Health and login are added to `routes`; `prefs` apply before the sign-in. */
export async function bootSignedIn(
  page: Page,
  routes: MockRoutes,
  prefs?: AppearancePrefs,
): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [ROUTE_HEALTH, ROUTE_LOGIN, ...routes],
      simulateWsFlow: true,
    }),
  );
  await page.goto("/");
  if (prefs !== undefined) await setAppearance(page, prefs);
  await navigateToMainPageReady(page);
}

/** One case per theme and High Contrast setting, for the spec to register with its own `test`. */
export function contrastMatrix(options: {
  title: string;
  attachName: (theme: string, highContrast: boolean) => string;
  boot: (page: Page, prefs: AppearancePrefs) => Promise<void>;
  scenario: (page: Page, meter: ReturnType<typeof contrastMeter>) => Promise<void>;
}): Array<{
  title: string;
  run: (fixtures: { page: Page }, testInfo: TestInfo) => Promise<void>;
}> {
  const cases = [];
  for (const theme of THEMES) {
    for (const highContrast of [false, true]) {
      cases.push({
        title: `${theme}${highContrast ? " + High Contrast" : ""}: ${options.title}`,
        run: async ({ page }: { page: Page }, testInfo: TestInfo): Promise<void> => {
          await options.boot(page, { theme, highContrast, accent: null });
          const meter = contrastMeter(page);
          await options.scenario(page, meter);
          await testInfo.attach(options.attachName(theme, highContrast), {
            body: JSON.stringify(meter.measured, null, 2),
            contentType: "application/json",
          });
          expect(meter.failures).toEqual([]);
        },
      });
    }
  }
  return cases;
}

/** Targets under 24x24 CSS px (WCAG 2.5.8), described by `label`. */
export async function undersizedTargets(
  targets: Locator,
  options: {
    skipHidden?: boolean;
    label?: (target: Locator) => Promise<string | null>;
  } = {},
): Promise<string[]> {
  const small: string[] = [];
  for (const target of await targets.all()) {
    if (options.skipHidden === true && !(await target.isVisible())) continue;
    const box = await target.boundingBox();
    if (box === null || box.width < 24 || box.height < 24) {
      const label = await (options.label ?? ((t) => t.textContent()))(target);
      small.push(`${label}: ${box?.width}x${box?.height}`);
    }
  }
  return small;
}

/** Nothing in `elements` animates or transitions. */
export async function expectNoMotion(elements: Locator[]): Promise<void> {
  for (const el of elements) {
    await expect(el).toHaveCSS("animation-name", "none");
    await expect(el).toHaveCSS("transition-duration", "0s");
  }
}

export async function horizontalOverflow(el: Locator): Promise<number> {
  return el.evaluate((n) => n.scrollWidth - n.clientWidth);
}

/** Every matching element can be scrolled to and ends up in the viewport. */
export async function expectReachable(
  targets: Locator,
  options: { skipHidden?: boolean } = {},
): Promise<void> {
  for (const el of await targets.all()) {
    if (options.skipHidden === true && !(await el.isVisible())) continue;
    await el.scrollIntoViewIfNeeded();
    await expect(el).toBeInViewport();
  }
}

export async function attachScreenshot(
  testInfo: TestInfo,
  name: string,
  page: Page,
): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

/** Open the Moderation Center and the report at `index`, from the keyboard. */
export async function openModerationReport(
  page: Page,
  statusText: string,
  index = 0,
): Promise<Locator> {
  await page.getByTestId("moderation-btn").focus();
  await page.keyboard.press("Enter");
  const center = page.getByRole("region", { name: "Moderation" });
  await expect(center.getByTestId("mod-status")).toHaveText(statusText);
  await center.getByTestId("mod-queue-row").nth(index).focus();
  await page.keyboard.press("Enter");
  await expect(center.getByTestId("mod-report").getByRole("heading", { level: 3 })).toBeFocused();
  return center;
}

/** Animations still moving inside `root` (a reduced-motion 0.01 ms one is not). */
export function runningMotion(root: Locator): Promise<number> {
  return root.evaluate(
    (el) =>
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.playState === "running" && Number(a.effect?.getTiming().duration) > 1)
        .length,
  );
}

/** Nothing pushes the page wider than the window. */
export async function expectNoPageScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
}

/** The control is in view, its text fits, and (when `minHeight` is given) it is tall enough. */
export async function expectControlFits(control: Locator, minHeight?: number): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
  expect(await control.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  if (minHeight !== undefined) {
    expect(await control.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(
      minHeight,
    );
  }
}
