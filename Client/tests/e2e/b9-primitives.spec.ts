import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  mockTauriConnect,
  mockTauriFullSessionWithMessages,
  navigateToMainPageReady,
} from "./helpers";
import {
  Q1,
  findUnnamedControls,
  focusIndicator,
  mountSharedControls,
  setAppearance,
  textContrast,
  tokenContrasts,
  tokenHex,
  type AppearancePrefs,
} from "./support/b9-accessibility";
import { contrastRatio, parseColor } from "../../src/lib/color-contrast";

// ---------------------------------------------------------------------------
// B9-2: shared accessibility primitives and tokens against the owner's Q1
// thresholds and Q8 accent policy (docs/architecture/b9-ui-contract.md).
//
// Every measurement reads the running app after its real startup path
// applied the stored theme, accent and accessibility preferences, so this
// runs unchanged against the dev server and the production bundle. The
// matrix and screenshots are attached to the report as evidence.
// ---------------------------------------------------------------------------

const THEMES = ["dark", "neon-glow", "midnight", "light"] as const;
type Theme = (typeof THEMES)[number];

/** AppearanceTab's ten preset swatches. */
const PRESETS = [
  "#00c8ff",
  "#57f287",
  "#fee75c",
  "#eb459e",
  "#ed4245",
  "#f47b67",
  "#e78b38",
  "#3ba55d",
  "#5865f2",
  "#b9bbbe",
] as const;
/** Custom accents that read below 3:1 somewhere: the Q8 fallback cases. */
const CUSTOM = ["#2b2d31", "#ffff00"] as const;

const SURFACES = ["--bg-primary", "--bg-secondary", "--bg-tertiary", "--bg-input"] as const;
const TEXT_TOKENS = [
  "--text-normal",
  "--text-muted",
  "--header-primary",
  "--header-secondary",
  "--text-link",
  "--accent-text",
  "--text-positive",
  "--text-warning",
  "--text-danger",
] as const;
/** Measured and recorded, but not qualified: decorative or incidental text only. */
const UNQUALIFIED_TEXT = ["--text-faint", "--text-micro"] as const;
const ACCENT_FILLS = ["--accent", "--accent-hover", "--accent-active"] as const;

/** Each theme's tested accent text and focus colours: the Q8 fallback targets. */
const THEME_ACCENT_TEXT: Record<Theme, string> = {
  dark: "#a3aaf8",
  "neon-glow": "#2fd0ff",
  midnight: "#a3aaf8",
  light: "#4150c4",
};
const THEME_FOCUS_RING: Record<Theme, string> = { ...THEME_ACCENT_TEXT, light: "#4752c4" };
/** The surfaces a control sits on: its edge must reach 3:1 on each (B9 Q13, 1.4.11). */
const CONTROL_SURFACES = ["--bg-primary", "--bg-secondary"] as const;

async function openApp(page: Page): Promise<void> {
  await mockTauriConnect(page);
  await page.goto("/");
  await expect(page.locator("#host")).toBeVisible();
}

async function apply(page: Page, prefs: AppearancePrefs): Promise<void> {
  await setAppearance(page, prefs);
  await expect(page.locator("#host")).toBeVisible();
}

test.describe("B9-2 token matrix (Q1 thresholds, Q8 accent policy)", () => {
  for (const theme of THEMES) {
    test(`${theme}: qualified tokens pass in every accent and High Contrast state`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(180_000);
      await openApp(page);
      const failures: string[] = [];
      const rows: unknown[] = [];

      for (const highContrast of [false, true]) {
        for (const accent of [null, ...PRESETS, ...CUSTOM]) {
          await apply(page, { theme, accent, highContrast });
          const label = `${theme} hc=${highContrast} accent=${accent ?? "theme"}`;

          const textPairs = TEXT_TOKENS.flatMap((t) => SURFACES.map((s) => [t, s] as const));
          const focusPairs = SURFACES.map((s) => ["--focus-ring", s] as const);
          const onAccentPairs = ACCENT_FILLS.map((f) => ["--on-accent", f] as const);
          const controlPairs = CONTROL_SURFACES.map((s) => ["--border-control", s] as const);
          const extraPairs = UNQUALIFIED_TEXT.flatMap((t) => SURFACES.map((s) => [t, s] as const));
          const ratios = await tokenContrasts(page, [
            ...textPairs,
            ...focusPairs,
            ...onAccentPairs,
            ...controlPairs,
            ...extraPairs,
          ]);
          const check = (
            pairs: ReadonlyArray<readonly [string, string]>,
            offset: number,
            min: number,
          ): Record<string, number> => {
            const out: Record<string, number> = {};
            pairs.forEach(([fg, bg], i) => {
              const r = ratios[offset + i]!;
              out[`${fg} on ${bg}`] = Number(r.toFixed(2));
              if (r < min) failures.push(`${label}: ${fg} on ${bg} ${r.toFixed(2)} < ${min}`);
            });
            return out;
          };
          let at = 0;
          const text = check(textPairs, at, Q1.text);
          at += textPairs.length;
          const focus = check(focusPairs, at, Q1.focus);
          at += focusPairs.length;
          const onAccent = check(onAccentPairs, at, Q1.text);
          at += onAccentPairs.length;
          const controlEdge = check(controlPairs, at, Q1.nonText);
          at += controlPairs.length;
          const unqualified = check(extraPairs, at, 0);

          // Q8 as aligned with Q1: the accent is the text colour only at
          // >= 4.5:1 and the focus ring only at >= 3:1 on every surface, and
          // neither under High Contrast.
          const surfaces = await Promise.all(SURFACES.map((s) => tokenHex(page, s)));
          const accentMin =
            accent === null
              ? 0
              : Math.min(
                  ...surfaces.map((s) => contrastRatio(parseColor(accent)!, parseColor(s)!)),
                );
          const honoured = (min: number, fallback: string): string =>
            accent !== null && !highContrast && accentMin >= min ? accent : fallback;
          const expectedText = honoured(Q1.text, THEME_ACCENT_TEXT[theme]);
          const expectedFocus = honoured(Q1.focus, THEME_FOCUS_RING[theme]);
          const accentText = await tokenHex(page, "--accent-text");
          const focusRing = await tokenHex(page, "--focus-ring");
          if (accentText !== expectedText || focusRing !== expectedFocus) {
            failures.push(
              `${label}: --accent-text ${accentText} (expected ${expectedText}), --focus-ring ${focusRing} (expected ${expectedFocus})`,
            );
          }
          rows.push({
            theme,
            highContrast,
            accent: accent ?? "theme default",
            accentMinOnSurfaces: accent === null ? null : Number(accentMin.toFixed(2)),
            accentText,
            focusRing,
            onAccent: await tokenHex(page, "--on-accent"),
            text,
            focus,
            onAccent_fills: onAccent,
            controlEdge,
            unqualified,
          });
        }
      }

      await testInfo.attach(`token-matrix-${theme}.json`, {
        body: JSON.stringify(rows, null, 2),
        contentType: "application/json",
      });
      expect(failures).toEqual([]);
    });
  }
});

test.describe("B9 Q13 role colours as text (role clamp)", () => {
  // Role colours are server-set: MOCK_ROLES paints admins #ff0000 (4.00:1 on
  // white, 2.84:1 on dark) and moderators #00aaff. A role colour is a name's
  // colour only at 4.5:1 on every surface, otherwise the name is --text-normal.
  const NAMES = ".msg-author, .member-item:not(.offline) .mi-name";

  for (const theme of THEMES) {
    test(`${theme}: every role-coloured name reads at 4.5:1, in High Contrast too`, async ({
      page,
    }, testInfo) => {
      await mockTauriFullSessionWithMessages(page);
      await page.goto("/");
      await navigateToMainPageReady(page);
      const measured: Record<string, number> = {};
      const failures: string[] = [];
      for (const highContrast of [false, true]) {
        await setAppearance(page, { theme, highContrast, accent: null });
        await navigateToMainPageReady(page);
        const names = page.locator(NAMES);
        await expect(names.first()).toBeVisible();
        expect(await names.count()).toBeGreaterThan(1);
        for (let i = 0; i < (await names.count()); i++) {
          const name = names.nth(i);
          const label = `hc=${highContrast} ${await name.getAttribute("data-role-color")} ${await name.textContent()}`;
          const { ratio } = await textContrast(name);
          measured[label] = Number(ratio.toFixed(2));
          if (ratio < Q1.text) failures.push(`${label} ${ratio.toFixed(2)} < ${Q1.text}`);
        }
      }

      // Control: the raw server colour is what the clamp stood between.
      const admin = page.locator(".msg-author[data-role-color='#ff0000']").first();
      await admin.evaluate((el: HTMLElement) => (el.style.color = el.dataset["roleColor"]!));
      expect((await textContrast(admin)).ratio).toBeLessThan(Q1.text);

      await testInfo.attach(`role-clamp-${theme}.json`, {
        body: JSON.stringify(measured, null, 2),
        contentType: "application/json",
      });
      expect(failures).toEqual([]);
    });
  }
});

test.describe("B9-2 shared-controls fixture", () => {
  for (const theme of THEMES) {
    for (const highContrast of [false, true]) {
      test(`${theme}${highContrast ? " + High Contrast" : ""}: names, focus rings and text contrast in every state`, async ({
        page,
      }, testInfo) => {
        await openApp(page);
        await apply(page, { theme, highContrast, accent: null });
        const fixture = await mountSharedControls(page);
        const failures: string[] = [];
        const measured: Record<string, number> = {};
        const measure = async (
          name: string,
          ratio: number,
          min: number = Q1.text,
        ): Promise<void> => {
          measured[name] = Number(ratio.toFixed(2));
          if (ratio < min) failures.push(`${name} ${ratio.toFixed(2)} < ${min}`);
        };

        expect(await findUnnamedControls(fixture)).toEqual([]);

        // Pointer targets (2.5.8): 24x24 CSS px; an inline text link is exempt.
        // Layout size, not getBoundingClientRect: a dialog's open animation
        // scales its contents while it runs.
        const small = await fixture
          .locator("button, input, .toggle")
          .evaluateAll((els) =>
            (els as HTMLElement[])
              .filter((el) => el.offsetWidth < 24 || el.offsetHeight < 24)
              .map((el) => `${el.className || el.tagName} ${el.offsetWidth}x${el.offsetHeight}`),
          );
        expect(small).toEqual([]);

        // Normal state.
        for (const [name, selector] of [
          ["heading", "#b9-fx-title"],
          ["body text", ".modal-danger-text"],
          ["emphasis", ".modal-danger-text strong"],
          ["field label", ".form-label"],
          ["setting label", ".setting-label"],
          ["setting description", ".setting-desc"],
          ["link", "a[href]"],
          ["cancel button", ".btn-modal-cancel"],
          ["danger button", ".btn-danger"],
          ["primary button", ".btn-modal-save"],
        ] as const) {
          await measure(name, (await textContrast(fixture.locator(selector))).ratio);
        }
        await measure(
          "placeholder",
          (await textContrast(fixture.locator("#b9-fx-name"), "::placeholder")).ratio,
        );
        // The switch track is a UI component: 3:1 against its surface, off and on.
        for (const state of ["off", "on"] as const) {
          const bg = await fixture.locator(".toggle").evaluate((el) => {
            const parent = getComputedStyle(el.closest(".modal")!).backgroundColor;
            return [getComputedStyle(el).backgroundColor, parent];
          });
          await measure(
            `switch track ${state}`,
            contrastRatio(parseColor(bg[0]!)!, parseColor(bg[1]!)!),
            Q1.nonText,
          );
          if (state === "off") await fixture.locator(".toggle").click();
        }

        // Focus: every control, reached with Tab from the dialog container.
        await fixture.locator(".modal").focus();
        for (let i = 0; i < 7; i++) {
          await page.keyboard.press("Tab");
          const ring = await focusIndicator(page);
          measured[`focus ${ring.element}`] = Number(ring.ratio.toFixed(2));
          for (const p of ring.problems) failures.push(`focus ${ring.element}: ${p}`);
        }

        // Hover, then the error and success states.
        await fixture.locator(".btn-modal-save").hover();
        await measure(
          "primary button (hover)",
          (await textContrast(fixture.locator(".btn-modal-save"))).ratio,
        );
        await fixture.locator("#b9-fx-name").fill("");
        await fixture.locator(".btn-modal-save").click();
        await expect(fixture.locator("#b9-fx-error")).toHaveText("Enter a channel name.");
        await measure("error message", (await textContrast(fixture.locator("#b9-fx-error"))).ratio);
        await fixture.locator("#b9-fx-name").fill("announcements");
        await measure("field value", (await textContrast(fixture.locator("#b9-fx-name"))).ratio);
        await fixture.locator(".btn-modal-save").click();
        await expect(fixture.locator("#b9-fx-status")).toHaveText("Channel renamed.");
        await measure(
          "success message",
          (await textContrast(fixture.locator("#b9-fx-status"))).ratio,
        );

        await testInfo.attach(`fixture-${theme}${highContrast ? "-hc" : ""}.json`, {
          body: JSON.stringify(measured, null, 2),
          contentType: "application/json",
        });
        await testInfo.attach(`fixture-${theme}${highContrast ? "-hc" : ""}.png`, {
          body: await fixture.locator(".modal").screenshot(),
          contentType: "image/png",
        });
        expect(failures).toEqual([]);
      });
    }
  }
});

test.describe("B9-2 keyboard journey at large text and reduced motion", () => {
  test.use({ viewport: { width: 940, height: 500 } });

  test("pending, error and success are announced and focus stays put, keyboard only", async ({
    page,
  }, testInfo) => {
    await openApp(page);
    await apply(page, { fontSize: 20, largeFont: true });
    const fixture = await mountSharedControls(page);
    const input = fixture.locator("#b9-fx-name");
    const save = fixture.locator(".btn-modal-save");

    // OS reduced motion (the config default) reaches the app with no setting.
    await expect(page.locator("html")).toHaveClass(/reduced-motion/);
    expect(
      await fixture.locator(".modal").evaluate((el) => getComputedStyle(el).animationDuration),
    ).toBe("0s");

    await fixture.locator(".modal").focus();
    await page.keyboard.press("Tab"); // close
    await page.keyboard.press("Tab"); // field
    await expect(input).toBeFocused();

    // Empty submit: pending, then the error, linked and announced; focus stays.
    await page.keyboard.press("Enter");
    await expect(fixture.locator("#b9-fx-status")).toHaveText("Saving…");
    await expect(save).toHaveAttribute("aria-busy", "true");
    await expect(fixture.locator("#b9-fx-error")).toHaveText("Enter a channel name.");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAccessibleDescription(/Enter a channel name\./);
    await expect(input).toBeFocused();
    await expect(fixture.getByRole("alert")).toHaveText("Enter a channel name.");

    // Fix it and submit from the button with the keyboard: success.
    await page.keyboard.type("announcements");
    await page.keyboard.press("Tab"); // switch
    await page.keyboard.press("Space");
    await expect(fixture.getByRole("switch", { name: "Notify members" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Tab"); // link
    await page.keyboard.press("Tab"); // cancel
    await page.keyboard.press("Tab"); // delete
    await page.keyboard.press("Tab"); // save
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(fixture.getByRole("status")).toHaveText("Channel renamed.");
    await expect(input).not.toHaveAttribute("aria-invalid");
    await expect(save).toBeFocused(); // pending did not drop focus to <body>

    // Reflow at the 940x500 minimum window and 20px Large Font.
    const overflow = await fixture.evaluate((el) => {
      const modal = el.querySelector<HTMLElement>(".modal")!;
      const clipped = [...el.querySelectorAll<HTMLElement>("button, input, label, a, .toggle")]
        .filter((c) => c.scrollWidth > c.clientWidth + 1)
        .map((c) => c.outerHTML.slice(0, 60));
      return {
        pageScroll: document.documentElement.scrollWidth - innerWidth,
        modalScroll: modal.scrollWidth - modal.clientWidth,
        clipped,
      };
    });
    expect(overflow).toEqual({ pageScroll: 0, modalScroll: 0, clipped: [] });

    await testInfo.attach("journey-940x500-20px-large-font.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test("a real factory modal contains Tab and restores focus to its opener on Escape", async ({
    page,
  }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPageReady(page);

    const opener = page.locator(".sidebar-dm-section .category-add-btn");
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator(".dm-member-picker-modal");
    await expect(dialog).toHaveAttribute("role", "dialog");

    for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      expect((await focusIndicator(page)).problems).toEqual([]);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect((await focusIndicator(page)).problems).toEqual([]);
  });
});

test.describe("B9-2 reduced motion honours the OS and the app setting", () => {
  const modalAnimation = async (page: Page): Promise<string> => {
    const fixture = await mountSharedControls(page);
    return fixture.locator(".modal").evaluate((el) => getComputedStyle(el).animationDuration);
  };

  test("OS reduce with no app setting reduces motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page);
    await expect(page.locator("html")).toHaveClass(/reduced-motion/);
    expect(await modalAnimation(page)).toBe("0s");
  });

  test("the app setting reduces motion when the OS does not", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openApp(page);
    await apply(page, { reducedMotion: true });
    await expect(page.locator("html")).toHaveClass(/reduced-motion/);
    expect(await modalAnimation(page)).toBe("0s");
  });

  test("control: neither asks, so the modal animates", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openApp(page);
    await expect(page.locator("html")).not.toHaveClass(/reduced-motion/);
    expect(await modalAnimation(page)).toBe("0.3s");
  });

  test("turning Sync with OS off lets the user keep animations", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page);
    await apply(page, { syncOsMotion: false, reducedMotion: false });
    await expect(page.locator("html")).not.toHaveClass(/reduced-motion/);
  });
});

test.describe("B9-2 reflow at the minimum window", () => {
  for (const [label, prefs, scale] of [
    ["12px text", { fontSize: 12, largeFont: false }, 1],
    ["20px text with Large Font", { fontSize: 20, largeFont: true }, 1],
    ["20px text at 200% scale", { fontSize: 20, largeFont: true }, 2],
  ] as const) {
    test.describe(label, () => {
      test.use({ viewport: { width: 940, height: 500 }, deviceScaleFactor: scale });

      test(`every fixture control is reachable and unclipped (${label})`, async ({
        page,
      }, testInfo) => {
        await openApp(page);
        await apply(page, prefs);
        const fixture = await mountSharedControls(page);
        const controls = fixture.locator("button, input, a[href], .toggle");
        for (let i = 0; i < (await controls.count()); i++) {
          const control = controls.nth(i);
          await control.scrollIntoViewIfNeeded();
          await expect(control).toBeInViewport();
          expect(await control.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(
          0,
        );
        await testInfo.attach(`reflow-${label.replaceAll(/\W+/g, "-")}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });
    });
  }
});

test.describe("B9-2 checks fail when the behaviour is removed (controls)", () => {
  test("an unnamed control, a removed focus ring and low-contrast text are all caught", async ({
    page,
  }) => {
    await openApp(page);
    const fixture = await mountSharedControls(page);

    // Unnamed control.
    await page.evaluate(() => {
      const bare = document.createElement("button");
      bare.id = "b9-bare";
      bare.className = "btn-ghost";
      document.querySelector('[data-testid="b9-fixture"] .modal-footer')!.appendChild(bare);
    });
    expect(await findUnnamedControls(fixture)).toEqual(["- button"]);
    await page.locator("#b9-bare").evaluate((el) => el.remove());
    expect(await findUnnamedControls(fixture)).toEqual([]);

    // Removed focus behaviour.
    const breakRing = await page.addStyleTag({
      content: ".btn-modal-save:focus-visible { outline: none !important; }",
    });
    await fixture.locator(".btn-danger").focus();
    await page.keyboard.press("Tab");
    await expect(fixture.locator(".btn-modal-save")).toBeFocused();
    expect((await focusIndicator(page)).problems).toContain("no outline");
    await breakRing.evaluate((el) => (el as Element).remove());
    expect((await focusIndicator(page)).problems).toEqual([]);

    // Low-contrast text.
    const desc = fixture.locator(".setting-desc");
    await desc.evaluate((el) => el.style.setProperty("color", "#5a5c63"));
    expect((await textContrast(desc)).ratio).toBeLessThan(Q1.text);
    await desc.evaluate((el) => el.style.removeProperty("color"));
    expect((await textContrast(desc)).ratio).toBeGreaterThanOrEqual(Q1.text);
  });
});
