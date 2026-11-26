import { test as base, expect } from "@playwright/test";
import { seedScreenLayout, type ScreenLayoutOption } from "./support/screenLayoutSeed";

/**
 * Every page starts on the layout the project's `screenLayout` option names
 * (Classic unless a config or spec says otherwise), so an empty profile is not
 * read as a new install. The seed is skipped when the page stores a layout.
 */
export const layoutTest = base.extend<{ screenLayout: ScreenLayoutOption }>({
  screenLayout: ["classic", { option: true }],
  context: async ({ context, screenLayout }, use) => {
    await seedScreenLayout(context, screenLayout);
    await use(context);
  },
});

/** Unexpected mock failures must fail even when application code catches them. */
export const test = layoutTest.extend<{ runtimeErrors: void }>({
  runtimeErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" && message.text().startsWith("[tauri-mock]")) {
          errors.push(message.text());
        }
      });
      await use();
      if (errors.length) {
        await testInfo.attach("runtime-errors", {
          body: errors.join("\n"),
          contentType: "text/plain",
        });
      }
      expect(errors, "Unexpected browser or mock errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
