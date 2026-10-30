/**
 * The portal's user bar (WP 6.13e2): its disconnect button signs the user out
 * through the app's existing logout path, and the server quick switch, which
 * has nothing to switch to on a single-server page, is never reached. Runs in
 * the `web` project, where `__OWNCORD_WEB__` is true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubGlobal("isSecureContext", true);
});
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@lib/net/logout", () => ({ logout: vi.fn() }));
vi.mock("@lib/voice/livekitSession", () => ({}));
vi.mock("@components/QuickSwitchOverlay", () => ({
  createQuickSwitchOverlay: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));
vi.mock("@components/ChannelSidebar", () => ({
  createChannelSidebar: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));
vi.mock("@components/DmSidebar", () => ({
  createDmSidebar: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn(), update: vi.fn() }),
}));
vi.mock("@components/MemberList", () => ({
  createMemberList: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));

import { createSidebarArea, type SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { createQuickSwitchOverlay } from "@components/QuickSwitchOverlay";
import { logout } from "@lib/net/logout";
import { authStore } from "../../src/stores/auth.store";
import { shellText } from "../../src/i18n/shell";
import { portalText } from "../../src/i18n/portal";

function options(api: object): SidebarAreaOptions {
  return {
    ws: { send: vi.fn(), close: vi.fn(), on: vi.fn(() => vi.fn()), off: vi.fn() },
    api,
    limiters: {
      voice: { tryConsume: vi.fn().mockReturnValue(true) },
      voiceVideo: { tryConsume: vi.fn().mockReturnValue(true) },
    },
    presenceSender: { send: vi.fn(), rollbackRefused: vi.fn(), destroy: vi.fn() },
    getRoot: vi.fn().mockReturnValue(document.createElement("div")),
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  } as unknown as SidebarAreaOptions;
}

let container: HTMLDivElement;
beforeEach(() => {
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "me", role: "member", avatar: null, totp_enabled: false },
    serverName: "OwnCord Home",
    motd: null,
    isAuthenticated: true,
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
  vi.clearAllMocks();
});

describe("portal user bar", () => {
  it("fixed host: user bar signs out, no quick switch", () => {
    const api = { getConfig: vi.fn().mockReturnValue({ host: location.host }) };
    const sidebar = createSidebarArea(options(api));
    container.appendChild(sidebar.sidebarWrapper);

    const button = container.querySelector<HTMLButtonElement>('[data-testid="disconnect-btn"]')!;
    expect(button.getAttribute("aria-label")).toBe(portalText("userBar.signOut"));
    expect(button.getAttribute("aria-label")).not.toBe(shellText("quickSwitch.label"));

    button.click();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith(api);
    expect(createQuickSwitchOverlay).not.toHaveBeenCalled();
    for (const unsub of sidebar.unsubscribers) unsub();
    for (const child of sidebar.children) child.destroy?.();
  });
});
