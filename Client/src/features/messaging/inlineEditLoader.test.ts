import { beforeEach, describe, expect, it, vi } from "vitest";

const editor = vi.hoisted(() => ({ failing: true, factoryRuns: 0 }));
const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
const loggerTags = vi.hoisted(() => [] as string[]);

vi.mock("@lib/logger", () => ({
  createLogger: (tag: string) => {
    loggerTags.push(tag);
    return log;
  },
}));
vi.mock("./inlineEdit", () => {
  editor.factoryRuns += 1;
  if (editor.failing) throw new Error("chunk failed to load");
  return { createInlineEdit: () => "editor" };
});

import { preloadInlineEdit, withInlineEdit } from "./inlineEditLoader";

const loaderTags = [...loggerTags];

beforeEach(() => {
  for (const fn of [log.debug, log.info, log.warn, log.error]) fn.mockClear();
});

describe("inline editor loader", () => {
  it("logs under its own tag", () => {
    expect(loaderTags).toEqual(["inline-edit"]);
  });

  it("a failed load is logged and reported so the caller can drop its setup", async () => {
    const use = vi.fn();
    const onError = vi.fn();
    withInlineEdit(use, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(use).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("Inline editor failed to open", {
      error: expect.stringContaining("Error"),
    });
  });

  it("a failed load without an error handler is still logged", async () => {
    withInlineEdit(vi.fn());
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
  });

  it("a failed preload is logged under its own message", async () => {
    preloadInlineEdit();
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith("Inline editor preload failed", {
        error: expect.stringContaining("Error"),
      }),
    );
  });

  it("the next edit loads again after a failure, and later edits share that load", async () => {
    editor.failing = false;
    const first = vi.fn();
    withInlineEdit(first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(Object.keys(first.mock.calls[0]?.[0] ?? {})).toEqual(["createInlineEdit"]);
    const runsAfterFirst = editor.factoryRuns;

    const second = vi.fn();
    const onError = vi.fn();
    withInlineEdit(second, onError);
    preloadInlineEdit();
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(editor.factoryRuns).toBe(runsAfterFirst);
    expect(onError).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
