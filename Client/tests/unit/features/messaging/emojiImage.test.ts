import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TWEMOJI_BASE,
  buildEmojiImage,
  buildEmojiNode,
  showsAsImage,
  twemojiName,
} from "../../../../src/features/messaging/content/emojiImage";
import {
  renderMessageContent,
  clearContentParseCache,
} from "../../../../src/features/messaging/content/contentParser";
import { isEmojiOnlyMessage } from "../../../../src/features/messaging/content/customEmoji";
import { twemojiFileName } from "../../../../scripts/twemoji-names.mjs";

function render(text: string): HTMLElement {
  clearContentParseCache();
  const host = document.createElement("div");
  host.appendChild(renderMessageContent(text));
  return host;
}

describe("twemojiName", () => {
  it("joins code points in hex and drops U+FE0F, as the shipped files are named", () => {
    expect(twemojiName("😀")).toBe("1f600");
    expect(twemojiName("❤️")).toBe("2764");
    expect(twemojiName("👁️‍🗨️")).toBe("1f441-200d-1f5e8");
    expect(twemojiName("👍🏽")).toBe("1f44d-1f3fd");
    expect(twemojiName("🇧🇪")).toBe("1f1e7-1f1ea");
  });

  it("agrees with the build's file-naming rule", () => {
    for (const emoji of ["😀", "❤️", "👁️‍🗨️", "👨‍👩‍👧", "#️⃣", "🏳️‍🌈", "🧑🏿‍🤝‍🧑🏻"]) {
      expect(twemojiName(emoji)).toBe(twemojiFileName(emoji));
    }
    expect(twemojiFileName("1f441-fe0f-200d-1f5e8-fe0f")).toBe("1f441-200d-1f5e8");
  });

  it("serves the version of the installed Twemoji package", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), "node_modules/@discordapp/twemoji/package.json"), "utf8"),
    ) as { version: string };
    expect(TWEMOJI_BASE).toBe(`/assets/twemoji/${pkg.version}/`);
  });
});

describe("showsAsImage", () => {
  it("is true for emoji-style characters and sequences", () => {
    for (const emoji of ["😀", "❤️", "👍🏽", "🇧🇪", "#️⃣", "👨‍👩‍👧"]) {
      expect(showsAsImage(emoji), emoji).toBe(true);
    }
  });

  it("is false for symbols typed in text style, as Discord leaves them", () => {
    for (const symbol of ["©", "™", "↔", "‼"]) expect(showsAsImage(symbol), symbol).toBe(false);
  });
});

describe("buildEmojiImage", () => {
  it("is an image of the emoji with the emoji itself as alt text", () => {
    const img = buildEmojiImage("🔥");
    expect(img.alt).toBe("🔥");
    expect(img.getAttribute("src")).toBe(`${TWEMOJI_BASE}1f525.svg`);
    expect(img.draggable).toBe(false);
  });

  it("turns back into its text when the image is missing", () => {
    const host = document.createElement("span");
    const img = buildEmojiImage("🫨");
    host.appendChild(img);
    img.dispatchEvent(new Event("error"));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("🫨");
  });

  it("buildEmojiNode keeps plain text for a text-style symbol", () => {
    expect(buildEmojiNode("©").nodeType).toBe(Node.TEXT_NODE);
    expect((buildEmojiNode("🍕") as HTMLImageElement).alt).toBe("🍕");
  });
});

describe("message text", () => {
  it("shows unicode emoji as images and leaves the rest as text", () => {
    const host = render("hi 😀 and © ok");
    const imgs = [...host.querySelectorAll<HTMLImageElement>("img.emoji-img")];
    expect(imgs.map((i) => i.alt)).toEqual(["😀"]);
    expect(host.textContent).toBe("hi  and © ok");
  });

  it("draws a flag as one image, not two letters", () => {
    const imgs = render("go 🇧🇪!").querySelectorAll<HTMLImageElement>("img.emoji-img");
    expect([...imgs].map((i) => i.alt)).toEqual(["🇧🇪"]);
    expect(isEmojiOnlyMessage("🇧🇪")).toBe(true);
  });

  it("keeps emoji inside code as text", () => {
    const host = render("`😀` and\n```\n🔥\n```");
    expect(host.querySelector("img.emoji-img")).toBeNull();
    expect(host.textContent).toContain("😀");
    expect(host.textContent).toContain("🔥");
  });
});
