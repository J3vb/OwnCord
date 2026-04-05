/**
 * VoiceWidget component — shows active voice channel info with controls.
 * Hidden when not connected to a voice channel.
 * Users are displayed under the voice channel in the sidebar, NOT here.
 * Step 6.50
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon, createSignalIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { voiceStore } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import {
  createConnectionStatsPoller,
  formatBytes,
  formatRate,
  formatBitrate,
  type ConnectionStats,
  type ConnectionStatsPoller,
  type QualityLevel,
} from "@lib/connectionStats";
import { getRoomForStats, retryMicPermission } from "@lib/livekitSession";

export interface VoiceWidgetOptions {
  onDisconnect(): void;
  onMuteToggle(): void;
  onDeafenToggle(): void;
  onCameraToggle(): void;
  onScreenshareToggle(): void;
}

const QUALITY_COLORS: Record<QualityLevel, string> = {
  excellent: "var(--green, #23a559)",
  fair: "var(--yellow, #f0b232)",
  poor: "var(--red, #f23f43)",
  bad: "var(--red, #f23f43)",
};

const QUALITY_BARS: Record<QualityLevel, number> = {
  excellent: 4,
  fair: 3,
  poor: 2,
  bad: 1,
};

/** Format milliseconds elapsed into HH:MM:SS or MM:SS. */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function createVoiceWidget(options: VoiceWidgetOptions): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let channelNameEl: HTMLSpanElement | null = null;
  let muteBtn: HTMLButtonElement | null = null;
  let deafenBtn: HTMLButtonElement | null = null;
  let cameraBtn: HTMLButtonElement | null = null;
  let shareBtn: HTMLButtonElement | null = null;

  // Listen-only mode: "Grant Microphone" button
  let grantMicBtn: HTMLButtonElement | null = null;

  // Connection stats
  let signalWrap: HTMLDivElement | null = null;
  let pingLabel: HTMLSpanElement | null = null;
  let statsPane: HTMLDivElement | null = null;
  let statsPoller: ConnectionStatsPoller | null = null;
  let statsUnlisten: (() => void) | null = null;

  // Elapsed timer
  let timerEl: HTMLSpanElement | null = null;
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  // Stats pane field elements (set during mount)
  let outRateEl: HTMLSpanElement | null = null;
  let outPacketsEl: HTMLSpanElement | null = null;
  let rttEl: HTMLSpanElement | null = null;
  let inRateEl: HTMLSpanElement | null = null;
  let inPacketsEl: HTMLSpanElement | null = null;
  let totalUpEl: HTMLSpanElement | null = null;
  let totalDownEl: HTMLSpanElement | null = null;

  const unsubs: Array<() => void> = [];

  function swapIcon(btn: HTMLButtonElement, name: IconName): void {
    const existing = btn.querySelector("svg");
    if (existing) existing.remove();
    btn.appendChild(createIcon(name, 18));
  }

  function updateSignalIcon(stats: ConnectionStats): void {
    if (signalWrap === null || pingLabel === null) return;
    const color = QUALITY_COLORS[stats.quality];
    const bars = QUALITY_BARS[stats.quality];

    // Replace signal icon
    const oldSvg = signalWrap.querySelector("svg");
    if (oldSvg) oldSvg.remove();
    signalWrap.insertBefore(createSignalIcon(bars, color, 14), pingLabel);

    // Update ping text
    const rttText = stats.rtt > 0 ? `${Math.round(stats.rtt)}ms` : "—";
    setText(pingLabel, rttText);
    pingLabel.style.color = color;

    // Update expanded stats pane fields if they exist
    if (outRateEl)
      setText(outRateEl, `${formatRate(stats.outRate)} (${formatBitrate(stats.outRate)})`);
    if (outPacketsEl) setText(outPacketsEl, String(stats.outPackets));
    if (rttEl) {
      setText(rttEl, stats.rtt > 0 ? `${stats.rtt.toFixed(1)} ms` : "—");
      rttEl.style.color = color;
    }
    if (inRateEl) setText(inRateEl, `${formatRate(stats.inRate)} (${formatBitrate(stats.inRate)})`);
    if (inPacketsEl) setText(inPacketsEl, String(stats.inPackets));
    if (totalUpEl) setText(totalUpEl, formatBytes(stats.totalUp));
    if (totalDownEl) setText(totalDownEl, formatBytes(stats.totalDown));
  }

  let qualityUnlisten: (() => void) | null = null;

  function startStatsPoller(): void {
    if (statsPoller !== null) return;
    statsPoller = createConnectionStatsPoller(() => getRoomForStats());
    statsUnlisten = statsPoller.onUpdate(updateSignalIcon);
    qualityUnlisten = statsPoller.onQualityChanged((quality, _prevQuality) => {
      // Auto-expand stats pane when quality degrades
      if ((quality === "poor" || quality === "bad") && statsPane !== null) {
        statsPane.classList.add("visible");
      }
    });
    statsPoller.start();
  }

  function stopStatsPoller(): void {
    statsUnlisten?.();
    statsUnlisten = null;
    qualityUnlisten?.();
    qualityUnlisten = null;
    statsPoller?.stop();
    statsPoller = null;
  }

  function updateElapsedTimer(): void {
    const joinedAt = voiceStore.getState().joinedAt;
    if (timerEl === null || joinedAt === null) return;
    setText(timerEl, formatElapsed(Date.now() - joinedAt));
  }

  function startElapsedTimer(): void {
    if (timerInterval !== null) return;
    updateElapsedTimer();
    timerInterval = setInterval(updateElapsedTimer, 1000);
  }

  function stopElapsedTimer(): void {
    if (timerInterval !== null) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (timerEl !== null) setText(timerEl, "00:00");
  }

  function render(): void {
    if (root === null || channelNameEl === null) return;

    const voice = voiceStore.getState();
    const channelId = voice.currentChannelId;

    if (channelId === null) {
      root.classList.remove("visible");
      stopStatsPoller();
      stopElapsedTimer();
      statsPane?.classList.remove("visible");
      return;
    }

    root.classList.add("visible");
    startStatsPoller();
    startElapsedTimer();

    // Channel name
    const channel = channelsStore.getState().channels.get(channelId);
    setText(channelNameEl, channel?.name ?? "Voice Channel");

    // Toggle button active states, swap icons, and update aria-pressed
    muteBtn?.classList.toggle("active-ctrl", voice.localMuted);
    deafenBtn?.classList.toggle("active-ctrl", voice.localDeafened);
    cameraBtn?.classList.toggle("active-ctrl", voice.localCamera);

    if (muteBtn) {
      swapIcon(muteBtn, voice.localMuted ? "mic-off" : "mic");
      muteBtn.setAttribute("aria-pressed", String(voice.localMuted));
    }
    if (deafenBtn) {
      swapIcon(deafenBtn, voice.localDeafened ? "headphones-off" : "headphones");
      deafenBtn.setAttribute("aria-pressed", String(voice.localDeafened));
    }
    if (cameraBtn) {
      swapIcon(cameraBtn, voice.localCamera ? "camera-off" : "camera");
      cameraBtn.setAttribute("aria-pressed", String(voice.localCamera));
    }
    shareBtn?.classList.toggle("active-ctrl", voice.localScreenshare);
    shareBtn?.classList.toggle("sharing-active", voice.localScreenshare);
    if (shareBtn) {
      swapIcon(shareBtn, voice.localScreenshare ? "monitor-off" : "monitor");
      shareBtn.setAttribute("aria-pressed", String(voice.localScreenshare));
      // Update button label to show "Sharing" when active
      const labelSpan = shareBtn.querySelector(".vw-share-label");
      if (labelSpan !== null) {
        labelSpan.textContent = voice.localScreenshare ? "Sharing" : "";
        (labelSpan as HTMLElement).style.display = voice.localScreenshare ? "inline" : "none";
      }
    }

    // Show/hide "Grant Microphone" button based on listen-only state
    if (grantMicBtn) {
      grantMicBtn.style.display = voice.listenOnly ? "block" : "none";
    }
  }

  function createControlButton(
    label: string,
    icon: IconName,
    handler: () => void,
    extraClass?: string,
  ): HTMLButtonElement {
    const btn = createElement("button", {
      class: extraClass ?? "",
      "aria-label": label,
    });
    btn.appendChild(createIcon(icon, 18));
    btn.addEventListener("click", handler, { signal: ac.signal });
    return btn;
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "voice-widget", "data-testid": "voice-widget" });

    // Header row: "Voice Connected" + channel name + signal icon
    const header = createElement("div", { class: "vw-header" });
    const connLabel = createElement("span", { class: "vw-connected" }, "Voice Connected");
    timerEl = createElement("span", { class: "vw-timer" }, "00:00");
    channelNameEl = createElement("span", { class: "vw-channel" }, "Voice Channel");

    signalWrap = createElement("div", { class: "vw-signal", "aria-label": "Connection quality" });
    signalWrap.appendChild(createSignalIcon(4, QUALITY_COLORS.excellent, 14));
    pingLabel = createElement("span", { class: "vw-ping" }, "—");
    pingLabel.style.color = QUALITY_COLORS.excellent;
    signalWrap.appendChild(pingLabel);
    signalWrap.addEventListener(
      "click",
      () => {
        statsPane?.classList.toggle("visible");
      },
      { signal: ac.signal },
    );

    appendChildren(header, connLabel, timerEl, channelNameEl, signalWrap);

    // Expanded stats pane (hidden by default)
    statsPane = createElement("div", { class: "vw-stats" });
    const statsTitle = createElement("div", { class: "vw-stats-title" }, "Transport Statistics");
    const statsGrid = createElement("div", { class: "vw-stats-grid" });

    // Outgoing column
    const outCol = createElement("div", {});
    const outLabel = createElement("div", { class: "vw-stats-col-label out" }, "Outgoing");
    outRateEl = createElement("span", {}, "0 B/s");
    outPacketsEl = createElement("span", {}, "0");
    rttEl = createElement("span", {}, "—");
    rttEl.style.fontWeight = "600";
    const outBody = createElement("div", { class: "vw-stats-row" });
    for (const [label, el] of [
      ["Rate: ", outRateEl],
      ["Packets: ", outPacketsEl],
      ["RTT: ", rttEl],
    ] as const) {
      outBody.appendChild(document.createTextNode(label));
      outBody.appendChild(el);
      outBody.appendChild(createElement("br", {}));
    }
    appendChildren(outCol, outLabel, outBody);

    // Incoming column
    const inCol = createElement("div", {});
    const inLabel = createElement("div", { class: "vw-stats-col-label in" }, "Incoming");
    inRateEl = createElement("span", {}, "0 B/s");
    inPacketsEl = createElement("span", {}, "0");
    const inBody = createElement("div", { class: "vw-stats-row" });
    for (const [label, el] of [
      ["Rate: ", inRateEl],
      ["Packets: ", inPacketsEl],
    ] as const) {
      inBody.appendChild(document.createTextNode(label));
      inBody.appendChild(el);
      inBody.appendChild(createElement("br", {}));
    }
    appendChildren(inCol, inLabel, inBody);

    appendChildren(statsGrid, outCol, inCol);

    // Session totals
    const totals = createElement("div", { class: "vw-stats-totals" });
    const totalsLabel = createElement("div", { class: "vw-stats-totals-label" }, "Session Totals");
    const totalsRow = createElement("div", { class: "vw-stats-totals-row" });
    totalUpEl = createElement("span", {}, "0 B");
    totalDownEl = createElement("span", {}, "0 B");
    const upWrap = createElement("span", {});
    upWrap.appendChild(document.createTextNode("\u2191 "));
    upWrap.appendChild(totalUpEl);
    const downWrap = createElement("span", {});
    downWrap.appendChild(document.createTextNode("\u2193 "));
    downWrap.appendChild(totalDownEl);
    appendChildren(totalsRow, upWrap, downWrap);
    appendChildren(totals, totalsLabel, totalsRow);

    appendChildren(statsPane, statsTitle, statsGrid, totals);

    // Controls row
    const controls = createElement("div", { class: "vw-controls" });
    muteBtn = createControlButton("Mute", "mic", options.onMuteToggle);
    deafenBtn = createControlButton("Deafen", "headphones", options.onDeafenToggle);
    cameraBtn = createControlButton("Camera", "camera", options.onCameraToggle);
    shareBtn = createControlButton(
      "Screenshare",
      "monitor",
      options.onScreenshareToggle,
      "vw-share-btn",
    );
    const shareLabelSpan = createElement("span", { class: "vw-share-label" });
    shareLabelSpan.style.display = "none";
    shareBtn.appendChild(shareLabelSpan);
    const disconnectBtn = createControlButton(
      "Disconnect",
      "phone",
      options.onDisconnect,
      "disconnect",
    );
    appendChildren(controls, muteBtn, deafenBtn, cameraBtn, shareBtn, disconnectBtn);

    // "Grant Microphone" button for listen-only mode
    grantMicBtn = createElement(
      "button",
      {
        class: "vw-grant-mic",
        "aria-label": "Grant microphone permission",
      },
      "Grant Microphone",
    );
    grantMicBtn.style.display = "none";
    grantMicBtn.addEventListener(
      "click",
      () => {
        if (grantMicBtn) {
          grantMicBtn.disabled = true;
          setText(grantMicBtn, "Requesting...");
        }
        void retryMicPermission().finally(() => {
          if (grantMicBtn) {
            grantMicBtn.disabled = false;
            setText(grantMicBtn, "Grant Microphone");
          }
        });
      },
      { signal: ac.signal },
    );

    appendChildren(root, header, statsPane, grantMicBtn, controls);

    render();

    unsubs.push(
      voiceStore.subscribeSelector(
        (s) => ({
          channelId: s.currentChannelId,
          muted: s.localMuted,
          deafened: s.localDeafened,
          camera: s.localCamera,
          screenshare: s.localScreenshare,
          listenOnly: s.listenOnly,
        }),
        () => render(),
        (a, b) =>
          a.channelId === b.channelId &&
          a.muted === b.muted &&
          a.deafened === b.deafened &&
          a.camera === b.camera &&
          a.screenshare === b.screenshare &&
          a.listenOnly === b.listenOnly,
      ),
    );
    unsubs.push(
      channelsStore.subscribeSelector(
        (s) => s.channels,
        () => render(),
      ),
    );

    container.appendChild(root);
  }

  function destroy(): void {
    stopStatsPoller();
    stopElapsedTimer();
    ac.abort();
    for (const unsub of unsubs) {
      unsub();
    }
    unsubs.length = 0;
    root?.remove();
    root = null;
    channelNameEl = null;
    muteBtn = null;
    deafenBtn = null;
    cameraBtn = null;
    shareBtn = null;
    grantMicBtn = null;
    signalWrap = null;
    pingLabel = null;
    timerEl = null;
    statsPane = null;
    outRateEl = null;
    outPacketsEl = null;
    rttEl = null;
    inRateEl = null;
    inPacketsEl = null;
    totalUpEl = null;
    totalDownEl = null;
  }

  return { mount, destroy };
}
