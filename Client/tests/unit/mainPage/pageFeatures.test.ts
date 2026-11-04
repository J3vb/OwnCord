// MainPage starts its features and session slots from lists. These pin the
// two ways a list entry can go wrong: a feature whose chunk lands after the
// page is gone, and a slot left pointing at a dead session.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageState } from "../../../src/pages/main-page/pageState";

const startMuteExpiryWatch = vi.fn(() => () => {});
const startUnreadBadge = vi.fn(() => () => {});
const stopVoiceSounds = vi.fn();

vi.mock("@lib/prefs/channelMuteExpiry", () => ({ startMuteExpiryWatch }));
vi.mock("../../../src/features/unread-badge/unreadBadge", () => ({
  startUnreadBadge,
  startNotificationClearing: vi.fn(() => () => {}),
  askNotificationPermissionOnce: vi.fn(async () => {}),
}));
vi.mock("../../../src/features/voice/uiSounds", () => ({
  startVoiceUiSounds: () => stopVoiceSounds,
}));

const { backgroundFeatures } = await import("../../../src/pages/main-page/pageFeatures");
const { sessionHooks } = await import("../../../src/pages/main-page/sessionHooks");
const { getActivePresenceSender } = await import("../../../src/lib/presence/presence");
const { getScreenSourcePicker } =
  await import("../../../src/features/voice/native/screenPickerSlot");
const { currentNotesContext } = await import("../../../src/features/profiles/userNotes");

function pageState(): PageState {
  return {
    tornDown: false,
    unsubscribers: [],
    children: [],
    ws: { send: vi.fn() },
    api: { getReactionUsers: vi.fn() },
    apiConfig: { host: "example.test" },
    presenceSender: { destroy: vi.fn(), send: vi.fn(), rollbackRefused: vi.fn() },
  } as unknown as PageState;
}

describe("page features", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a feature whose chunk loads after teardown starts nothing", async () => {
    const st = pageState();
    const root = document.createElement("div");
    for (const start of backgroundFeatures) start(st, root);
    // The synchronous voice sounds start at once; the lazy ones are in flight.
    expect(st.unsubscribers).toEqual([stopVoiceSounds]);

    st.tornDown = true;
    await vi.dynamicImportSettled();

    expect(startMuteExpiryWatch).not.toHaveBeenCalled();
    expect(startUnreadBadge).not.toHaveBeenCalled();
    expect(st.unsubscribers).toEqual([stopVoiceSounds]);
  });

  it("a live page keeps the stopper of every lazy feature", async () => {
    const st = pageState();
    for (const start of backgroundFeatures) start(st, document.createElement("div"));
    await vi.dynamicImportSettled();
    expect(startMuteExpiryWatch).toHaveBeenCalledOnce();
    expect(startUnreadBadge).toHaveBeenCalledOnce();
  });
});

describe("session hooks", () => {
  it("names each hook once", () => {
    const names = sessionHooks.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uninstall clears the presence, screen picker and notes slots", () => {
    const st = pageState();
    for (const hook of sessionHooks) hook.install(st);
    expect(getActivePresenceSender()).toBe(st.presenceSender);
    expect(getScreenSourcePicker()).not.toBeNull();

    for (const hook of sessionHooks) hook.uninstall(st);
    expect(getActivePresenceSender()).toBeNull();
    expect(getScreenSourcePicker()).toBeNull();
    expect(currentNotesContext()).toBeNull();
    expect(st.presenceSender.destroy).toHaveBeenCalledOnce();
  });
});
