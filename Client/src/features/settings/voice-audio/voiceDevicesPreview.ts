/**
 * Voice settings: filling the device lists and keeping them current, device
 * changes, and the camera preview (web and Linux native).
 */
import { createElement, setText, setOwnedTimeout } from "@lib/dom";
import { loadPref, savePref } from "../helpers";
import { syncVideoSurface } from "@lib/voice/videoSurface";
import {
  switchInputDevice,
  switchOutputDevice,
  switchVideoDevice,
  getLocalMicSettings,
} from "@lib/voice/livekitSession";
import {
  nativeAudioDevices,
  nativeCameraDevices,
  nativeCameraSupport,
  onNativeDevicesChanged,
} from "../../voice/native/devices";
import { isLinuxDesktop } from "../../voice/native/platform";
import { desktop } from "../../../platform/desktop";
import { NativeVideoRenderer } from "../../voice/native/videoRenderer";
import { settingsText as t } from "../../../i18n/settings";
import {
  isRealInput,
  applyMicTestSink,
  DEVICE_MANAGER_SETTLE_MS,
  PREVIEW_RESTART_MS,
} from "./voiceTabShared";
import type { VoiceTabScope } from "./voiceTabScope";

export function mountDevicesAndPreview(sc: VoiceTabScope): void {
  // Device names seen while this tab is open, to name one that is unplugged.
  sc.deviceLabels = new Map<string, string>();

  /**
   * (Re)fill the three device dropdowns from the current device list.
   *
   * Called on build and again on every `devicechange`, so unplugging a headset
   * with the panel open removes it from the list instead of leaving a dead
   * entry the user can select. A saved microphone or speaker that has vanished
   * stays the selection as a disabled "(disconnected)" entry: the voice
   * session keeps it too and switches back to it when it returns. A
   * vanished camera reads as "Default".
   */
  sc.populateDevices = async function populateDevices(): Promise<void> {
    const selects: Array<[HTMLSelectElement, MediaDeviceKind, string, string]> = [
      [sc.inputSelect, "audioinput", "audioInputDevice", t("voiceAudio.kind.microphone")],
      [sc.outputSelect, "audiooutput", "audioOutputDevice", t("voiceAudio.kind.speaker")],
      [sc.videoSelect, "videoinput", "videoInputDevice", t("voiceAudio.kind.camera")],
    ];
    try {
      // On Linux the audio and camera lists come from the native backend (the
      // ids the session can actually select); elsewhere cameras are the
      // webview's, enumerated with the audio devices.
      const [nativeInputs, nativeOutputs, nativeCameras, all] = await Promise.all([
        nativeAudioDevices("audioinput"),
        nativeAudioDevices("audiooutput"),
        nativeCameraDevices(),
        navigator.mediaDevices.enumerateDevices(),
      ]);
      const devices =
        nativeInputs === null || nativeOutputs === null
          ? all
          : [
              ...nativeInputs,
              ...nativeOutputs,
              ...(nativeCameras ?? all.filter((d) => d.kind === "videoinput")),
            ];
      if (sc.signal.aborted) return;

      for (const [select, kind, prefKey, label] of selects) {
        const saved = loadPref<string>(prefKey, "");
        // Keep the leading "Default" option, replace the rest.
        while (select.options.length > 1) select.remove(1);
        let savedStillPresent = false;
        // Without a media permission the webview hides the list behind one
        // nameless entry per kind, so whether the saved device is here is unknown.
        let hidden = false;
        for (const d of devices) {
          if (d.kind !== kind) continue;
          if (d.deviceId === "") {
            hidden = true;
            continue;
          }
          if (d.deviceId === saved) savedStillPresent = true;
          const name = d.label || `${label} (${d.deviceId.slice(0, 8)})`;
          sc.deviceLabels.set(d.deviceId, name);
          select.appendChild(createElement("option", { value: d.deviceId }, name));
        }
        const keepSaved = savedStillPresent || kind !== "videoinput";
        if (saved !== "" && !savedStillPresent && keepSaved) {
          const device = sc.deviceLabels.get(saved) ?? `${label} (${saved.slice(0, 8)})`;
          select.appendChild(
            hidden
              ? createElement("option", { value: saved }, device)
              : createElement(
                  "option",
                  { value: saved, disabled: "" },
                  t("voiceAudio.deviceDisconnected", { device }),
                ),
          );
        }
        select.value = keepSaved ? saved : "";
      }
      // "Default" is a preference; name the device the call really captures,
      // which can lag the system default after an unplug and replug. Only a
      // web room has a mic track to read, so the list is the webview's.
      const live = loadPref<string>("audioInputDevice", "") === "" ? getLocalMicSettings() : null;
      const liveDevice =
        live === null
          ? undefined
          : (all.find((d) => isRealInput(d) && d.deviceId === live.deviceId) ??
            all.find((d) => isRealInput(d) && d.groupId !== "" && d.groupId === live.groupId));
      setText(
        sc.defaultInputOpt,
        liveDevice?.label
          ? t("voiceAudio.defaultLive", { device: liveDevice.label })
          : t("voiceAudio.default"),
      );
    } catch {
      const errOpt = createElement(
        "option",
        { value: "", disabled: "" },
        t("voiceAudio.enumerateFailed"),
      );
      sc.inputSelect.appendChild(errOpt);
    }
  };

  void sc.populateDevices();

  sc.onDeviceChange = (): void => {
    void sc.populateDevices();
    // The session moves the capture after its own debounce; re-read then.
    setOwnedTimeout(sc.signal, () => void sc.populateDevices(), DEVICE_MANAGER_SETTLE_MS);
  };

  // MediaDevices is an EventTarget everywhere this ships, but a webview that
  // exposes enumerateDevices without the event target shouldn't take the tab
  // down with it — it just loses live refresh.
  if (typeof navigator.mediaDevices?.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", sc.onDeviceChange, {
      signal: sc.signal,
    });
  }

  // On Linux the host's hot-plug watch is the trigger (null elsewhere); it
  // also starts the watch, so the lists stay live outside a call.
  // Released through cleanupMic (a rebuild or the overlay closing), not an
  // "abort" listener: build() runs again on every rebuild.
  sc.stopNative = onNativeDevicesChanged(sc.onDeviceChange);

  if (sc.stopNative !== null) sc.registerNativeDevices(sc.stopNative);

  sc.inputSelect.addEventListener(
    "change",
    () => {
      savePref("audioInputDevice", sc.inputSelect.value);
      sc.updateNativeTest({ kind: "inputDevice", deviceId: sc.inputSelect.value });
      const switched = switchInputDevice(sc.inputSelect.value);
      sc.restartMeterAfter(switched);
      void switched.then(sc.populateDevices, sc.populateDevices);
    },
    { signal: sc.signal },
  );

  sc.outputSelect.addEventListener(
    "change",
    () => {
      savePref("audioOutputDevice", sc.outputSelect.value);
      sc.updateNativeTest({ kind: "outputDevice", deviceId: sc.outputSelect.value });
      void switchOutputDevice(sc.outputSelect.value);
      if (sc.micTestAudio !== null) applyMicTestSink(sc.micTestAudio);
    },
    { signal: sc.signal },
  );

  // Race guard: prevent stale getUserMedia results from overwriting a newer
  // request. cleanupMic() invalidates both counters, so a stream resolving
  // after teardown is stopped instead of re-arming state nobody cleans up.
  sc.cameraRequestId = 0;

  sc.micRequestId = 0;

  sc.registerCameraInvalidation(() => {
    sc.cameraRequestId += 1;
    sc.micRequestId += 1;
    // Detach the preview too: Chrome keeps a detached media element that
    // still has a source among its pending activities, and it holds the whole
    // torn-down pane alive with it. Stopping the tracks does not release it.
    sc.previewVideo.srcObject = null;
    syncVideoSurface(sc.previewVideo);
  });

  sc.stopCameraPreview = function stopCameraPreview(): void {
    sc.cameraRequestId += 1;
    sc.registerCamera(null);
    sc.previewVideo.srcObject = null;
    syncVideoSurface(sc.previewVideo);
    setText(sc.previewLabel, t("voiceAudio.previewOff"));
    sc.previewLabel.hidden = false;
  };

  sc.startCameraPreview = function startCameraPreview(deviceId: string): void {
    sc.stopCameraPreview();
    const thisRequest = ++sc.cameraRequestId;
    void (async () => {
      try {
        const constraints: MediaStreamConstraints = {
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 320 }, height: { ideal: 180 } }
            : { width: { ideal: 320 }, height: { ideal: 180 } },
          audio: false,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        // Race guard: if a newer request was issued while we awaited, discard this result
        if (sc.signal.aborted || thisRequest !== sc.cameraRequestId) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        sc.registerCamera(stream);
        sc.previewVideo.srcObject = stream;
        sc.previewLabel.hidden = true;
      } catch (err) {
        if (sc.signal.aborted || thisRequest !== sc.cameraRequestId) return;
        const msg =
          err instanceof Error && err.message ? err.message : t("voiceAudio.cameraUnavailable");
        setText(sc.previewLabel, msg);
      }
    })();
  };

  sc.previewDevice = function previewDevice(deviceId: string): void {
    sc.stopCameraPreview();
    sc.stopNativeCameraPreview();
    if (isLinuxDesktop()) void sc.startNativeCameraPreview(deviceId);
    else sc.startCameraPreview(deviceId);
  };

  sc.videoSelect.addEventListener(
    "change",
    () => {
      const picked = sc.videoSelect.value;
      void switchVideoDevice(picked).then(() => {
        // The live camera could not use the pick and stayed on its device:
        // show that one again.
        const kept = loadPref<string>("videoInputDevice", "");
        if (sc.signal.aborted || kept === picked || sc.videoSelect.value !== picked) return;
        sc.videoSelect.value = kept;
        sc.previewDevice(kept);
      });
      sc.previewDevice(picked);
    },
    { signal: sc.signal },
  );

  // Start the camera preview on the saved device, or on the default when
  // none was explicitly chosen: an unexplained empty 16:9 box reads as broken
  // (voice #22). The default device is only previewed when a camera exists.
  // Linux previews through the native backend (the native camera list); its
  // preview renderer is registered so teardown releases the host capture.
  sc.savedVideoDevice = loadPref<string>("videoInputDevice", "");

  sc.activeNativePreview = null;

  void (async () => {
    const device = sc.savedVideoDevice;
    if (isLinuxDesktop()) {
      // The discovery awaits must not outlive a newer request: if the user
      // picks a camera while they are pending, that choice owns the preview.
      const thisRequest = sc.cameraRequestId;
      try {
        // GStreamer may be missing entirely: no capture can start, so explain why
        // instead of leaving the preview box empty or showing a generic error.
        const support = await nativeCameraSupport();
        if (sc.signal.aborted || thisRequest !== sc.cameraRequestId) return;
        if (support !== null && !support.available) {
          setText(sc.previewLabel, t("voiceAudio.gstreamerMissing"));
          sc.previewLabel.hidden = false;
          return;
        }
        const cameras = await nativeCameraDevices();
        if (sc.signal.aborted || thisRequest !== sc.cameraRequestId) return;
        if (cameras !== null && cameras.length === 0) {
          setText(sc.previewLabel, t("voiceAudio.noCamera"));
          sc.previewLabel.hidden = false;
          return;
        }
        await sc.startNativeCameraPreview(device);
      } catch {
        // A failed support/device query must still explain itself, not leave
        // the preview box in its default empty state.
        if (sc.signal.aborted || thisRequest !== sc.cameraRequestId) return;
        setText(sc.previewLabel, t("voiceAudio.cameraUnavailable"));
        sc.previewLabel.hidden = false;
      }
      return;
    }
    if (device === "" && navigator.mediaDevices?.enumerateDevices !== undefined) {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (!devices.some((d) => d.kind === "videoinput")) {
        setText(sc.previewLabel, t("voiceAudio.noCamera"));
        return;
      }
    }
    sc.startCameraPreview(device);
  })();

  /** The Linux settings preview: capture natively (works while the window is
   *  hidden and exposes the same device ids the call will select) and draw the
   *  frame socket's `/camera` route onto the preview canvas. */
  sc.startNativeCameraPreview = async function startNativeCameraPreview(
    deviceId: string,
  ): Promise<void> {
    sc.stopNativeCameraPreview();
    const thisRequest = ++sc.cameraRequestId;
    try {
      const started = await desktop.nativeVoice.startCameraPreview(deviceId, {
        fps: 15,
        maxWidth: 320,
        maxHeight: 180,
      });
      if (sc.signal.aborted) {
        // The tab was torn down while this start was in flight; cleanupMic
        // found no registered preview to release, so release this capture
        // here. The backend has no newer start to protect.
        void desktop.nativeVoice.stopCameraPreview().catch(() => {});
        return;
      }
      if (thisRequest !== sc.cameraRequestId) {
        // A newer request owns the single native preview slot: it has already
        // replaced this capture, so this request disowns it and reclaims
        // nothing (stopping here would release the newer preview's capture).
        return;
      }
      // The host closes the socket when the camera's owner changes: the
      // call's camera turned on (it takes the device) or off, or the call
      // ended. Start again, which shows whichever capture owns the camera now.
      const renderer = new NativeVideoRenderer(`${started.frames}/camera`, () => {
        if (sc.activeNativePreview !== stop) return;
        const closedAt = sc.cameraRequestId;
        renderer.dispose();
        sc.activeNativePreview = null;
        sc.registerNativePreview(() => {});
        sc.previewVideo.srcObject = null;
        syncVideoSurface(sc.previewVideo);
        setOwnedTimeout(
          sc.signal,
          () => {
            // A camera picked meanwhile already started its own preview.
            if (sc.cameraRequestId === closedAt)
              void sc.startNativeCameraPreview(sc.videoSelect.value);
          },
          PREVIEW_RESTART_MS,
        );
      });
      const stream = new MediaStream([renderer.mediaStreamTrack]);
      sc.registerCamera(stream);
      sc.previewVideo.srcObject = stream;
      syncVideoSurface(sc.previewVideo);
      sc.previewLabel.hidden = true;
      const stop = (): void => {
        renderer.dispose();
        void desktop.nativeVoice.stopCameraPreview().catch(() => {});
      };
      sc.activeNativePreview = stop;
      sc.registerNativePreview(stop);
    } catch (err) {
      if (sc.signal.aborted || thisRequest !== sc.cameraRequestId) return;
      // This request is still the current one and owns the single native
      // preview slot: a failed start may have left a superseded request's
      // capture running there with no renderer, so release it now.
      if (sc.activeNativePreview === null)
        void desktop.nativeVoice.stopCameraPreview().catch(() => {});
      const msg =
        err instanceof Error && err.message ? err.message : t("voiceAudio.cameraUnavailable");
      setText(sc.previewLabel, msg);
    }
  };

  sc.stopNativeCameraPreview = function stopNativeCameraPreview(): void {
    if (sc.activeNativePreview === null) return;
    sc.activeNativePreview();
    sc.activeNativePreview = null;
    sc.registerNativePreview(() => {});
    sc.previewVideo.srcObject = null;
    syncVideoSurface(sc.previewVideo);
  };
}
