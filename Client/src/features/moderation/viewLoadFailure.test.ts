// The moderation destination when its queue chunk cannot load. This file never
// loads the queue successfully.
import { describe, expect, it, vi } from "vitest";

vi.mock("./Queue", () => {
  throw new Error("chunk unavailable");
});

import type { ApiClient } from "@lib/api";
import { buildModerationCenter } from "./view";

const api = {} as ApiClient;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("moderation destination chunk failure", () => {
  it("builds an empty, named root and goes back once rather than stay open", async () => {
    const close = vi.fn();
    const root = buildModerationCenter({ signal: new AbortController().signal, close, api });
    expect(root.className).toBe("mod-center");
    expect(root.dataset["testid"]).toBe("mod-center");
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(root.childElementCount).toBe(0);
  });

  it("does not go back when the view was closed before the failure", async () => {
    const close = vi.fn();
    const ac = new AbortController();
    buildModerationCenter({ signal: ac.signal, close, api });
    ac.abort();
    await flush();
    expect(close).not.toHaveBeenCalled();
  });
});
