import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

// Mock livekitSession before importing streamPreview
const mockGetRemoteVideoStream =
  vi.fn<(uid: number, type: "camera" | "screenshare") => MediaStream | null>();
vi.mock("@lib/livekitSession", () => ({
  getRemoteVideoStream: (uid: number, type: "camera" | "screenshare") =>
    mockGetRemoteVideoStream(uid, type),
  setUserVolume: vi.fn(),
  getUserVolume: vi.fn(() => 1),
}));

vi.mock("@lib/icons", () => ({
  createIcon: (name: string, size: number) => {
    const el = document.createElement("span");
    el.dataset.icon = name;
    el.dataset.size = String(size);
    return el;
  },
}));

import { attachStreamPreview, attachScrollCollapse } from "../../src/lib/streamPreview";

// jsdom doesn't implement HTMLVideoElement.play() — provide a mock
beforeAll(() => {
  HTMLVideoElement.prototype.play = vi.fn(() => Promise.resolve());
});

/** Get the preview sibling div after a row (preview is inserted as next sibling). */
function getPreview(row: HTMLElement): HTMLElement | null {
  const next = row.nextElementSibling;
  return next !== null && next.classList.contains("vu-preview") ? (next as HTMLElement) : null;
}

function createRow(userId: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "voice-user-item";
  row.dataset.voiceUid = String(userId);
  document.body.appendChild(row);
  return row;
}

function createMockMediaStream(trackState: "live" | "ended" = "live"): MediaStream {
  const track = new EventTarget() as MediaStreamTrack;
  Object.defineProperty(track, "readyState", { value: trackState });
  Object.defineProperty(track, "kind", { value: "video" });
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return stream;
}

describe("streamPreview", () => {
  let ac: AbortController;

  beforeEach(() => {
    ac = new AbortController();
    mockGetRemoteVideoStream.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    ac.abort();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  // T3: getRemoteVideoStream room null → null (via mock returning null)
  it("shows placeholder when getRemoteVideoStream returns null", () => {
    mockGetRemoteVideoStream.mockReturnValue(null);
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    const placeholder = getPreview(row)?.querySelector(".vu-preview-placeholder") ?? null;
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain("Join to preview");
  });

  // T7: getRemoteVideoStream success → shows video
  it("shows video when getRemoteVideoStream returns a stream", () => {
    const stream = createMockMediaStream();
    mockGetRemoteVideoStream.mockReturnValue(stream);
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    const video = getPreview(row)?.querySelector("video") ?? null;
    expect(video).not.toBeNull();
    expect(video?.srcObject).toBe(stream);
    expect(video?.muted).toBe(true);
  });

  // T8: Hover creates preview video element
  it("creates .vu-preview container on hover", () => {
    mockGetRemoteVideoStream.mockReturnValue(createMockMediaStream());
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    expect(getPreview(row)).not.toBeNull();
  });

  // T9: Hover with no stream → shows placeholder
  it("shows placeholder with icon and actionable text", () => {
    mockGetRemoteVideoStream.mockReturnValue(null);
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", true, false, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    const placeholder = getPreview(row)?.querySelector(".vu-preview-placeholder") ?? null;
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute("role")).toBe("button");
    expect(placeholder?.getAttribute("aria-label")).toContain("Join channel to preview");
  });

  // T10: Mouseleave removes preview
  it("removes preview on mouseleave after animation", () => {
    mockGetRemoteVideoStream.mockReturnValue(createMockMediaStream());
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(getPreview(row)).not.toBeNull();

    row.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(150 + 200); // 150ms delayed check + 200ms animation

    expect(getPreview(row)).toBeNull();
  });

  // T11: Debounce: rapid hover/unhover → no preview
  it("does not show preview if mouse leaves within debounce period", () => {
    mockGetRemoteVideoStream.mockReturnValue(createMockMediaStream());
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(100); // Only 100ms, below 300ms debounce
    row.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(300);

    expect(getPreview(row)).toBeNull();
  });

  // T13: Track ended → swaps to placeholder
  it("swaps to placeholder when track ends", () => {
    const stream = createMockMediaStream();
    const track = stream.getVideoTracks()[0]!;
    mockGetRemoteVideoStream.mockReturnValue(stream);
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(getPreview(row)?.querySelector("video") ?? null).not.toBeNull();

    // Simulate track ending
    track.dispatchEvent(new Event("ended"));

    expect(getPreview(row)?.querySelector("video") ?? null).toBeNull();
    expect(getPreview(row)?.querySelector(".vu-preview-placeholder") ?? null).not.toBeNull();
  });

  // T15: Focus/blur mirrors hover/leave
  it("shows preview on focusin and hides on focusout", () => {
    mockGetRemoteVideoStream.mockReturnValue(createMockMediaStream());
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new FocusEvent("focusin"));
    vi.advanceTimersByTime(300);
    expect(getPreview(row)).not.toBeNull();

    row.dispatchEvent(new FocusEvent("focusout"));
    vi.advanceTimersByTime(200);
    expect(getPreview(row)).toBeNull();
  });

  // T16: ARIA labels present on video
  it("sets aria-label on video element", () => {
    mockGetRemoteVideoStream.mockReturnValue(createMockMediaStream());
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    const video = getPreview(row)?.querySelector("video") ?? null;
    expect(video?.getAttribute("aria-label")).toBe("Stream preview for Alice");
  });

  // T16b: Screen reader announcement
  it("includes screen reader announcement", () => {
    mockGetRemoteVideoStream.mockReturnValue(createMockMediaStream());
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    const srAnnouncement = getPreview(row)?.querySelector(".sr-only") ?? null;
    expect(srAnnouncement?.textContent).toContain("Showing stream preview for Alice");
  });

  // T17: Camera uses preview-camera class
  it("uses preview-camera class for camera streams", () => {
    mockGetRemoteVideoStream.mockReturnValue(createMockMediaStream());
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    const video = getPreview(row)?.querySelector("video") ?? null;
    expect(video?.className).toBe("preview-camera");
  });

  // T18: Screenshare uses preview-screen class
  it("uses preview-screen class for screenshare streams", () => {
    const stream = createMockMediaStream();
    mockGetRemoteVideoStream.mockImplementation((uid, type) =>
      type === "screenshare" ? stream : null,
    );
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", true, false, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    const video = getPreview(row)?.querySelector("video") ?? null;
    expect(video?.className).toBe("preview-screen");
  });

  // T4+T5+T6: getRemoteVideoStream various null returns → placeholder
  it("tries screenshare first, falls back to camera", () => {
    const cameraStream = createMockMediaStream();
    mockGetRemoteVideoStream.mockImplementation((uid, type) =>
      type === "camera" ? cameraStream : null,
    );
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", true, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    // Should have tried screenshare first, then camera
    expect(mockGetRemoteVideoStream).toHaveBeenCalledWith(42, "screenshare");
    expect(mockGetRemoteVideoStream).toHaveBeenCalledWith(42, "camera");
    // Should show camera stream since screenshare returned null
    const video = getPreview(row)?.querySelector("video") ?? null;
    expect(video?.srcObject).toBe(cameraStream);
    expect(video?.className).toBe("preview-camera");
  });

  // Abort signal cleanup
  it("cleans up on abort signal", () => {
    mockGetRemoteVideoStream.mockReturnValue(createMockMediaStream());
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(getPreview(row)).not.toBeNull();

    ac.abort();
    expect(getPreview(row)).toBeNull();
  });

  // Track mute event → placeholder
  it("swaps to placeholder on track mute event", () => {
    const stream = createMockMediaStream();
    const track = stream.getVideoTracks()[0]!;
    mockGetRemoteVideoStream.mockReturnValue(stream);
    const row = createRow(42);
    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);

    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);

    track.dispatchEvent(new Event("mute"));

    expect(getPreview(row)?.querySelector("video") ?? null).toBeNull();
    expect(getPreview(row)?.querySelector(".vu-preview-placeholder") ?? null).not.toBeNull();
  });
});

describe("attachScrollCollapse", () => {
  let ac: AbortController;

  beforeEach(() => {
    ac = new AbortController();
    vi.useFakeTimers();
    mockGetRemoteVideoStream.mockReset();
  });

  afterEach(() => {
    ac.abort();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  // T14: Scroll collapses open preview
  it("collapses open previews on scroll", () => {
    mockGetRemoteVideoStream.mockReturnValue(createMockMediaStream());

    const container = document.createElement("div");
    container.className = "voice-users-list";
    document.body.appendChild(container);

    const row = createRow(42);
    container.appendChild(row);

    attachStreamPreview(row, 42, "Alice", false, true, ac.signal);
    attachScrollCollapse(container, ac.signal);

    // Show preview
    row.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(getPreview(row)).not.toBeNull();

    // Scroll
    container.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(200);

    expect(getPreview(row)).toBeNull();
  });
});
