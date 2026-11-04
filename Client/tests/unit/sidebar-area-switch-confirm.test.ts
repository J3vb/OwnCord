import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as mocks from "../helpers/sidebarAreaMocks";
import { lightSidebarAreaOpts } from "../helpers/sidebarAreaOpts";

vi.mock("@lib/voice/livekitSession", () => mocks.rePinSessionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.e2eeCryptoMock());
vi.mock("@lib/presence/profiles", () => mocks.presenceProfilesMock());
vi.mock("@components/UserBar", () => mocks.userBarMock());
vi.mock("@components/VoiceWidget", () => mocks.voiceWidgetMock());
vi.mock("@components/MemberList", () => mocks.memberListMock());
const { createQuickSwitchOverlay, switchToServer } = vi.hoisted(() => ({
  createQuickSwitchOverlay: vi.fn(),
  switchToServer: vi.fn(),
}));
vi.mock("@components/QuickSwitchOverlay", () => ({ createQuickSwitchOverlay }));
vi.mock("../../src/features/server-rail/switchServer", () => ({
  switchToServer,
  addServer: vi.fn(),
}));

import { createSidebarArea, type SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { signInAs } from "../helpers/storeSeeds";

function opts(): SidebarAreaOptions {
  return lightSidebarAreaOpts("a.example");
}

type OnSwitch = (host: string, name: string) => void;

describe("SidebarArea - quick switcher asks before switching", () => {
  let area: ReturnType<typeof createSidebarArea>;
  let torn = false;
  const dialog = () => document.querySelector('[data-testid="server-switch-dialog"]');
  const click = (testId: string) =>
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    torn = false;
    createQuickSwitchOverlay.mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
    signInAs({ id: 2, username: "Member", avatar: null, role: "member" }, { serverName: "Alpha" });
    area = createSidebarArea(opts());
    document.body.appendChild(area.sidebarWrapper);
  });

  afterEach(() => {
    if (!torn) for (const unsub of area.unsubscribers) unsub();
    area.sidebarWrapper.remove();
    localStorage.clear();
  });

  async function pick(host: string, name: string): Promise<void> {
    area.openQuickSwitch();
    await vi.waitFor(() => expect(createQuickSwitchOverlay).toHaveBeenCalled());
    const { onSwitch } = createQuickSwitchOverlay.mock.calls.at(-1)![0] as { onSwitch: OnSwitch };
    onSwitch(host, name);
  }

  it("asks first and switches on Switch", async () => {
    await pick("b.example", "Beta");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()?.textContent).toContain("Switch to Beta?");
    expect(switchToServer).not.toHaveBeenCalled();
    click("server-switch-confirm");
    expect(switchToServer).toHaveBeenCalledExactlyOnceWith("b.example");
  });

  it("names the server by its address when it has no name", async () => {
    await pick("b.example", "");
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Switch to b.example?"));
    click("server-switch-cancel");
    expect(switchToServer).not.toHaveBeenCalled();
  });

  it("switches straight away when the question is turned off", async () => {
    localStorage.setItem("owncord:settings:confirmServerSwitch", "false");
    await pick("b.example", "Beta");
    expect(switchToServer).toHaveBeenCalledExactlyOnceWith("b.example");
    expect(dialog()).toBeNull();
  });

  it("closes the question without switching when the page goes away", async () => {
    await pick("b.example", "Beta");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const confirm = document.querySelector<HTMLElement>('[data-testid="server-switch-confirm"]')!;
    for (const unsub of area.unsubscribers) unsub();
    torn = true;
    expect(dialog()).toBeNull();
    confirm.click();
    expect(switchToServer).not.toHaveBeenCalled();
  });
});
