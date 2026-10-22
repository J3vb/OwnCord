// Browser binding for the DeepLinks suite (6.13d): the only link the browser
// receives is `?invite=<code>` on the page's own URL, read once at init. The
// suite runs with `messageLinks: false`: a browser has no owncord:// handler
// and no message permalinks. The tests below pin the URL handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepLinks } from "../../../src/platform/contracts/deepLinks";
import { describeDeepLinksSuite } from "./deepLinks.suite";

async function load(): Promise<DeepLinks> {
  vi.resetModules();
  return (await import("../../../src/platform/browser/deepLinks")).deepLinks;
}

function visit(url: string): void {
  window.history.replaceState(null, "", url);
}

function here(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

beforeEach(() => visit("/"));
afterEach(() => visit("/"));

describeDeepLinksSuite(
  async () => ({
    subject: await load(),
    native: {
      coldStartLinks(urls: readonly string[]) {
        // The page was opened on the web form of each invite link.
        for (const url of urls) {
          const match = /^owncord:\/\/invite\/([^/?]+)/.exec(url);
          if (match !== null) visit(`/?invite=${match[1]}`);
        }
      },
    },
  }),
  { messageLinks: false },
);

describe("browser deep links", () => {
  it("hands the code to onInvite once and takes it out of the address bar", async () => {
    const links = await load();
    visit("/?invite=abc123");
    const onInvite = vi.fn();
    await links.init(onInvite);
    await links.init(onInvite);
    expect(onInvite).toHaveBeenCalledExactlyOnceWith("abc123", undefined);
    expect(here()).toBe("/");
  });

  it("keeps the other parameters and the hash", async () => {
    const links = await load();
    visit("/app?x=1&invite=abc123&y=2#room");
    await links.init(vi.fn());
    expect(here()).toBe("/app?x=1&y=2#room");
  });

  it("does nothing on a page with no invite", async () => {
    const links = await load();
    visit("/app?x=1#room");
    const onInvite = vi.fn();
    const onMessage = vi.fn();
    await links.init(onInvite, onMessage);
    expect(onInvite).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(here()).toBe("/app?x=1#room");
  });

  it("removes an empty invite without calling back", async () => {
    const links = await load();
    visit("/?invite=%20&z=1");
    const onInvite = vi.fn();
    await links.init(onInvite);
    expect(onInvite).not.toHaveBeenCalled();
    expect(here()).toBe("/?z=1");
  });

  it("still hands over the code when the address bar cannot be rewritten", async () => {
    const links = await load();
    visit("/?invite=abc123");
    const replace = vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const onInvite = vi.fn();
    await expect(links.init(onInvite)).resolves.toBeUndefined();
    expect(onInvite).toHaveBeenCalledExactlyOnceWith("abc123", undefined);
    replace.mockRestore();
  });
});
