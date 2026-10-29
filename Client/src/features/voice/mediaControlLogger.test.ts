import { describe, expect, it, vi } from "vitest";

const loggerTags = vi.hoisted(() => [] as string[]);
vi.mock("../../lib/logger", () => ({
  createLogger: (tag: string) => {
    loggerTags.push(tag);
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

describe("media control logging", () => {
  it("logs under the session's tag, as it did before it was split out", async () => {
    await import("./mediaControl");
    expect(loggerTags).toContain("livekitSession");
    expect(loggerTags).not.toContain("");
  });
});
