/**
 * What your screen share is sending, as words: the kind of source ("You're
 * sharing a window") and its name when the capture carries one. Shared by
 * the share card and your own share's tile, so both read the same.
 */
import { voiceText as t } from "../../../i18n/voice";

/** Chromium labels a capture by its id ("screen:0:0", "window:42:0", a tab's
 *  web-contents URL); only a label that is not one names the source. */
const ID_LABEL = /^(screen|window|web-contents-media-stream):/;

export interface ShareSource {
  /** "You're sharing a window / your screen / a browser tab". */
  readonly kind: string;
  /** The window or tab title, or null where the capture names none. */
  readonly name: string | null;
}

export function shareSource(track: MediaStreamTrack | undefined): ShareSource {
  const surface = track?.getSettings?.()?.displaySurface;
  const kind =
    surface === "window"
      ? t("tile.sharingWindow")
      : surface === "browser"
        ? t("tile.sharingTab")
        : t("tile.sharingScreen");
  const label = track?.label ?? "";
  return { kind, name: label === "" || ID_LABEL.test(label) ? null : label };
}

/** The capture's height and frame rate as chip text ("1080p", "30 fps"),
 *  each null where the track does not report it. */
export function shareFormat(track: MediaStreamTrack | undefined): {
  height: string | null;
  fps: string | null;
} {
  const settings = track?.getSettings?.();
  const height = settings?.height;
  const rate = settings?.frameRate;
  return {
    // Plain strings: the catalog would group 1080 as "1,080".
    height: height === undefined ? null : t("tile.qualityHeight", { height: String(height) }),
    fps: rate === undefined ? null : t("card.fps", { fps: String(Math.round(rate)) }),
  };
}
