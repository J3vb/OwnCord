// The requests destination when its view chunk cannot load. This file never
// loads the view successfully.
import { describe, expect, it, vi } from "vitest";

vi.mock("./Inbox", () => {
  throw new Error("chunk unavailable");
});

import { buildInbox } from "./view";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("requests destination chunk failure", () => {
  it("goes back once rather than leave an empty view open", async () => {
    const close = vi.fn();
    const root = buildInbox({ signal: new AbortController().signal, close });
    expect(root.className).toBe("requests-inbox");
    expect(root.dataset["testid"]).toBe("requests-inbox");
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(root.childElementCount).toBe(0);
  });

  it("does not go back when the view was closed before the failure", async () => {
    const close = vi.fn();
    const ac = new AbortController();
    buildInbox({ signal: ac.signal, close });
    ac.abort();
    await flush();
    expect(close).not.toHaveBeenCalled();
  });
});
