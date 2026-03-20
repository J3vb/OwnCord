import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockVoiceStoreGetState, mockGetLocalCameraStream } = vi.hoisted(() => ({
  mockVoiceStoreGetState: vi.fn(),
  mockGetLocalCameraStream: vi.fn((): MediaStream | null => null),
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: { getState: mockVoiceStoreGetState },
}));

vi.mock("@lib/voiceSession", () => ({
  getLocalCameraStream: mockGetLocalCameraStream,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createVideoModeController } from "../../src/pages/main-page/VideoModeController";
import type { VideoModeControllerOptions } from "../../src/pages/main-page/VideoModeController";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlots() {
  return {
    messagesSlot: document.createElement("div"),
    typingSlot: document.createElement("div"),
    inputSlot: document.createElement("div"),
    videoGridSlot: document.createElement("div"),
  };
}

function makeVideoGrid(): VideoModeControllerOptions["videoGrid"] {
  return {
    mount: vi.fn(),
    destroy: vi.fn(),
    addStream: vi.fn(),
    removeStream: vi.fn(),
  } as unknown as VideoModeControllerOptions["videoGrid"];
}

interface VoiceStateStub {
  currentChannelId: number | null;
  localCamera: boolean;
  localScreenshare: boolean;
  voiceUsers: Map<number, Map<number, { userId: number; camera: boolean; username: string }>>;
}

function makeVoiceState(overrides: Partial<VoiceStateStub> = {}): VoiceStateStub {
  return {
    currentChannelId: null,
    localCamera: false,
    localScreenshare: false,
    voiceUsers: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createVideoModeController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoiceStoreGetState.mockReturnValue(makeVoiceState());
    mockGetLocalCameraStream.mockReturnValue(null);
  });

  it("starts in chat mode", () => {
    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("stays in chat mode when no voice channel", () => {
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("switches to video when any camera is on", () => {
    const users = new Map([[2, { userId: 2, camera: true, username: "bob" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
    );

    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    expect(ctrl.isVideoMode()).toBe(true);
    expect(slots.messagesSlot.style.display).toBe("none");
    expect(slots.videoGridSlot.style.display).toBe("block");
  });

  it("switches back to chat when all cameras off", () => {
    const users = new Map([[2, { userId: 2, camera: true, username: "bob" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
    );

    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();
    expect(ctrl.isVideoMode()).toBe(true);

    // All cameras off
    users.set(2, { userId: 2, camera: false, username: "bob" });
    ctrl.checkVideoMode();
    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.messagesSlot.style.display).toBe("");
  });

  it("detects local camera as reason to show video", () => {
    const users = new Map([[1, { userId: 1, camera: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();
    expect(ctrl.isVideoMode()).toBe(true);
  });

  it("adds local self-view tile when local camera is on", () => {
    const fakeStream = {} as MediaStream;
    mockGetLocalCameraStream.mockReturnValue(fakeStream);
    const users = new Map([[1, { userId: 1, camera: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    expect(vg.addStream).toHaveBeenCalledWith(1, "me (You)", fakeStream);
  });

  it("removes local tile when local camera is off", () => {
    const users = new Map([[1, { userId: 1, camera: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localCamera: false,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    expect(vg.removeStream).toHaveBeenCalledWith(1);
  });

  it("removes remote tile when remote user turns off camera", () => {
    const users = new Map([
      [1, { userId: 1, camera: false, username: "me" }],
      [2, { userId: 2, camera: false, username: "bob" }],
    ]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    expect(vg.removeStream).toHaveBeenCalledWith(2);
  });

  it("showChat switches back to chat mode", () => {
    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.showVideoGrid();
    expect(ctrl.isVideoMode()).toBe(true);

    ctrl.showChat();
    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.videoGridSlot.style.display).toBe("none");
  });

  it("destroy resets video mode state and restores DOM", () => {
    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.showVideoGrid();
    expect(ctrl.isVideoMode()).toBe(true);
    expect(slots.messagesSlot.style.display).toBe("none");

    ctrl.destroy();
    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.messagesSlot.style.display).toBe("");
    expect(slots.videoGridSlot.style.display).toBe("none");
  });
});
