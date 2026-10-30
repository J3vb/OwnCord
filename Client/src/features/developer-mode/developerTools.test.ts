import { describe, it, expect, vi, afterEach } from "vitest";
import { copyWithToast, isDeveloperMode } from "./developerTools";
import { showToast } from "../../lib/ui/toast";

vi.mock("../../lib/ui/toast", () => ({ showToast: vi.fn() }));

function setDeveloperMode(on: boolean): void {
  localStorage.setItem("owncord:settings:developerMode", on ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent("owncord:pref-change", { detail: { key: "developerMode" } }),
  );
}

describe("developerTools", () => {
  afterEach(() => {
    setDeveloperMode(false);
    vi.clearAllMocks();
  });

  it("follows the developerMode pref on change and ignores other prefs", () => {
    expect(isDeveloperMode()).toBe(false);
    setDeveloperMode(true);
    expect(isDeveloperMode()).toBe(true);
    localStorage.setItem("owncord:settings:developerMode", "false");
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "other" } }));
    expect(isDeveloperMode()).toBe(true);
  });

  it("copies and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    copyWithToast("42", "toast.idCopied", "toast.idCopyFailed");
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("Message ID copied", "success"));
    expect(writeText).toHaveBeenCalledWith("42");
  });

  it("reports a refused clipboard", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    copyWithToast("42", "toast.idCopied", "toast.idCopyFailed");
    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Couldn't copy the message ID", "error"),
    );
  });
});
