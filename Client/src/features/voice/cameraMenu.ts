// The camera picker behind the arrow beside Camera in the call bar.
// Loaded on demand, so it stays out of the eager MainPage chunk.
import { showContextMenu } from "@lib/context-menu";
import { createIcon } from "@lib/icons";
import { loadPref } from "@lib/preferences";
import { createElement } from "@lib/dom";
import { switchVideoDevice } from "@lib/livekitSession";
import { createLogger } from "@lib/logger";
import { nativeCameraDevices } from "./native/devices";
import { voiceText as t } from "../../i18n/voice";

const log = createLogger("cameraMenu");

/** The cameras to offer: the native list on Linux, the webview's elsewhere. */
async function listCameras(): Promise<{ deviceId: string; label: string }[]> {
  const native = await nativeCameraDevices();
  if (native !== null) return native;
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput" && d.deviceId !== "");
}

/** Open the camera list above `anchor`, the picked one checked. */
export async function showCameraMenu(anchor: HTMLElement, signal: AbortSignal): Promise<void> {
  let cameras: { deviceId: string; label: string }[] = [];
  try {
    cameras = await listCameras();
  } catch (err) {
    log.warn("Camera list failed", err);
  }
  if (signal.aborted || !anchor.isConnected) return;
  const current = loadPref<string>("videoInputDevice", "");
  const choices = [
    { deviceId: "", label: t("call.defaultCamera") },
    ...cameras.map((c, i) => ({
      deviceId: c.deviceId,
      label: c.label || t("call.cameraNumber", { n: i + 1 }),
    })),
  ];
  const rect = anchor.getBoundingClientRect();
  showContextMenu({
    x: rect.left,
    y: rect.top,
    signal,
    className: "camera-menu",
    items: choices.map((c, i) => ({
      label: c.label,
      testId: `camera-device-${i}`,
      onClick: () => void switchVideoDevice(c.deviceId),
    })),
  });
  choices.forEach((c, i) => {
    const item = document.querySelector<HTMLElement>(`[data-testid="camera-device-${i}"]`);
    if (item === null) return;
    const on = c.deviceId === current;
    item.setAttribute("role", "menuitemcheckbox");
    item.setAttribute("aria-checked", String(on));
    item.style.display = "flex";
    item.style.gap = "8px";
    const check = createElement("span", {
      "aria-hidden": "true",
      style: `margin-left:auto;display:inline-flex;visibility:${on ? "visible" : "hidden"}`,
    });
    check.appendChild(createIcon("check", 14));
    item.appendChild(check);
  });
}
