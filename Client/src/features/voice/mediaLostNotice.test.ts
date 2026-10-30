import { describe, it, expect, vi, beforeEach } from "vitest";

const showActionToast = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ui/toast", () => ({ showActionToast }));

import {
  dismissMediaLostNotice,
  restoreLostMedia,
  showMediaLostNotice,
  type RestoreMedia,
} from "./mediaLostNotice";

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

describe("restoreLostMedia", () => {
  let on: { camera: boolean; screenshare: boolean };
  let current: boolean;
  let r: RestoreMedia & {
    enableCamera: ReturnType<typeof vi.fn>;
    restartScreenshare: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    showActionToast.mockReset();
    on = { camera: false, screenshare: false };
    current = true;
    r = {
      isOn: (kind) => on[kind],
      enableCamera: vi.fn(async () => {
        on.camera = true;
      }),
      restartScreenshare: vi.fn(async () => false),
      stillCurrent: () => current,
      turnOn: { camera: vi.fn(), screenshare: vi.fn() },
    };
  });

  it("turns the camera back on with no toast", async () => {
    await restoreLostMedia({ camera: true, screenshare: false }, r);
    expect(r.enableCamera).toHaveBeenCalledOnce();
    expect(showActionToast).not.toHaveBeenCalled();
  });

  it("offers Share again when the share cannot restart by itself", async () => {
    await restoreLostMedia({ camera: false, screenshare: true }, r);
    expect(r.restartScreenshare).toHaveBeenCalledOnce();
    expect(lastCall().message).toBe("Your screen share stopped when the connection dropped");
    expect(lastCall().action.label).toBe("Share again");
  });

  it("shows nothing when the share restarted (Linux, source still there)", async () => {
    r.restartScreenshare.mockResolvedValue(true);
    await restoreLostMedia({ camera: false, screenshare: true }, r);
    expect(showActionToast).not.toHaveBeenCalled();
  });

  it("leaves media the user already turned back on alone", async () => {
    on = { camera: true, screenshare: true };
    await restoreLostMedia({ camera: true, screenshare: true }, r);
    expect(r.enableCamera).not.toHaveBeenCalled();
    expect(r.restartScreenshare).not.toHaveBeenCalled();
    expect(showActionToast).not.toHaveBeenCalled();
  });

  it("stops once the call ended during the camera restart", async () => {
    r.enableCamera.mockImplementation(async () => {
      current = false;
    });
    await restoreLostMedia({ camera: true, screenshare: true }, r);
    expect(r.restartScreenshare).not.toHaveBeenCalled();
    expect(showActionToast).not.toHaveBeenCalled();
  });

  it("dismissMediaLostNotice removes the toast once", async () => {
    const remove = vi.fn();
    showActionToast.mockReturnValueOnce(remove);
    await restoreLostMedia({ camera: false, screenshare: true }, r);
    dismissMediaLostNotice();
    dismissMediaLostNotice();
    expect(remove).toHaveBeenCalledOnce();
  });
});
