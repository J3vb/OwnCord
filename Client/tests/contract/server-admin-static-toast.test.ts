// CONTRACT TEST. The artifact under test is owned by Server/admin; see
// server-admin-static-logs.test.ts for why the runner lives here.
//
// A refused clipboard copy is a best-effort step that did not happen, not a
// failed request: its toast is a warning that closes itself, while a request
// error stays until it is dismissed.
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = { copyInviteText: copyInviteText, showToast: showToast };
</script>`;

interface Timer {
  fn: () => void;
  ms: number;
}

function loadPanel(): {
  doc: Document;
  timers: Timer[];
  copyInviteText: (code: string) => Promise<void>;
  showToast: (msg: string, type?: string) => void;
} {
  const timers: Timer[] = [];
  const dom = new JSDOM(adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`), {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never;
      Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText: async () => Promise.reject(new Error("denied")) },
        configurable: true,
      });
      const real = window.setTimeout.bind(window);
      window.setTimeout = ((fn: () => void, ms?: number) => {
        if (typeof ms === "number" && ms >= 3000) {
          timers.push({ fn, ms });
          return 0;
        }
        return real(fn, ms);
      }) as typeof window.setTimeout;
    },
  });
  const test = (
    dom.window as unknown as {
      __test: {
        copyInviteText: (code: string) => Promise<void>;
        showToast: (msg: string, type?: string) => void;
      };
    }
  ).__test;
  return { doc: dom.window.document, timers, ...test };
}

describe("admin toasts", () => {
  it("shows a refused invite copy as a warning that closes after 8 s", async () => {
    const panel = loadPanel();
    await panel.copyInviteText("INV-1");
    const toast = panel.doc.getElementById("toast")!;
    expect(toast.classList.contains("warning")).toBe(true);
    expect(toast.classList.contains("error")).toBe(false);
    expect(toast.classList.contains("visible")).toBe(true);
    expect(toast.querySelector(".toast-close")).not.toBeNull();

    const close = panel.timers.at(-1)!;
    expect(close.ms).toBe(8000);
    close.fn();
    expect(toast.classList.contains("visible")).toBe(false);
  });

  it("keeps a request error until it is dismissed", () => {
    const panel = loadPanel();
    panel.showToast("Server said no", "error");
    expect(panel.doc.getElementById("toast")!.classList.contains("visible")).toBe(true);
    expect(panel.timers).toHaveLength(0);
  });
});
