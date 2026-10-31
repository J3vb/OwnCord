import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/renderersMocks";
import { renderMessage } from "../../../src/components/message-list/renderers";
import { savePref } from "../../../src/lib/prefs/preferences";
import {
  createObjectURLMock,
  brokerImages,
  seedMentionMembers,
  makeMessage,
  makeOpts,
  useRenderersHarness,
  mountMessage,
  mountContent,
} from "../../helpers/renderersHarness";

vi.mock("../../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentExternalMock(importOriginal),
);
vi.mock("../../../src/platform/desktop/externalContent", () => mocks.desktopExternalContentMock());

const { imageMock, consent } = mocks;

describe("renderers", () => {
  let container: HTMLDivElement;
  useRenderersHarness((el) => {
    container = el;
  });

  // ---------------------------------------------------------------------------
  // isDirectImageUrl (via renderMessage embed output)
  // ---------------------------------------------------------------------------

  describe("isDirectImageUrl — image extension detection via renderMessage", () => {
    const imageExtensions = [".gif", ".png", ".jpg", ".jpeg", ".webp"] as const;

    for (const ext of imageExtensions) {
      it(`produces a .msg-image embed for a ${ext} URL`, async () => {
        const url = `https://example.com/image${ext}`;
        const msg = makeMessage({ content: url });
        const { ac } = mountMessage(container, msg);

        // renderUrlEmbeds calls isDirectImageUrl → renderInlineImage
        // which produces a div.msg-image inside the message element.
        // The image bytes come from the broker for exactly this URL and land
        // on the embed's <img> as a blob: URL.
        expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url });
        const [imgEl] = await brokerImages(1);
        expect(container.contains(imgEl!)).toBe(true);

        ac.abort();
      });
    }

    it("does not produce a .msg-image embed for a non-image URL", () => {
      const url = "https://example.com/page.html";
      const msg = makeMessage({ content: url });
      const { ac } = mountMessage(container, msg);

      // A generic link card (.msg-embed-link) should appear instead
      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();
      expect(container.querySelector(".msg-embed-link")).not.toBeNull();
      expect(imageMock).not.toHaveBeenCalledWith(expect.any(String), { url });

      ac.abort();
    });

    it("does not produce a .msg-image embed for a URL with image extension as query param", () => {
      // The path itself has no image extension — only a query string does
      const url = "https://example.com/image?format=png";
      const msg = makeMessage({ content: url });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();
      expect(imageMock).not.toHaveBeenCalledWith(expect.any(String), { url });

      ac.abort();
    });

    it("matches image extensions case-insensitively", async () => {
      // Uppercase extensions must also be detected
      const url = "https://example.com/photo.PNG";
      const { ac } = mountContent(container, url);

      expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url });
      await brokerImages(1);

      ac.abort();
    });

    it("does not treat a YouTube URL with no image extension as a direct image", () => {
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const msg = makeMessage({ content: url });
      const { ac } = mountMessage(container, msg);

      // YouTube gets a player embed, not a .msg-image with that src
      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();
      expect(container.querySelector(".msg-embed-youtube")).not.toBeNull();
      expect(imageMock).not.toHaveBeenCalledWith(expect.any(String), { url });

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // renderInlineImage (via renderMessage)
  // ---------------------------------------------------------------------------

  describe("a message that is only an image link", () => {
    function render(content: string): HTMLElement {
      const msg = makeMessage({ content });
      const el = renderMessage(msg, false, [msg], makeOpts(), new AbortController().signal);
      container.appendChild(el);
      return el;
    }

    it("shows the GIF and hides the link text, like a GIF picker pick", () => {
      const url = "https://static.klipy.com/ii/abc/cat.gif";
      const el = render(`  ${url}\n`);
      expect(el.querySelector(".msg-image")).not.toBeNull();
      const text = el.querySelector<HTMLElement>("[data-lone-image-text]");
      expect(text?.hidden).toBe(true);
      expect(text?.querySelector(`a[href="${url}"]`)).not.toBeNull();
    });

    it("brings the link text back when turning inline media off removes the GIF", async () => {
      const url = "https://static.klipy.com/ii/abc/cat.gif";
      const el = render(url);
      await brokerImages(1);
      try {
        // Turning inline media off also withdraws consent, which re-renders the embed.
        consent.allowed = false;
        savePref("inlineMedia", false);
        expect(el.querySelector(".msg-image")).toBeNull();
        const text = el.querySelector<HTMLElement>("[data-lone-image-text]");
        expect(text?.hidden).toBe(false);
        expect(text?.style.display).toBe("contents");
      } finally {
        consent.allowed = true;
        savePref("inlineMedia", true);
      }
    });

    it("keeps the link text when the image link comes with other words", () => {
      const url = "https://example.com/cat.gif";
      const el = render(`look ${url}`);
      expect(el.querySelector(".msg-image")).not.toBeNull();
      expect(el.querySelector(`a.msg-link[href="${url}"]`)).not.toBeNull();
    });

    it("keeps the text of two image links, an embed-suppressed one and a non-image one", () => {
      for (const content of [
        "https://example.com/a.gif https://example.com/b.gif",
        "<https://example.com/a.gif>",
        "||https://example.com/a.gif||",
        "https://example.com/page.html",
      ]) {
        const el = render(content);
        expect(el.querySelector(".msg-text"), content).not.toBeNull();
        el.remove();
      }
    });
  });

  describe("renderInlineImage — img element and lightbox behaviour", () => {
    it("creates an img element with the correct src attribute", async () => {
      const url = "https://example.com/photo.jpg";
      const msg = makeMessage({ content: url });
      const { ac } = mountMessage(container, msg);

      const img = container.querySelector(`.msg-image img`) as HTMLImageElement | null;
      expect(img).not.toBeNull();
      // Never the remote URL: the broker fetches it, the img shows its blob.
      expect(img!.getAttribute("src")).not.toBe(url);
      expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url });
      await vi.waitFor(() => expect(img!.getAttribute("src")).toMatch(/^blob:/));
      expect(createObjectURLMock).toHaveReturnedWith(img!.getAttribute("src"));

      ac.abort();
    });

    it("wraps the img in a div with class msg-image", () => {
      const url = "https://cdn.example.com/banner.gif";
      const msg = makeMessage({ content: url });
      const { ac } = mountMessage(container, msg);

      const wrap = container.querySelector(".msg-image");
      expect(wrap).not.toBeNull();
      expect(wrap!.querySelector("img")).not.toBeNull();

      ac.abort();
    });

    it("appends a lightbox overlay to document.body on img click", async () => {
      const url = "https://example.com/photo.png";
      const { ac } = mountContent(container, url);

      const [img] = await brokerImages(1);
      expect(img).toBeDefined();

      // No lightbox before click
      expect(document.body.querySelector(".image-lightbox")).toBeNull();

      img!.click();

      // Lightbox should now be in the body
      const lightbox = document.body.querySelector(".image-lightbox");
      expect(lightbox).not.toBeNull();

      // Clean up lightbox
      lightbox!.remove();
      ac.abort();
    });

    it("lightbox contains a close button that removes the overlay", async () => {
      const url = "https://example.com/photo.webp";
      const { ac } = mountContent(container, url);

      const [img] = await brokerImages(1);
      img!.click();

      const lightbox = document.body.querySelector(".image-lightbox")!;
      const closeBtn = lightbox.querySelector(".image-lightbox-close") as HTMLElement | null;
      expect(closeBtn).not.toBeNull();

      closeBtn!.click();

      // Lightbox should be removed from DOM after close
      expect(document.body.querySelector(".image-lightbox")).toBeNull();

      ac.abort();
    });

    it("lightbox contains an img element with the same src as the inline image", async () => {
      const url = "https://example.com/pic.jpeg";
      const { ac } = mountContent(container, url);

      const [img] = await brokerImages(1);
      img!.click();

      const lightbox = document.body.querySelector(".image-lightbox")!;
      const lbImg = lightbox.querySelector("img") as HTMLImageElement | null;
      expect(lbImg).not.toBeNull();
      expect(lbImg!.getAttribute("src")).toBe(img!.getAttribute("src"));
      expect(lbImg!.getAttribute("src")).toMatch(/^blob:/);

      // Clean up
      lightbox.remove();
      ac.abort();
    });

    it("closes lightbox when Escape key is pressed", async () => {
      const url = "https://example.com/escape-test.png";
      const { ac } = mountContent(container, url);

      const [img] = await brokerImages(1);
      img!.click();

      expect(document.body.querySelector(".image-lightbox")).not.toBeNull();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(document.body.querySelector(".image-lightbox")).toBeNull();

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // System messages
  // ---------------------------------------------------------------------------

  describe("renderSystemMessage (via renderMessage)", () => {
    it("renders system message with icon, text, and time", () => {
      const msg = makeMessage({
        user: { id: 0, username: "System", avatar: null },
        content: "@alice joined the server",
      });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".system-msg")).not.toBeNull();
      expect(container.querySelector(".sm-icon")).not.toBeNull();
      expect(container.querySelector(".sm-text")).not.toBeNull();
      expect(container.querySelector(".sm-time")).not.toBeNull();

      ac.abort();
    });

    it("renders its time in the same clock format as the message header", () => {
      const msg = makeMessage({
        user: { id: 0, username: "System", avatar: null },
        content: "@alice joined the server",
        timestamp: new Date().toISOString(),
      });
      const { el, ac } = mountMessage(container, msg);

      // The header format is "Today at 2:34 PM", not the bare 24h "14:34"
      // formatTime used to render here (DP-48).
      expect(el.querySelector(".sm-time")!.textContent).toMatch(/^Today at /);

      ac.abort();
    });

    it("renders mentions inside system message text", () => {
      const msg = makeMessage({
        user: { id: 0, username: "System", avatar: null },
        content: "@alice was promoted to admin",
      });
      seedMentionMembers();
      const { el, ac } = mountMessage(container, msg);

      const mention = el.querySelector(".mention");
      expect(mention).not.toBeNull();
      expect(mention!.textContent).toBe("@alice");

      ac.abort();
    });

    it("does not treat a real registered user named 'System' as a system notice", () => {
      // Real user ids are DB autoincrement and start at 1 — only the
      // synthetic sentinel row (id 0) is a genuine system message. A user
      // who registered the display name "System" must render normally,
      // with an author name and full moderation controls.
      const msg = makeMessage({
        user: { id: 42, username: "System", avatar: null },
        content: "Your session was flagged — re-enter your password at evil.example",
      });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".system-msg")).toBeNull();
      expect(container.querySelector(".msg-author")).not.toBeNull();
      // The hover action bar (react/reply/pin/…) is only built for real
      // messages — renderSystemMessage returns before it exists at all.
      expect(container.querySelector('[data-testid="msg-reply-1"]')).not.toBeNull();

      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // Reply reference — unknown message
  // ---------------------------------------------------------------------------

  describe("renderReplyRef — unknown message", () => {
    it("renders 'Reply to unknown message' when referenced message is missing", () => {
      const reply = makeMessage({ id: 2, replyTo: 999, content: "replying" });
      const ac = new AbortController();
      const el = renderMessage(reply, false, [reply], makeOpts(), ac.signal);
      container.appendChild(el);

      const replyRef = container.querySelector(".msg-reply-ref");
      expect(replyRef).not.toBeNull();
      expect(replyRef!.textContent).toBe("Reply to unknown message");

      ac.abort();
    });

    it("uses the server snippet when the parent is outside the loaded window", () => {
      const reply = makeMessage({
        id: 2,
        replyTo: 999,
        content: "replying",
        referencedMessage: {
          id: 999,
          user: { id: 10, username: "alice", avatar: null },
          content: "**old** parent text",
          deleted: false,
          has_attachments: false,
        },
      });
      const ac = new AbortController();
      container.appendChild(renderMessage(reply, false, [reply], makeOpts(), ac.signal));

      const ref = container.querySelector(".msg-reply-ref")!;
      expect(ref.querySelector(".rr-author")?.textContent).toBe("alice");
      expect(ref.querySelector(".rr-text")?.textContent).toBe("old parent text");
      ac.abort();
    });

    it("shows the deleted notice for a redacted snippet", () => {
      const reply = makeMessage({
        id: 2,
        replyTo: 999,
        referencedMessage: {
          id: 999,
          user: null,
          content: "",
          deleted: true,
          has_attachments: false,
        },
      });
      const ac = new AbortController();
      container.appendChild(renderMessage(reply, false, [reply], makeOpts(), ac.signal));

      const ref = container.querySelector(".msg-reply-ref")!;
      expect(ref.querySelector(".rr-author")).toBeNull();
      expect(ref.textContent).toBe("Original message was deleted");
      ac.abort();
    });

    it("says the original message was deleted, with no avatar or author, for a deleted loaded parent", () => {
      const original = makeMessage({ id: 1, content: "Original", deleted: true });
      const reply = makeMessage({ id: 2, replyTo: 1, content: "reply" });
      const ac = new AbortController();
      const el = renderMessage(reply, false, [original, reply], makeOpts(), ac.signal);
      container.appendChild(el);

      const ref = container.querySelector(".msg-reply-ref")!;
      expect(ref.textContent).toBe("Original message was deleted");
      expect(ref.classList.contains("msg-reply-ref--deleted")).toBe(true);
      expect(ref.querySelector(".rr-avatar, .rr-author, .rr-text")).toBeNull();

      ac.abort();
    });

    it("a reply to a deleted message is not a jump link", () => {
      const onJumpToMessage = vi.fn();
      const loaded = makeMessage({ id: 1, content: "Original", deleted: true });
      const replyToLoaded = makeMessage({ id: 2, replyTo: 1, content: "reply" });
      const replyToSnippet = makeMessage({
        id: 3,
        replyTo: 999,
        referencedMessage: {
          id: 999,
          user: null,
          content: "",
          deleted: true,
          has_attachments: false,
        },
      });
      const ac = new AbortController();
      const all = [loaded, replyToLoaded, replyToSnippet];
      for (const msg of [replyToLoaded, replyToSnippet]) {
        container.appendChild(
          renderMessage(msg, false, all, makeOpts({ onJumpToMessage }), ac.signal),
        );
      }

      const bars = container.querySelectorAll<HTMLElement>(".msg-reply-ref");
      expect(bars).toHaveLength(2);
      for (const bar of bars) {
        expect(bar.getAttribute("role")).toBeNull();
        expect(bar.getAttribute("tabindex")).toBeNull();
        bar.click();
        bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      }
      expect(onJumpToMessage).not.toHaveBeenCalled();
      ac.abort();
    });

    it("a reply to an unknown message stays a jump link", () => {
      const onJumpToMessage = vi.fn();
      const reply = makeMessage({ id: 2, replyTo: 999, content: "replying" });
      const ac = new AbortController();
      container.appendChild(
        renderMessage(reply, false, [reply], makeOpts({ onJumpToMessage }), ac.signal),
      );

      const bar = container.querySelector<HTMLElement>(".msg-reply-ref")!;
      expect(bar.getAttribute("role")).toBe("button");
      bar.click();
      expect(onJumpToMessage).toHaveBeenCalledWith(999);
      ac.abort();
    });
  });

  // ---------------------------------------------------------------------------
  // Developer mode — copy ID button
  // ---------------------------------------------------------------------------

  describe("developer mode — Copy ID", () => {
    it("is not a hover-bar button in either mode; the message menu offers it", () => {
      for (const mode of ["true", "false"]) {
        localStorage.setItem("owncord:settings:developerMode", mode);
        window.dispatchEvent(
          new CustomEvent("owncord:pref-change", { detail: { key: "developerMode" } }),
        );
        const msg = makeMessage();
        const ac = new AbortController();
        const el = renderMessage(msg, false, [msg], makeOpts(), ac.signal);
        expect(el.querySelector("[data-testid^='msg-copy-id-']")).toBeNull();
        ac.abort();
      }
      localStorage.setItem("owncord:settings:developerMode", "false");
      window.dispatchEvent(
        new CustomEvent("owncord:pref-change", { detail: { key: "developerMode" } }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // renderUrlEmbeds (via renderMessage)
  // ---------------------------------------------------------------------------

  describe("renderUrlEmbeds — embed routing via renderMessage", () => {
    it("produces a .msg-image element for a direct image URL instead of a generic link card", () => {
      const url = "https://static.example.com/hero.png";
      const msg = makeMessage({ content: url });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".msg-image")).not.toBeNull();
      expect(container.querySelector(".msg-embed-link")).toBeNull();

      ac.abort();
    });

    it("does not duplicate embeds for the same URL appearing twice in content", async () => {
      const url = "https://example.com/img.gif";
      const msg = makeMessage({ content: `${url} and again ${url}` });
      const { ac } = mountMessage(container, msg);

      // URL dedup inside renderUrlEmbeds — only one img embed produced
      expect(container.querySelectorAll(".msg-image img").length).toBe(1);
      expect(imageMock).toHaveBeenCalledTimes(1);
      expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url });
      await brokerImages(1);

      ac.abort();
    });

    it("skips image URLs that appear inside code blocks", () => {
      const url = "https://example.com/hidden.png";
      const msg = makeMessage({ content: `\`\`\`${url}\`\`\`` });
      const { ac } = mountMessage(container, msg);

      // URL inside a code block must not produce an embed
      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();
      expect(imageMock).not.toHaveBeenCalledWith(expect.any(String), { url });

      ac.abort();
    });

    it("skips image URLs inside inline code", () => {
      const url = "https://example.com/inline.png";
      const msg = makeMessage({ content: `Look at \`${url}\`` });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();
      expect(imageMock).not.toHaveBeenCalledWith(expect.any(String), { url });

      ac.abort();
    });

    it("renders multiple different image URLs as separate .msg-image embeds", async () => {
      const url1 = "https://example.com/a.png";
      const url2 = "https://example.com/b.gif";
      const { ac } = mountContent(container, `${url1} and ${url2}`);

      expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url: url1 });
      expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url: url2 });
      const [a, b] = await brokerImages(2);
      expect(a!.getAttribute("src")).not.toBe(b!.getAttribute("src"));

      ac.abort();
    });

    it("renders a generic link card for a plain https URL with no image extension", () => {
      const url = "https://example.com/some-article";
      const msg = makeMessage({ content: url });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".msg-embed-link")).not.toBeNull();
      expect(container.querySelector(`.msg-image img[src="${url}"]`)).toBeNull();
      expect(imageMock).not.toHaveBeenCalledWith(expect.any(String), { url });

      ac.abort();
    });

    it("produces no embeds for a message with no URLs", () => {
      const msg = makeMessage({ content: "just plain text, no links" });
      const { ac } = mountMessage(container, msg);

      expect(container.querySelector(".msg-embed")).toBeNull();
      expect(container.querySelector(".msg-image")).toBeNull();

      ac.abort();
    });
  });
});
