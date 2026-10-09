import { describe, expect, it } from "vitest";
import { WINDOWS_CDP_ARGUMENTS } from "../e2e/support/artifact-app";

// WebView2 appends this machine-wide policy to the installed binary's own
// arguments, and the update smoke runs the PREVIOUS release under it too
// (see WINDOWS_CDP_ARGUMENTS): a shipped flag copied from this build crashed
// v2.2.0-beta.1, whose --use-fake-ui-for-media-stream Chromium refuses beside
// this build's --auto-accept-camera-and-microphone-capture.
describe("artifact smoke WebView2 policy", () => {
  it("adds only the test's own flags, never a shipped one a baseline could clash with", () => {
    expect(WINDOWS_CDP_ARGUMENTS.split(/\s+/).filter(Boolean)).toEqual([
      "--remote-debugging-port=9222",
      "--use-fake-device-for-media-stream",
    ]);
  });
});
