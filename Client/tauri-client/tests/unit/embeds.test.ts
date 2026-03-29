import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: fetchMock,
}));

import { renderGenericLinkPreview } from "../../src/components/message-list/embeds";
import { setServerHost } from "../../src/components/message-list/attachments";

function mockHtmlResponse(html: string) {
  return {
    ok: true,
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null;
      },
    },
    text: vi.fn().mockResolvedValue(html),
  };
}

describe("renderGenericLinkPreview", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    fetchMock.mockReset();
    setServerHost("example.com");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fetches OG metadata for public domains that begin with fd", async () => {
    fetchMock.mockResolvedValue(mockHtmlResponse("<html><head><title>F-Droid</title></head></html>"));

    const card = renderGenericLinkPreview("https://fdroid.org/packages");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://fdroid.org/packages",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": expect.stringContaining("facebookexternalhit"),
          }),
        }),
      );
    });

    await vi.waitFor(() => {
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("F-Droid");
    });
  });

  it("blocks previews for private IPv6 literals", async () => {
    for (const url of ["https://[fd00::1]/", "https://[fe80::1]/", "https://[::ffff:127.0.0.1]/"]) {
      document.body.innerHTML = "";
      const card = renderGenericLinkPreview(url);
      document.body.appendChild(card);
      await Promise.resolve();
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBeTruthy();
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks previews for loopback IPv4 literals beyond 127.0.0.1", async () => {
    const card = renderGenericLinkPreview("https://127.0.0.2/internal");
    document.body.appendChild(card);

    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("127.0.0.2");
  });

  it("blocks previews for multicast, reserved, and documentation addresses", async () => {
    const blockedUrls = [
      "https://224.0.0.1/",
      "https://239.255.255.250/",
      "https://240.0.0.1/",
      "https://255.255.255.255/",
      "https://192.0.2.1/",
      "https://198.51.100.10/",
      "https://203.0.113.7/",
      "https://[ff02::1]/",
      "https://[2001:db8::1]/",
    ];

    for (const url of blockedUrls) {
      document.body.innerHTML = "";
      const card = renderGenericLinkPreview(url);
      document.body.appendChild(card);
      await Promise.resolve();
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBeTruthy();
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows previews for the configured OwnCord server even on private hosts", async () => {
    setServerHost("LOCALHOST:8080");
    fetchMock.mockResolvedValue(mockHtmlResponse("<html><head><title>OwnCord Local</title></head></html>"));

    const card = renderGenericLinkPreview("https://localhost:8080/docs");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://localhost:8080/docs",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": expect.stringContaining("facebookexternalhit"),
          }),
        }),
      );
    });

    await vi.waitFor(() => {
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("OwnCord Local");
    });
  });
});