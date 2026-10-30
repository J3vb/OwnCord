// Browser binding for the UrlOpener suite: the web build opens a new tab
// instead of asking the native shell, so "the native shell" here is a stubbed
// `window.open`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { urlOpener } from "../../../src/platform/browser/urlOpener";
import { describeUrlOpenerSuite } from "./opener.suite";

interface FakeTab {
  opener: unknown;
}

function stubOpen(impl: (url: string) => FakeTab | null): ReturnType<typeof vi.fn> {
  const open = vi.fn((url: string) => impl(url));
  vi.stubGlobal("open", open);
  return open;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describeUrlOpenerSuite(async () => {
  const opened: string[] = [];
  let failure: Error | null = null;
  stubOpen((url) => {
    if (failure !== null) throw failure;
    opened.push(url);
    return { opener: window };
  });
  return {
    subject: urlOpener,
    native: {
      failWith: (error) => {
        failure = error instanceof Error ? error : new Error("open failed");
      },
      opened: () => opened,
    },
  };
});

describe("browser url opener", () => {
  it("opens the URL in a new tab with no link back to this page", async () => {
    const tab: FakeTab = { opener: window };
    const open = stubOpen(() => tab);
    await urlOpener.open("https://chat.example/admin#audit");
    expect(open).toHaveBeenCalledWith("https://chat.example/admin#audit", "_blank");
    expect(tab.opener).toBeNull();
  });

  it("rejects when the browser blocks the tab", async () => {
    stubOpen(() => null);
    await expect(urlOpener.open("https://chat.example/admin")).rejects.toThrow(/blocked/);
  });

  it("refuses schemes the desktop opener refuses, without opening anything", async () => {
    const open = stubOpen(() => ({ opener: null }));
    await expect(urlOpener.open("javascript:alert(1)")).rejects.toThrow(/scheme/);
    await expect(urlOpener.open("file:///etc/passwd")).rejects.toThrow(/scheme/);
    await expect(urlOpener.open("/admin")).rejects.toThrow(/absolute/);
    expect(open).not.toHaveBeenCalled();
  });

  it("takes mailto and tel like the desktop opener", async () => {
    const open = stubOpen(() => ({ opener: null }));
    await urlOpener.open("mailto:admin@chat.example");
    await urlOpener.open("tel:+3212345678");
    expect(open).toHaveBeenCalledTimes(2);
  });
});
