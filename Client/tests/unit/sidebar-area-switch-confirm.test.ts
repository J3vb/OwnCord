import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    rePinPeerIdentity: vi.fn(),
  }),
);
vi.mock("@lib/net/e2eeCrypto", () => ({
  importIdentityPublicKey: vi.fn(),
  computeKeyFingerprint: vi.fn(),
}));
vi.mock("@lib/presence/profiles", () => ({
  createProfileManager: vi.fn().mockReturnValue({
    loadProfiles: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockReturnValue([]),
    store: { getState: () => ({ profiles: [], healthStatuses: new Map() }) },
  }),
  createTauriBackend: vi.fn().mockReturnValue({}),
}));
vi.mock("@components/UserBar", () => ({
  createUserBar: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));
vi.mock("@components/VoiceWidget", () => ({
  createVoiceWidget: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));
vi.mock("@components/MemberList", () => ({
  createMemberList: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));
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
import { authStore } from "../../src/stores/auth.store";

function opts(): SidebarAreaOptions {
  return {
    ws: { send: vi.fn(), close: vi.fn(), on: vi.fn(), off: vi.fn() } as never,
    api: { getConfig: vi.fn().mockReturnValue({ host: "a.example" }) } as never,
    limiters: {
      voice: { tryConsume: vi.fn().mockReturnValue(true) },
      voiceVideo: { tryConsume: vi.fn().mockReturnValue(true) },
    } as never,
    presenceSender: { send: vi.fn(), rollbackRefused: vi.fn(), destroy: vi.fn() },
    getRoot: vi.fn().mockReturnValue(document.createElement("div")),
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
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
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Member", avatar: null, role: "member" },
      serverName: "Alpha",
      motd: null,
      isAuthenticated: true,
    }));
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
