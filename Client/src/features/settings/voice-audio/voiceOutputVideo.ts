/**
 * Voice settings: the speakers card (output device and volume) and the camera
 * card's quality, frame rate, camera, auto-play, preview and codec controls.
 */
import { createElement, appendChildren, setText } from "@lib/dom";
import { loadPref, savePref, createToggle } from "../helpers";
import { SHARE_FPS_OPTIONS, offeredShareFps } from "@lib/voice/shareFps";
import { AUTO_PLAY_CAMERAS_PREF, autoPlayCameras } from "../../voice/autoPlayCameras";
import {
  MIRROR_SELF_CAMERA_PREF,
  applyMirrorSelfCamera,
  mirrorSelfCamera,
} from "@lib/prefs/appearance";
import { setOutputVolume } from "@lib/voice/livekitSession";
import { isLinuxDesktop } from "../../voice/native/platform";
import {
  getVideoCodecPref,
  h264Offered,
  h265Offered,
  vp9Available,
  vp9Offered,
} from "../../voice/videoCodec";
import { settingsText as t } from "../../../i18n/settings";
import { micTestVolume } from "./voiceTabShared";
import type { VoiceTabScope } from "./voiceTabScope";

export function mountOutputAndVideo(sc: VoiceTabScope): void {
  // Output device selector
  sc.outputHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.outputDevice"),
  );

  sc.outputSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
    "aria-label": t("voiceAudio.outputDevice"),
  });

  sc.defaultOutputOpt = createElement("option", { value: "" }, t("voiceAudio.default"));

  sc.outputSelect.appendChild(sc.defaultOutputOpt);

  if (!sc.android) sc.speakersCard.append(sc.outputHeader, sc.outputSelect);

  // Output Volume slider
  sc.outputVolumeHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.outputVolume"),
  );

  sc.speakersCard.appendChild(sc.outputVolumeHeader);

  sc.outputVolumeRow = createElement("div", { class: "slider-row" });

  sc.storedOutputVolume = loadPref<number>("outputVolume", 100);

  sc.savedOutputVolume = Number.isFinite(sc.storedOutputVolume)
    ? Math.max(0, Math.min(200, sc.storedOutputVolume))
    : 100;

  sc.outputVolumeSlider = createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: "200",
    step: "1",
    value: String(sc.savedOutputVolume),
    "aria-label": t("voiceAudio.outputVolume"),
  });

  sc.outputVolumeLabel = createElement("span", { class: "slider-val" }, `${sc.savedOutputVolume}%`);

  sc.outputVolumeSlider.addEventListener(
    "input",
    () => {
      const val = Number(sc.outputVolumeSlider.value);
      setText(sc.outputVolumeLabel, `${val}%`);
      setOutputVolume(val);
      if (sc.micTestAudio !== null) sc.micTestAudio.volume = micTestVolume(val);
      sc.updateNativeTest({ kind: "outputGain", gain: micTestVolume(val) });
    },
    { signal: sc.signal },
  );

  appendChildren(sc.outputVolumeRow, sc.outputVolumeSlider, sc.outputVolumeLabel);

  sc.speakersCard.appendChild(sc.outputVolumeRow);

  // Camera and screen share quality selectors: separate prefs, because a
  // screen share is mostly text and a camera is mostly motion.
  sc.qualityGroup = function qualityGroup(
    label: string,
    desc: string,
    pref: string,
    saved: string,
    options: Array<[string, string]>,
    /** Option values shown but not selectable. */
    disabled: ReadonlySet<string> = new Set(),
  ): HTMLElement[] {
    const header = createElement("div", { class: "settings-field-label" }, label);
    const description = createElement("p", { class: "setting-desc" }, desc);
    const select = createElement("select", {
      class: "form-input",
      style: "width:100%;margin-bottom:16px",
      "aria-label": label,
    });
    for (const [value, text] of options) {
      const opt = createElement("option", { value }, text);
      if (value === saved) opt.setAttribute("selected", "");
      if (disabled.has(value)) opt.disabled = true;
      select.appendChild(opt);
    }
    select.value = saved;
    select.addEventListener(
      "change",
      () => {
        savePref(pref, select.value);
      },
      { signal: sc.signal },
    );
    return [header, description, select];
  };

  sc.cameraQualityGroup = sc.qualityGroup(
    t("voiceAudio.cameraQuality"),
    t("voiceAudio.cameraQualityDesc"),
    "streamQuality",
    // The defaults match getCameraQuality/getScreenShareQuality in
    // lib/voice/screenShare, which this tab does not import (it pulls in the
    // voice store).
    loadPref<string>("streamQuality", "medium"),
    [
      ["low", t("voiceAudio.cameraQuality.low")],
      ["medium", t("voiceAudio.cameraQuality.medium")],
      ["high", t("voiceAudio.cameraQuality.high")],
      ["source", t("voiceAudio.cameraQuality.source")],
    ],
  );

  sc.screenQualityGroup = sc.qualityGroup(
    t("voiceAudio.screenQuality"),
    t("voiceAudio.screenQualityDesc"),
    "screenShareQuality",
    loadPref<string>("screenShareQuality", "medium"),
    [
      ["low", t("voiceAudio.screenQuality.low")],
      ["medium", t("voiceAudio.screenQuality.medium")],
      ["high", t("voiceAudio.screenQuality.high")],
      ["source", t("voiceAudio.screenQuality.source")],
    ],
  );

  // Screen share FPS selector
  sc.fpsHeader = createElement("div", { class: "settings-field-label" }, t("voiceAudio.screenFps"));

  sc.fpsDesc = createElement("p", { class: "setting-desc" }, t("voiceAudio.screenFpsDesc"));

  sc.fpsSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:16px",
    "aria-label": t("voiceAudio.screenFps"),
  });

  sc.fpsLabels = {
    60: t("voiceAudio.fps.60"),
    120: t("voiceAudio.fps.120"),
  };

  sc.fpsOptions = [
    [30, t("voiceAudio.fps.30")],
    ...SHARE_FPS_OPTIONS.map((fps): [number, string] => [fps, sc.fpsLabels[fps] ?? String(fps)]),
  ];

  sc.savedFps = offeredShareFps(loadPref<number>("screenShareFps", 30));

  for (const [value, label] of sc.fpsOptions) {
    const opt = createElement("option", { value: String(value) }, label);
    if (value === sc.savedFps) opt.setAttribute("selected", "");
    sc.fpsSelect.appendChild(opt);
  }

  sc.fpsSelect.value = String(sc.savedFps);

  sc.fpsSelect.addEventListener(
    "change",
    () => {
      savePref("screenShareFps", Number(sc.fpsSelect.value));
    },
    { signal: sc.signal },
  );

  // Linux: the Wayland portal negotiates 60 fps at most; the picker
  // greys 120 out there, so say it here as well.
  sc.fpsGroup = isLinuxDesktop()
    ? [
        sc.fpsHeader,
        sc.fpsDesc,
        createElement(
          "p",
          { class: "setting-desc", "data-testid": "screen-fps-wayland-note" },
          t("voiceAudio.screenFpsWaylandNote"),
        ),
        sc.fpsSelect,
      ]
    : [sc.fpsHeader, sc.fpsDesc, sc.fpsSelect];

  // Video device selector
  sc.videoHeader = createElement(
    "div",
    { class: "settings-field-label" },
    t("voiceAudio.videoDevice"),
  );

  sc.videoSelect = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:12px",
    "aria-label": t("voiceAudio.videoDevice"),
  });

  sc.defaultVideoOpt = createElement("option", { value: "" }, t("voiceAudio.default"));

  sc.videoSelect.appendChild(sc.defaultVideoOpt);

  sc.cameraCard.append(sc.videoHeader, sc.videoSelect);

  // Remote cameras play on their own; off, each one waits behind Watch stream.
  sc.autoPlayRow = createElement("div", {
    class: "setting-row",
    "data-testid": "auto-play-cameras",
  });

  sc.autoPlayInfo = createElement("div", {});

  appendChildren(
    sc.autoPlayInfo,
    createElement("div", { class: "setting-label" }, t("voiceAudio.autoPlayCameras")),
    createElement("div", { class: "setting-desc" }, t("voiceAudio.autoPlayCamerasDesc")),
  );

  appendChildren(
    sc.autoPlayRow,
    sc.autoPlayInfo,
    createToggle(autoPlayCameras(), {
      signal: sc.signal,
      label: t("voiceAudio.autoPlayCameras"),
      onChange: (nowOn) => savePref(AUTO_PLAY_CAMERAS_PREF, nowOn),
    }),
  );

  sc.cameraCard.appendChild(sc.autoPlayRow);

  const mirrorRow = createElement("div", {
    class: "setting-row",
    "data-testid": "mirror-self-camera",
  });
  const mirrorInfo = createElement("div", {});
  appendChildren(
    mirrorInfo,
    createElement("div", { class: "setting-label" }, t("voiceAudio.mirrorSelfCamera")),
    createElement("div", { class: "setting-desc" }, t("voiceAudio.mirrorSelfCameraDesc")),
  );
  appendChildren(
    mirrorRow,
    mirrorInfo,
    createToggle(mirrorSelfCamera(), {
      signal: sc.signal,
      label: t("voiceAudio.mirrorSelfCamera"),
      onChange: (nowOn) => {
        savePref(MIRROR_SELF_CAMERA_PREF, nowOn);
        applyMirrorSelfCamera(nowOn);
      },
    }),
  );
  sc.cameraCard.appendChild(mirrorRow);

  // Camera preview
  sc.previewWrap = createElement("div", { class: "camera-preview" });

  // Said in words, so an empty box is not a mystery.
  sc.previewLabel = createElement(
    "div",
    { class: "camera-preview-label" },
    t("voiceAudio.previewOff"),
  );

  sc.previewVideo = document.createElement("video");

  sc.previewVideo.autoplay = true;

  sc.previewVideo.muted = true;

  sc.previewVideo.playsInline = true;

  sc.previewWrap.append(sc.previewVideo, sc.previewLabel);

  sc.cameraCard.appendChild(sc.previewWrap);

  sc.cameraCard.append(...sc.cameraQualityGroup);

  if (!sc.android) sc.cameraCard.append(...sc.screenQualityGroup, ...sc.fpsGroup);

  // The codec choice. Off Linux the webview's own encoders decide what is
  // offered; on Linux the native engine offers VP8, Auto (VP8), and H.264 and
  // VP9 only when its probe says it can encode them.
  sc.codecGroup = (h264Available: boolean, vp9Native = false): HTMLElement[] => {
    const linux = isLinuxDesktop();
    const offerVp9 = linux ? vp9Native : vp9Offered();
    const offerH265 = h265Offered();
    const savedCodec = getVideoCodecPref();
    // A saved codec that is no longer offered reads as VP8, as the resolver
    // does; the pref itself is left alone for a build that offers it.
    const unoffered =
      (savedCodec === "vp9" && !offerVp9) ||
      (savedCodec === "h265" && !offerH265) ||
      (savedCodec === "h264" && !h264Available);
    return [
      ...sc.qualityGroup(
        t("voiceAudio.videoCodec"),
        t(linux ? "voiceAudio.videoCodecDescLinux" : "voiceAudio.videoCodecDesc"),
        "videoCodec",
        unoffered ? "vp8" : savedCodec,
        [
          ["vp8", t("voiceAudio.videoCodec.vp8")],
          [
            "h264",
            h264Available
              ? t(linux ? "voiceAudio.videoCodec.h264Linux" : "voiceAudio.videoCodec.h264")
              : t("voiceAudio.videoCodec.h264Unavailable"),
          ],
          ...(offerVp9 ? [["vp9", t("voiceAudio.videoCodec.vp9")] as [string, string]] : []),
          ...(offerH265 ? [["h265", t("voiceAudio.videoCodec.h265")] as [string, string]] : []),
          ["auto", t(linux ? "voiceAudio.videoCodec.autoLinux" : "voiceAudio.videoCodec.auto")],
        ],
        h264Available ? new Set() : new Set(["h264"]),
      ),
      createElement(
        "p",
        { class: "setting-desc" },
        t(linux ? "voiceAudio.videoCodecLinux" : "voiceAudio.videoCodecIntel"),
      ),
    ];
  };

  if (isLinuxDesktop()) {
    // The probe is asked of the host, so the group fills a slot that holds its
    // place (a group's height) and the cards below do not jump.
    const slot = createElement("div", { class: "voice-codec-slot", style: "min-height:104px" });
    sc.cameraCard.appendChild(slot);
    void Promise.all([h264Offered(), vp9Available()]).then(([h264, vp9]) => {
      if (!sc.signal.aborted) slot.append(...sc.codecGroup(h264, vp9));
    });
  } else if (!sc.android) {
    sc.cameraCard.append(...sc.codecGroup(true));
  }
}
