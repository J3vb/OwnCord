// CONTRACT TEST. The artifact under test is owned by Server/admin; see
// server-admin-static-logs.test.ts for why the runner lives here.
//
// A member's letter avatar has the colour the app gives them: core.js mirrors
// the client's palette and hash, and both sides pin the same samples
// (tests/helpers/avatarColorSamples.ts; the client half is in avatar.test.ts).
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";
import { AVATAR_COLOR_SAMPLES, AVATAR_PALETTE } from "../helpers/avatarColorSamples";

const BRIDGE = `<script>
window.__test = { palette: AVATAR_COLORS, avatarColor: avatarColor, avatarHtml: avatarHtml };
</script>`;

interface Bridge {
  readonly palette: readonly string[];
  readonly avatarColor: (name: string) => string;
  readonly avatarHtml: (name: string) => string;
}

function loadPanel(): { doc: Document; test: Bridge } {
  const dom = new JSDOM(adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`), {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never;
    },
  });
  const test = (dom.window as unknown as { __test: Bridge }).__test;
  return { doc: dom.window.document, test };
}

describe("admin letter avatars", () => {
  it("use the app's palette and hash", () => {
    const { test } = loadPanel();
    expect([...test.palette]).toEqual(AVATAR_PALETTE);
    for (const [name, colour] of AVATAR_COLOR_SAMPLES)
      expect(test.avatarColor(name), name).toBe(colour);
  });

  it("draw the member's initial on their own colour, hidden from assistive tech", () => {
    const { doc, test } = loadPanel();
    const host = doc.createElement("div");
    host.innerHTML = test.avatarHtml("alice") + test.avatarHtml("");
    const [alice, nameless] = Array.from(host.querySelectorAll<HTMLElement>(".avatar"));
    expect(alice?.textContent).toBe("A");
    expect(alice?.getAttribute("aria-hidden")).toBe("true");
    expect(alice?.style.background).toBe("rgb(123, 63, 179)"); // #7b3fb3
    expect(nameless?.textContent).toBe("?");
  });
});
