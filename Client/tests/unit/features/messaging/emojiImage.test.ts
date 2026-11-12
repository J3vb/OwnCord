import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TWEMOJI_BASE,
  buildEmojiImage,
  buildEmojiNode,
  packIndex,
  showsAsImage,
  twemojiName,
} from "../../../../src/features/messaging/content/emojiImage";
import {
  renderMessageContent,
  clearContentParseCache,
} from "../../../../src/features/messaging/content/contentParser";
import { isEmojiOnlyMessage } from "../../../../src/features/messaging/content/customEmoji";
import {
  TWEMOJI_PACK_COUNT,
  twemojiFileName,
  twemojiPacks,
} from "../../../../scripts/twemoji-names.mjs";
import { stubTwemoji } from "../../../helpers/twemojiStub";

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
  it("is an image of the emoji with the emoji itself as alt text, filled from its pack", async () => {
    const restore = stubTwemoji({ "1f525": "<svg/>" });
    const img = buildEmojiImage("🔥");
    expect(img.alt).toBe("🔥");
    expect(img.draggable).toBe(false);
    expect(img.hasAttribute("src")).toBe(false);
    await vi.waitFor(() => expect(img.getAttribute("src")).toMatch(/^blob:twemoji-/));
    const again = buildEmojiImage("🔥");
    expect(again.getAttribute("src")).toBe(img.getAttribute("src"));
    restore();
  });

  it("turns back into its text when there is no image for it", async () => {
    const restore = stubTwemoji({});
    const host = document.createElement("span");
    host.appendChild(buildEmojiImage("🫨"));
    await vi.waitFor(() => expect(host.querySelector("img")).toBeNull());
    expect(host.textContent).toBe("🫨");
    restore();
  });

  it("turns back into its text when the image fails to load", () => {
    const host = document.createElement("span");
    const img = buildEmojiImage("🫠");
    host.appendChild(img);
    img.dispatchEvent(new Event("error"));
    expect(host.textContent).toBe("🫠");
  });

  it("buildEmojiNode keeps plain text for a text-style symbol", () => {
    expect(buildEmojiNode("©").nodeType).toBe(Node.TEXT_NODE);
    expect((buildEmojiNode("🍕") as HTMLImageElement).alt).toBe("🍕");
  });
});

describe("Twemoji packs", () => {
  it("finds the pack whose first name sorts at or before the emoji", () => {
    const firsts = ["", "1f3", "1f6", "2"];
    expect(packIndex(firsts, "1f1e7-1f1ea")).toBe(0);
    expect(packIndex(firsts, "1f3")).toBe(1);
    expect(packIndex(firsts, "1f525")).toBe(1);
    expect(packIndex(firsts, "1f600")).toBe(2);
    expect(packIndex(firsts, "2764")).toBe(3);
  });

  it("puts every shipped image in the pack the client looks in", () => {
    const dir = resolve(process.cwd(), "node_modules/@discordapp/twemoji/dist/svg");
    const svgs = new Map<string, string>();
    for (const f of readdirSync(dir))
      if (f.endsWith(".svg")) svgs.set(twemojiFileName(f.slice(0, -4)), f);
    const { starts, packs } = twemojiPacks(svgs);
    expect(packs).toHaveLength(TWEMOJI_PACK_COUNT);
    for (const name of svgs.keys()) {
      expect(packs[packIndex(starts, name)]?.[name], name).toBe(svgs.get(name));
    }
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

  it("draws a tag-sequence flag as one image", () => {
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(twemojiName(england)).toBe("1f3f4-e0067-e0062-e0065-e006e-e0067-e007f");
    const host = render(`go ${england}!`);
    expect([...host.querySelectorAll<HTMLImageElement>("img.emoji-img")].map((i) => i.alt)).toEqual(
      [england],
    );
    expect(host.textContent).toBe("go !");
    expect(isEmojiOnlyMessage(england)).toBe(true);
  });

  it("keeps emoji inside code as text", () => {
    const host = render("`😀` and\n```\n🔥\n```");
    expect(host.querySelector("img.emoji-img")).toBeNull();
    expect(host.textContent).toContain("😀");
    expect(host.textContent).toContain("🔥");
  });
});
