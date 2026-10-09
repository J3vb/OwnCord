// With the native drag-drop handler off (tauri.conf.json), a file dropped
// where no composer is listening would navigate the webview to that file.
import { describe, expect, it } from "vitest";
import { installFileDropGuard } from "@lib/fileDropGuard";

function dragEvent(type: string, types: string[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { types } });
  return ev;
}

describe("installFileDropGuard", () => {
  it("cancels file dragover and drop so the webview never navigates to the file", () => {
    const ac = new AbortController();
    installFileDropGuard(ac.signal);

    for (const type of ["dragover", "drop"]) {
      const ev = dragEvent(type, ["Files"]);
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    ac.abort();
  });

  it("leaves non-file drags (text, links) alone", () => {
    const ac = new AbortController();
    installFileDropGuard(ac.signal);

    const ev = dragEvent("drop", ["text/plain"]);
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    ac.abort();
  });

  it("stops guarding once its signal aborts", () => {
    const ac = new AbortController();
    installFileDropGuard(ac.signal);
    ac.abort();

    const ev = dragEvent("drop", ["Files"]);
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
