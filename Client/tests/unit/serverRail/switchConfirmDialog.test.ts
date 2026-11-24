/** The switch question hands its focus fallback to the dialog it builds. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openServerSwitchConfirm } from "../../../src/features/server-rail/switchConfirmDialog";

describe("openServerSwitchConfirm", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fallbackFocus reaches the dialog: with the opener removed, Cancel focuses the fallback", () => {
    const opener = document.createElement("button");
    const fallback = document.createElement("button");
    document.body.append(opener, fallback);
    opener.focus();
    const onConfirm = vi.fn();
    openServerSwitchConfirm({ name: "Beta", onConfirm, fallbackFocus: () => fallback });
    expect(document.activeElement).not.toBe(opener);

    opener.remove();
    document.querySelector<HTMLElement>('[data-testid="server-switch-cancel"]')?.click();

    expect(document.querySelector('[data-testid="server-switch-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(fallback);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
