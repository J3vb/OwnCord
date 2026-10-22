// Browser binding for the ExternalContentBroker suite (6.13d): the browser has
// no broker, so every request is refused as `unavailable` without touching the
// network. The suite runs with `broker: false` (only its refusal cases); the
// tests below pin that nothing is fetched.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalImageHandle } from "../../../src/platform/contracts/externalContent";
import { externalContent } from "../../../src/platform/browser/externalContent";
import { describeExternalContentSuite } from "./externalContent.suite";

afterEach(() => {
  vi.unstubAllGlobals();
});

describeExternalContentSuite(
  async () => ({
    subject: externalContent,
    native: {
      answers: () => undefined,
      refuses: () => undefined,
      unavailable: () => undefined,
      asked: () => [],
    },
  }),
  { broker: false },
);

describe("browser external content", () => {
  it("refuses a preview and every kind of image with no request at all", async () => {
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", fetchSpy);
    vi.stubGlobal("WebSocket", fetchSpy);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    const refused = { ok: false, failure: "unavailable" };
    await expect(externalContent.preview("p#0", "https://news.example.com/")).resolves.toEqual(
      refused,
    );
    await expect(
      externalContent.image("p#0", { url: "https://img.example.com/a.png" }),
    ).resolves.toEqual(refused);
    await expect(
      externalContent.image("p#0", { handle: "h1" as ExternalImageHandle }),
    ).resolves.toEqual(refused);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });
});
