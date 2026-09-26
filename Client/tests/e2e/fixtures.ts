import { test as base, expect } from "@playwright/test";

/** Unexpected mock failures must fail even when application code catches them. */
export const test = base.extend<{ runtimeErrors: void }>({
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
