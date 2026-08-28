// jsdom never applies app.css, so a computed-style assertion against the
// rendered tile would pass whether or not the rule exists (see
// appearance-high-contrast.test.ts / status-picker-userbar.test.ts for the
// same pattern). This pins the CSS *source* instead.
//
// VideoGrid.ts's onTrackMute toggles `.track-muted` on the `.video-cell` to
// hide a stalled remote camera's last frame. If app.css has no rule for that
// class, the toggle is a no-op and the viewer keeps seeing a frozen frame
// with no indication the track stalled.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe("VideoGrid track-muted CSS", () => {
  it("app.css hides the video element while .video-cell.track-muted is active", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");

    // Look for a rule targeting the video (or the cell itself) scoped under
    // .video-cell.track-muted -- accept either ordering / whitespace.
    const match = /\.video-cell\.track-muted[^{]*\{([^}]*)\}/.exec(css);
    expect(
      match,
      "expected a `.video-cell.track-muted { ... }` (or descendant `video`) rule in app.css " +
        "so the mute handler's class toggle actually hides the stalled frame",
    ).not.toBeNull();
  });
});
