import { describe, it, expect, vi, beforeEach } from "vitest";

const showActionToast = vi.hoisted(() => vi.fn());
vi.mock("@lib/toast", () => ({ showActionToast }));

import { showMediaLostNotice } from "./mediaLostNotice";

type Action = { label: string; run: () => void };

function lastCall(): { message: string; type: string; action: Action; duration: number } {
  const [message, type, action, duration] = showActionToast.mock.calls.at(-1)!;
  return { message, type, action, duration };
}

describe("showMediaLostNotice", () => {
  const camera = vi.fn();
  const screenshare = vi.fn();

  beforeEach(() => {
    showActionToast.mockClear();
    camera.mockClear();
    screenshare.mockClear();
  });

  it("shows nothing when neither was on", () => {
    showMediaLostNotice({ camera: false, screenshare: false }, { camera, screenshare });
    expect(showActionToast).not.toHaveBeenCalled();
  });

  it("names the camera and turns only the camera back on", () => {
    showMediaLostNotice({ camera: true, screenshare: false }, { camera, screenshare });
    const call = lastCall();
    expect(call.message).toBe("Your camera stopped when the connection dropped");
    expect(call.type).toBe("warning");
    expect(call.duration).toBe(Infinity);
    expect(call.action.label).toBe("Turn on again");
    call.action.run();
    expect(camera).toHaveBeenCalledOnce();
    expect(screenshare).not.toHaveBeenCalled();
  });

  it("names the screen share and offers Share again", () => {
    showMediaLostNotice({ camera: false, screenshare: true }, { camera, screenshare });
    const call = lastCall();
    expect(call.message).toBe("Your screen share stopped when the connection dropped");
    expect(call.action.label).toBe("Share again");
    call.action.run();
    expect(screenshare).toHaveBeenCalledOnce();
    expect(camera).not.toHaveBeenCalled();
  });

  it("names both and turns both back on", () => {
    showMediaLostNotice({ camera: true, screenshare: true }, { camera, screenshare });
    const call = lastCall();
    expect(call.message).toBe("Your camera and screen share stopped when the connection dropped");
    expect(call.action.label).toBe("Turn on again");
    call.action.run();
    expect(camera).toHaveBeenCalledOnce();
    expect(screenshare).toHaveBeenCalledOnce();
  });
});
