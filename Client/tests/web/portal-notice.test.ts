/**
 * The portal's incompatible-server notice (WP 6.13e2): the client is the page,
 * so the update exit reads "Reload page" and runs the caller's update action.
 */
import { describe, expect, it, vi } from "vitest";
import { createIncompatibleNotice } from "../../src/pages/connect-page/IncompatibleNotice";
import { portalText } from "../../src/i18n/portal";

/** Shows the notice for a mismatch and clicks Reload page; returns what the click ran. */
function reloadFrom(clientVersion: number, serverVersion: number) {
  const onUpdate = vi.fn();
  const notice = createIncompatibleNotice({ onUpdate, onLeave: vi.fn() });
  notice.show("chat.example", clientVersion, serverVersion);
  const button = notice.element.querySelector<HTMLButtonElement>(".incompatible-notice-update")!;
  expect(button.textContent).toBe(portalText("incompatible.reload"));
  button.click();
  return onUpdate;
}

describe("portal incompatible notice", () => {
  it("offers Reload page when the client is the older side", () => {
    const onUpdate = reloadFrom(5, 4);
    expect(onUpdate).toHaveBeenCalledWith("chat.example");
  });

  it("offers no other server to choose", () => {
    const notice = createIncompatibleNotice({ onUpdate: vi.fn(), onLeave: vi.fn() });
    notice.show("chat.example", 3, 4);
    expect(notice.element.querySelector(".incompatible-notice-leave")).toBeNull();
  });

  it("offers Reload page when the server is the older side too", () => {
    const onUpdate = reloadFrom(3, 4);
    expect(onUpdate).toHaveBeenCalledWith("chat.example");
  });
});
