import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const switchVideoDevice = vi.hoisted(() => vi.fn(async () => undefined));
const native = vi.hoisted(() => ({
  cameras: null as { deviceId: string; label: string }[] | null,
}));

vi.mock("@lib/voice/livekitSession", () => ({ switchVideoDevice }));
vi.mock("./native/devices", () => ({ nativeCameraDevices: async () => native.cameras }));

import { showCameraMenu } from "./cameraMenu";

const rows = () => [
  ...document.querySelectorAll<HTMLElement>(".camera-menu [role='menuitemcheckbox']"),
];

let owner: AbortController;
let anchor: HTMLButtonElement;

beforeEach(() => {
  localStorage.clear();
  native.cameras = null;
  switchVideoDevice.mockClear();
  owner = new AbortController();
  anchor = document.createElement("button");
  document.body.appendChild(anchor);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "mic", label: "Mic" },
        { kind: "videoinput", deviceId: "cam-1", label: "Front camera" },
        { kind: "videoinput", deviceId: "cam-2", label: "" },
      ],
    },
  });
});

afterEach(() => {
  owner.abort();
  anchor.remove();
});

describe("showCameraMenu", () => {
  it("lists Default and each camera, the saved one checked", async () => {
    localStorage.setItem("owncord:settings:videoInputDevice", '"cam-1"');
    await showCameraMenu(anchor, owner.signal);
    expect(rows().map((r) => r.textContent)).toEqual(["Default", "Front camera", "Camera 2"]);
    expect(rows().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("switches to the picked camera and closes", async () => {
    await showCameraMenu(anchor, owner.signal);
    rows()[2]!.click();
    expect(switchVideoDevice).toHaveBeenCalledWith("cam-2");
    expect(document.querySelector(".camera-menu")).toBeNull();
  });

  it("uses the native camera list on Linux", async () => {
    native.cameras = [{ deviceId: "/dev/video0", label: "USB cam" }];
    await showCameraMenu(anchor, owner.signal);
    expect(rows().map((r) => r.textContent)).toEqual(["Default", "USB cam"]);
  });

  it("opens nothing once the grid is gone", async () => {
    owner.abort();
    await showCameraMenu(anchor, owner.signal);
    expect(document.querySelector(".camera-menu")).toBeNull();
  });
});
