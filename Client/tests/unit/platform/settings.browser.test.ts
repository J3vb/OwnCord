// Browser binding for the SettingsStore suite (6.13c): the browser platform's
// settings over `localStorage`. "The native store" is the storage area: it
// holds a value, throws, or is missing. The same suite runs against the
// desktop store in `settings.desktop.test.ts`.
import { afterAll, describe, expect, it, vi } from "vitest";
import type { SettingsStore } from "../../../src/platform/contracts/settings";
import { settings } from "../../../src/platform/browser/settings";
import { FakeWebStorage } from "../../helpers/fakeWebStorage";
import { describeSettingsStoreSuite } from "./settings.suite";

const browserBinding: SettingsStore = settings;
let area = new FakeWebStorage();

function install(): void {
  area = new FakeWebStorage();
  vi.stubGlobal("localStorage", area);
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describeSettingsStoreSuite(async () => {
  install();
  return {
    subject: browserBinding,
    native: {
      succeedWith(value: unknown) {
        // The native store's answer is a key → value map; Web Storage holds
        // each value as JSON under the same key.
        if (value !== null && typeof value === "object") {
          for (const [key, entry] of Object.entries(value)) {
            area.setItem(key, JSON.stringify(entry));
          }
        }
      },
      failWith(error: unknown) {
        area.failure = error;
      },
      unavailable() {
        vi.stubGlobal("localStorage", undefined);
      },
    },
  };
});

describe("browser settings", () => {
  const snapshot = { schemaVersion: 1, profiles: [] };

  it("reads back what it saved", async () => {
    install();
    await browserBinding.save(snapshot);
    await expect(browserBinding.load()).resolves.toEqual(snapshot);
  });

  it("resolves null for a stored value that is not JSON", async () => {
    install();
    area.setItem("owncord:profiles", "{not json");
    await expect(browserBinding.load()).resolves.toBeNull();
  });

  it("rejects when reaching the storage area throws", async () => {
    install();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked");
      },
    });
    await expect(browserBinding.load()).rejects.toThrow();
    await expect(browserBinding.save(snapshot)).rejects.toThrow();
  });
});
