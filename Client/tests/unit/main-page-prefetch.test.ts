import { describe, it, expect, vi } from "vitest";

const { importSpy } = vi.hoisted(() => ({ importSpy: vi.fn() }));
vi.mock("@pages/MainPage", () => {
  importSpy();
  return { createMainPage: vi.fn() };
});

import { prefetchMainPage } from "@pages/mainPagePrefetch";

describe("prefetchMainPage", () => {
  it("loads the MainPage module without returning a promise or throwing", async () => {
    expect(prefetchMainPage()).toBeUndefined();
    await vi.waitFor(() => expect(importSpy).toHaveBeenCalled());
  });
});
