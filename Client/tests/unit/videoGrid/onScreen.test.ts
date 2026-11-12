// The video grid says when a camera or a stream is on screen, which is what
// keeps the Android app's screen on during a call (features/voice/videoOnScreen.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import {
  createVideoGrid,
  type VideoGridComponent,
} from "../../../src/features/voice/videoGrid/VideoGrid";
import { isVideoOnScreen } from "../../../src/features/voice/videoOnScreen";
import {
  fakeStream,
  makeTileConfig,
  SCREEN_TILE,
  screenTileConfig,
  stubTileSizes,
  tileLookups,
  useVideoGridHarness,
  type TileSizes,
} from "../../helpers/videoGridHarness";

const reports = vi.hoisted(() => ({ sent: [] as boolean[] }));

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("../../../src/features/voice/videoOnScreen", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/features/voice/videoOnScreen")>();
  return {
    ...real,
    reportVideoOnScreen(on: boolean): void {
      reports.sent.push(on);
      real.reportVideoOnScreen(on);
    },
  };
});

describe("VideoGrid: a picture on screen", () => {
  const ME = 1;
  const OTTO = 2;
  const SHOWN: [number, number] = [320, 180];
  const CLOSED: [number, number] = [0, 0];
  let container: HTMLDivElement;
  let grid: VideoGridComponent;
  let resize: TileSizes["resize"];
  const { control } = tileLookups(() => container);

  const harness = useVideoGridHarness((c, g) => {
    container = c;
    grid = g;
  });

  beforeEach(() => {
    grid.destroy?.();
    vi.useFakeTimers();
    ({ resize } = stubTileSizes());
    reports.sent.length = 0;
    grid = harness.adopt(createVideoGrid());
    grid.mount(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const addMe = (): void =>
    grid.addStream(ME, "me (You)", fakeStream(), makeTileConfig({ isSelf: true, audioUserId: ME }));
  const addOtto = (stream: MediaStream | null = fakeStream()): void =>
    grid.addStream(OTTO, "Otto", stream, makeTileConfig({ audioUserId: OTTO }));

  it("holds while a watched stream shows in the open grid, and not once the grid closes", () => {
    addOtto();
    expect(isVideoOnScreen()).toBe(false);

    resize({ [OTTO]: SHOWN });
    expect(isVideoOnScreen()).toBe(true);

    // Back to the chat: the grid's slot is display:none, every tile 0 × 0.
    resize({ [OTTO]: CLOSED });
    expect(isVideoOnScreen()).toBe(false);

    resize({ [OTTO]: SHOWN });
    expect(reports.sent).toEqual([true, false, true]);
  });

  it("counts your own camera with nobody else's picture up", () => {
    addMe();
    resize({ [ME]: SHOWN });
    expect(isVideoOnScreen()).toBe(true);

    resize({ [ME]: CLOSED });
    expect(reports.sent).toEqual([true, false]);
  });

  it("counts your own share's preview, until you hide it", () => {
    const MY_SCREEN = ME + 1_000_000;
    grid.addStream(
      MY_SCREEN,
      "Your Screen",
      fakeStream(),
      makeTileConfig({ isSelf: true, audioUserId: ME, isScreenshare: true }),
    );
    resize({ [MY_SCREEN]: SHOWN });
    expect(isVideoOnScreen()).toBe(true);

    control(MY_SCREEN, "hide-preview").click();
    expect(isVideoOnScreen()).toBe(false);

    control(MY_SCREEN, "watch").click();
    expect(reports.sent).toEqual([true, false, true]);
  });

  it("does not count a stream behind Watch stream, until it is watched", () => {
    addOtto(null);
    resize({ [OTTO]: SHOWN });
    expect(isVideoOnScreen()).toBe(false);

    // Watching subscribes; the stream then arrives on the same tile.
    addOtto();
    expect(isVideoOnScreen()).toBe(true);

    control(OTTO, "stop").click();
    expect(reports.sent).toEqual([true, false]);
  });

  it("reports one change while several pictures come and go", () => {
    addMe();
    addOtto();
    resize({ [ME]: SHOWN, [OTTO]: SHOWN });
    grid.removeStream(OTTO);
    expect(isVideoOnScreen()).toBe(true);

    // The last picture leaves with its tile: nothing is left to resize.
    grid.removeStream(ME);
    expect(reports.sent).toEqual([true, false]);
  });

  it("lets go as soon as a watched screen share ends, while its tile still says so", () => {
    grid.addStream(SCREEN_TILE, "Otto (Screen)", fakeStream(), screenTileConfig());
    resize({ [SCREEN_TILE]: SHOWN });
    expect(isVideoOnScreen()).toBe(true);

    grid.removeStream(SCREEN_TILE);

    expect(container.querySelector(".video-ended")).not.toBeNull();
    expect(isVideoOnScreen()).toBe(false);
  });

  it("lets go when the call's streams are cleared, and when the grid is destroyed", () => {
    addOtto();
    resize({ [OTTO]: SHOWN });
    grid.clearStreams();
    expect(isVideoOnScreen()).toBe(false);

    addOtto();
    resize({ [OTTO]: SHOWN });
    expect(isVideoOnScreen()).toBe(true);
    grid.destroy?.();
    expect(reports.sent).toEqual([true, false, true, false]);
  });

  it("holds for a stream kept in the mini-player while the grid is closed", async () => {
    vi.useRealTimers();
    addOtto();
    grid.showMiniPlayer();
    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid='stream-mini-player']")).not.toBeNull(),
    );
    // No tile has a size here: the grid is closed, the stream plays in the mini-player.
    expect(isVideoOnScreen()).toBe(true);

    grid.hideMiniPlayer();
    expect(reports.sent).toEqual([true, false]);
  });
});
