import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mediaMocks from "../../../../helpers/dataSaverMediaMocks";
import * as attachmentMocks from "../../../../helpers/attachmentsMocks";

vi.mock("../../../../../src/features/messaging/content/attachmentCache", (original) =>
  mediaMocks.dataSaverCacheMock(original),
);
vi.mock("@lib/icons", () => attachmentMocks.iconsMock());
vi.mock("../../../../../src/features/messaging/content/mediaVisibility", () =>
  attachmentMocks.mediaVisibilityMock(),
);

import {
  renderAttachment,
  setServerHost,
} from "../../../../../src/features/messaging/content/attachments";
import { renderInlineImage } from "../../../../../src/features/messaging/content/media";
import { renderGenericLinkPreview } from "../../../../../src/features/messaging/content/embeds";
import { renderYouTubeEmbed } from "../../../../../src/features/messaging/content/mediaYouTube";
import { savePref } from "../../../../../src/lib/prefs/preferences";
import { desktop } from "../../../../../src/platform/desktop";
import * as emojiStill from "../../../../../src/features/messaging/emojiStill";
import { loadStickerImage } from "../../../../../src/features/messaging/message-list/sticker";
import { Disposable } from "../../../../../src/lib/disposable";

const image = (id: string, mime = "image/png") => ({
  id,
  filename: id + (mime === "image/gif" ? ".gif" : ".png"),
  mime,
  size: 2048,
  url: "/api/v1/files/" + id,
});

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  setServerHost("chat.example");
  savePref("dataSaver", "always");
  mediaMocks.dataSaverImage.mockReset().mockResolvedValue("blob:server-image");
  mediaMocks.dataSaverExternalImage
    .mockReset()
    .mockResolvedValue({ ok: true, value: "blob:external-image" });
  mediaMocks.dataSaverPreview.mockReset().mockResolvedValue({
    ok: true,
    value: {
      title: "Example title",
      description: "A text preview",
      siteName: "Example",
      image: "image-handle",
    },
  });
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("data saver media", () => {
  it("renders a filename and size placeholder without fetching attachments", () => {
    const row = renderAttachment(image("photo"));
    expect(row.querySelector("img")).toBeNull();
    expect(row.textContent).toContain("photo.png");
    expect(row.textContent).toContain("2.0 KB");
    expect(row.textContent).toContain("Tap to load");
    expect(mediaMocks.dataSaverImage).not.toHaveBeenCalled();
  });

  it("loads only the tapped attachment, even when it shares a URL with another row", async () => {
    const first = renderAttachment(image("same"));
    const second = renderAttachment(image("same"));
    document.body.append(first, second);
    const button = first.querySelector("button")!;
    button.click();
    button.click();
    await Promise.resolve();
    expect(mediaMocks.dataSaverImage).toHaveBeenCalledTimes(1);
    expect(first.querySelector("img")).not.toBeNull();
    expect(second.querySelector("img")).toBeNull();
    expect(second.dataset.dataSaver).toBe("waiting");
  });

  it.each(["https://media.example/pick.gif", "https://media.example/photo.png"])(
    "defers an inline URL without even constructing an image: %s",
    (url) => {
      const row = renderInlineImage(url);
      expect(row.querySelector("img")).toBeNull();
      expect(row.querySelector("button")?.textContent).toContain("Tap to load");
      expect(mediaMocks.dataSaverExternalImage).not.toHaveBeenCalled();
    },
  );

  it("gates GIF attachments", () => {
    const row = renderAttachment(image("animation", "image/gif"));
    expect(row.querySelector("img")).toBeNull();
    expect(mediaMocks.dataSaverImage).not.toHaveBeenCalled();
  });

  it("keeps existing placeholders when the network changes; new renders follow it", () => {
    savePref("dataSaver", "mobile");
    const cost = vi.spyOn(desktop.meteredNetwork, "isMetered").mockReturnValue(true);
    const old = renderAttachment(image("old"));
    cost.mockReturnValue(false);
    const fresh = renderAttachment(image("fresh"));
    expect(old.querySelector("img")).toBeNull();
    expect(old.dataset.dataSaver).toBe("waiting");
    expect(fresh.dataset.dataSaver).toBeUndefined();
    expect(mediaMocks.dataSaverImage).toHaveBeenCalledTimes(1);
  });

  it("keeps link preview text while gating its image after async metadata arrives", async () => {
    const row = renderGenericLinkPreview("https://example.test/story");
    savePref("dataSaver", "off");
    await vi.waitFor(() => expect(row.textContent).toContain("Example title"));
    expect(row.textContent).toContain("A text preview");
    expect(row.textContent).toContain("Tap to load");
    expect(row.querySelector("img")).toBeNull();
    expect(mediaMocks.dataSaverExternalImage).not.toHaveBeenCalled();
    row.querySelector<HTMLButtonElement>(".data-saver-placeholder")!.click();
    await vi.waitFor(() => expect(row.querySelector("img")).not.toBeNull());
    expect(mediaMocks.dataSaverExternalImage).toHaveBeenCalledTimes(1);
  });

  it("keeps a YouTube embed text-only until tapped", () => {
    const row = renderYouTubeEmbed("abcd", "https://www.youtube.com/watch?v=abcd");
    expect(row.querySelector("img, iframe")).toBeNull();
    expect(row.querySelector("a")?.textContent).toContain("youtube.com");
    expect(mediaMocks.dataSaverExternalImage).not.toHaveBeenCalled();
  });

  it("never preloads video bytes while data saver is active", () => {
    const row = renderAttachment({ ...image("clip"), filename: "clip.mp4", mime: "video/mp4" });
    expect(row.querySelector("video")?.preload).toBe("none");
  });

  it("keeps custom emoji loading but disables animation", () => {
    expect(emojiStill.animateEmojiEnabled()).toBe(false);
    savePref("dataSaver", "off");
    expect(emojiStill.animateEmojiEnabled()).toBe(true);
  });

  it("shows a sticker's still without hover or tap restarting its animation", async () => {
    const owner = new Disposable();
    const img = document.createElement("img");
    const host = document.createElement("div");
    host.append(img);
    const still = vi.spyOn(emojiStill, "showStillFrame").mockImplementation(() => undefined);
    loadStickerImage(img, host, "/api/v1/stickers/test/image", owner.signal, undefined, true);
    await Promise.resolve();
    expect(still).toHaveBeenCalledWith(img, "blob:server-image");
    host.dispatchEvent(new Event("pointerenter"));
    img.click();
    expect(img.hasAttribute("src")).toBe(false);
    owner.destroy();
  });
});
