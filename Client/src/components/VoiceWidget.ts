/**
 * VoiceWidget component — shows active voice channel info with controls.
 * Hidden when not connected to a voice channel.
 * Users are displayed under the voice channel in the sidebar, NOT here.
 * Step 6.50
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon, createSignalIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { voiceStore, type VoiceStatus } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { uiStore } from "@stores/ui.store";
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
import { voiceText as t } from "../i18n/voice";

export interface VoiceWidgetOptions {
  onDisconnect(): void;
  onMuteToggle(): void;
  onDeafenToggle(): void;
  onCameraToggle(): void;
  onScreenshareToggle(): void;
}

/** Connection-quality colour, used both for the signal bars (a fill, where
 *  --green/--yellow/--red are fine) and for the ping text beside them (text,
 *  which Q1 requires at 4.5:1). The qualified text tokens carry both roles. */
const QUALITY_COLORS: Record<QualityLevel, string> = {
  excellent: "var(--text-positive, #62c28c)",
  fair: "var(--text-warning, #f2b84b)",
  poor: "var(--text-danger, #ff9a9c)",
  bad: "var(--text-danger, #ff9a9c)",
};

const QUALITY_BARS: Record<QualityLevel, number> = {
  excellent: 4,
  fair: 3,
  poor: 2,
  bad: 1,
};

/** Header status text per voice-session lifecycle state
 *  (docs/architecture/ux/voice-and-e2ee.md §2). */
function headerStatusText(status: VoiceStatus): string {
  // i18n-exempt: catalog key assembled from the VoiceStatus wire value
  return t(`status.${status}`);
}

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

function swapIcon(btn: HTMLButtonElement, name: IconName): void {
  const existing = btn.querySelector("svg");
  if (existing) existing.remove();
  btn.appendChild(createIcon(name, 18));
}

export function createVoiceWidget(options: VoiceWidgetOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let channelNameEl: HTMLSpanElement | null = null;
  let statusLabel: HTMLSpanElement | null = null;
  let securedBadge: HTMLSpanElement | null = null;
  let controlsRow: HTMLDivElement | null = null;
  let muteBtn: HTMLButtonElement | null = null;
  let deafenBtn: HTMLButtonElement | null = null;
  let cameraBtn: HTMLButtonElement | null = null;
  let shareBtn: HTMLButtonElement | null = null;
  let disconnectBtn: HTMLButtonElement | null = null;
  /** Persistent polite status for a moderator-imposed mute/deafen. The
   *  disabled controls carry only a `title`, which a screen reader never
   *  reaches (a disabled button cannot take focus), so the reason is announced
   *  here instead — once, when it appears. */
  let modStatusEl: HTMLDivElement | null = null;

  // Listen-only mode: "Grant Microphone" button + its persistent explanation.
  let grantMicBtn: HTMLButtonElement | null = null;
  /**
   * Whether the user has retried the microphone in this session and it is
   * still unavailable. The widget cannot see *why* the OS refused (the
   * notifier contract is a boolean), but it can honestly report the outcome
   * of its own retry — so the guidance stops promising a grant that the retry
   * just failed to obtain.
   */
  let micRetryFailed = false;
  let micNoticeEl: HTMLDivElement | null = null;

  // Connection stats
  let signalWrap: HTMLButtonElement | null = null;
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
      // i18n-exempt: numeric RTT value with its unit, not translatable prose
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

  /** Header E2EE status: dynamic label + a persistent "secured" lock once the
   *  room key is ready (docs/architecture/ux/voice-and-e2ee.md §2).
   *  `encryptionDegraded` (OC-0002) is the SDK's own signal — via
   *  RoomEvent.EncryptionError, wired in livekitSession.ts's createRoom() —
   *  that the E2EE worker died after the key exchange already succeeded.
   *  voiceStatus alone reaches "connected" in that case, so the badge must
   *  never claim "Secured" from voiceStatus in isolation: it renders a
   *  distinct, still-visible not-secured warning instead of just hiding. */
  function updateStatus(status: VoiceStatus, encryptionDegraded: boolean): void {
    if (statusLabel !== null) {
      setText(statusLabel, headerStatusText(status));
      statusLabel.classList.toggle("vw-securing", status === "securing");
      statusLabel.classList.toggle("vw-reconnecting", status === "reconnecting");
    }
    if (securedBadge !== null) {
      const connected = status === "connected";
      const degraded = connected && encryptionDegraded;
      securedBadge.classList.toggle("vw-secured--degraded", degraded);
      if (degraded) {
        setText(securedBadge, t("encryption.unsecured"));
        securedBadge.title = t("encryption.unsecuredLabel");
      } else {
        setText(securedBadge, t("encryption.secured"));
        securedBadge.title = t("encryption.securedLabel");
      }
      securedBadge.style.display = connected ? "inline-flex" : "none";
    }
  }

  /** Freeze controls that need WS signaling, while keeping local hangup
   *  available: the LiveKit call may still be live when chat is disconnected. */
  function updateFrozen(status: "connected" | "reconnecting" | "disconnected"): void {
    const frozen = status !== "connected";
    const reason =
      status === "reconnecting" ? t("status.reconnectingShort") : t("status.notConnected");
    controlsRow?.classList.toggle("vw-controls--frozen", frozen);
    for (const btn of [muteBtn, deafenBtn, cameraBtn, shareBtn, grantMicBtn]) {
      if (btn === null) continue;
      btn.disabled = frozen;
      btn.title = frozen ? reason : "";
    }
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
    updateStatus(voice.voiceStatus, voice.encryptionDegraded === true);
    updateFrozen(uiStore.getState().connectionStatus);

    // Channel name. A DM call resolves through the DM store rather than the
    // channels store: the channels-store row for a DM is synthesised when the
    // conversation is opened, so accepting a call for a DM the user has not
    // looked at yet would otherwise label the call "Voice Channel".
    const channel = channelsStore.getState().channels.get(channelId);
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    setText(
      channelNameEl,
      dm !== undefined ? dmDisplayName(dm) : (channel?.name ?? t("widget.channelFallback")),
    );

    // Toggle button active states, swap icons, and update aria-pressed
    muteBtn?.classList.toggle("active-ctrl", voice.localMuted);
    deafenBtn?.classList.toggle("active-ctrl", voice.localDeafened);
    cameraBtn?.classList.toggle("active-ctrl", voice.localCamera);

    // A moderator-imposed mute/deafen is not ours to lift: the server refuses
    // the unmute, so disable the control and say why instead of letting the
    // click bounce off with an error toast.
    const serverMuted = voice.localServerMuted === true;
    const serverDeafened = voice.localServerDeafened === true;
    if (muteBtn) {
      swapIcon(muteBtn, voice.localMuted ? "mic-off" : "mic");
      muteBtn.setAttribute("aria-pressed", String(voice.localMuted));
      // Only ever tighten: updateFrozen ran above and owns the socket-down
      // disable, which must not be relaxed here.
      if (serverMuted) {
        muteBtn.disabled = true;
        muteBtn.title = t("widget.mutedByModerator");
      }
    }
    if (deafenBtn) {
      swapIcon(deafenBtn, voice.localDeafened ? "headphones-off" : "headphones");
      deafenBtn.setAttribute("aria-pressed", String(voice.localDeafened));
      if (serverDeafened) {
        deafenBtn.disabled = true;
        deafenBtn.title = t("widget.deafenedByModerator");
      }
    }
    if (cameraBtn) {
      swapIcon(cameraBtn, voice.localCamera ? "camera-off" : "camera");
      cameraBtn.setAttribute("aria-pressed", String(voice.localCamera));
    }
    // Announce a moderator-imposed state once (render runs on every store
    // change; the text only changes when the state actually does, so a
    // screen reader does not re-read it on unrelated updates).
    if (modStatusEl !== null) {
      const text =
        serverMuted && serverDeafened
          ? t("widget.moderatedMutedDeafened")
          : serverMuted
            ? t("widget.mutedByModerator")
            : serverDeafened
              ? t("widget.deafenedByModerator")
              : "";
      if (modStatusEl.textContent !== text) setText(modStatusEl, text);
    }
    shareBtn?.classList.toggle("active-ctrl", voice.localScreenshare);
    shareBtn?.classList.toggle("sharing-active", voice.localScreenshare);
    if (shareBtn) {
      swapIcon(shareBtn, voice.localScreenshare ? "monitor-off" : "monitor");
      shareBtn.setAttribute("aria-pressed", String(voice.localScreenshare));
      // Update button label to show "Sharing" when active
      const labelSpan = shareBtn.querySelector(".vw-share-label");
      if (labelSpan !== null) {
        labelSpan.textContent = voice.localScreenshare ? t("widget.sharing") : "";
        (labelSpan as HTMLElement).style.display = voice.localScreenshare ? "inline" : "none";
      }
    }

    // Leaving listen-only clears the "retry failed" memory, so a later join
    // that lands here again starts from the helpful hint rather than a stale
    // claim about the permission.
    if (!voice.listenOnly) micRetryFailed = false;
    // Show/hide "Grant Microphone" button based on listen-only state
    if (grantMicBtn) {
      grantMicBtn.style.display = voice.listenOnly ? "block" : "none";
    }
    // The persistent mic notice: how to change the state, and — once a retry
    // has failed — that it is the system permission, not this app, that has to
    // change. The wording never claims the mic is denied when the real cause
    // (no device, in use by another app) is something a permission grant
    // cannot fix.
    if (micNoticeEl) {
      const show = voice.listenOnly;
      micNoticeEl.style.display = show ? "block" : "none";
      if (show) {
        setText(
          micNoticeEl,
          micRetryFailed ? t("widget.listenOnlyBlocked") : t("widget.listenOnlyHint"),
        );
      }
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
    btn.addEventListener("click", handler, { signal: disposable.signal });
    return btn;
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "voice-widget", "data-testid": "voice-widget" });

    // Header row: lifecycle status + secured lock + channel name + signal icon
    const header = createElement("div", { class: "vw-header" });
    statusLabel = createElement("span", {
      class: "vw-connected",
      "data-testid": "vw-status",
    });
    setText(statusLabel, t("status.connected"));
    // Persistent E2EE affirmation, shown only once the room key is ready.
    securedBadge = createElement("span", {
      class: "vw-secured",
      "data-testid": "vw-secured",
      title: t("encryption.securedLabel"),
    });
    setText(securedBadge, t("encryption.secured"));
    securedBadge.style.display = "none";
    timerEl = createElement("span", { class: "vw-timer" }, "00:00");
    channelNameEl = createElement("span", { class: "vw-channel" }, t("widget.channelFallback"));

    // A button, not a clickable div: the quality readout toggles the transport
    // stats pane, and a pointer-only control is unreachable by keyboard (Q1).
    // aria-expanded reflects the pane it owns.
    signalWrap = createElement("button", {
      type: "button",
      class: "vw-signal",
      "aria-label": t("widget.quality"),
      "aria-expanded": "false",
      "data-testid": "vw-signal",
    });
    signalWrap.appendChild(createSignalIcon(4, QUALITY_COLORS.excellent, 14));
    pingLabel = createElement("span", { class: "vw-ping" }, "—");
    pingLabel.style.color = QUALITY_COLORS.excellent;
    signalWrap.appendChild(pingLabel);

    function toggleStatsPane(): void {
      if (statsPane === null || signalWrap === null) return;
      const open = statsPane.classList.toggle("visible");
      signalWrap.setAttribute("aria-expanded", String(open));
    }
    signalWrap.addEventListener("click", toggleStatsPane, { signal: disposable.signal });

    appendChildren(header, statusLabel, securedBadge, timerEl, channelNameEl, signalWrap);

    // Expanded stats pane (hidden by default)
    statsPane = createElement("div", { class: "vw-stats" });
    const statsTitle = createElement(
      "div",
      { class: "vw-stats-title" },
      t("widget.transportStatistics"),
    );
    const statsGrid = createElement("div", { class: "vw-stats-grid" });

    // Outgoing column
    const outCol = createElement("div", {});
    const outLabel = createElement(
      "div",
      { class: "vw-stats-col-label out" },
      t("widget.outgoing"),
    );
    outRateEl = createElement("span", {}, t("widget.zeroRate"));
    outPacketsEl = createElement("span", {}, "0");
    rttEl = createElement("span", {}, "—");
    rttEl.style.fontWeight = "600";
    const outBody = createElement("div", { class: "vw-stats-row" });
    for (const [label, el] of [
      [t("widget.rate"), outRateEl],
      [t("widget.packets"), outPacketsEl],
      [t("widget.rtt"), rttEl],
    ] as const) {
      outBody.appendChild(document.createTextNode(label));
      outBody.appendChild(el);
      outBody.appendChild(createElement("br", {}));
    }
    appendChildren(outCol, outLabel, outBody);

    // Incoming column
    const inCol = createElement("div", {});
    const inLabel = createElement("div", { class: "vw-stats-col-label in" }, t("widget.incoming"));
    inRateEl = createElement("span", {}, t("widget.zeroRate"));
    inPacketsEl = createElement("span", {}, "0");
    const inBody = createElement("div", { class: "vw-stats-row" });
    for (const [label, el] of [
      [t("widget.rate"), inRateEl],
      [t("widget.packets"), inPacketsEl],
    ] as const) {
      inBody.appendChild(document.createTextNode(label));
      inBody.appendChild(el);
      inBody.appendChild(createElement("br", {}));
    }
    appendChildren(inCol, inLabel, inBody);

    appendChildren(statsGrid, outCol, inCol);

    // Session totals
    const totals = createElement("div", { class: "vw-stats-totals" });
    const totalsLabel = createElement(
      "div",
      { class: "vw-stats-totals-label" },
      t("widget.sessionTotals"),
    );
    const totalsRow = createElement("div", { class: "vw-stats-totals-row" });
    totalUpEl = createElement("span", {}, t("widget.zeroBytes"));
    totalDownEl = createElement("span", {}, t("widget.zeroBytes"));
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
    controlsRow = controls;
    muteBtn = createControlButton(t("widget.control.mute"), "mic", options.onMuteToggle);
    deafenBtn = createControlButton(
      t("widget.control.deafen"),
      "headphones",
      options.onDeafenToggle,
    );
    cameraBtn = createControlButton(t("widget.control.camera"), "camera", options.onCameraToggle);
    shareBtn = createControlButton(
      t("widget.control.screenshare"),
      "monitor",
      options.onScreenshareToggle,
      "vw-share-btn",
    );
    const shareLabelSpan = createElement("span", { class: "vw-share-label" });
    shareLabelSpan.style.display = "none";
    shareBtn.appendChild(shareLabelSpan);
    disconnectBtn = createControlButton(
      t("widget.control.disconnect"),
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
        "aria-label": t("widget.grantMicLabel"),
      },
      t("widget.grantMic"),
    );
    grantMicBtn.style.display = "none";
    grantMicBtn.addEventListener(
      "click",
      () => {
        if (grantMicBtn) {
          grantMicBtn.disabled = true;
          setText(grantMicBtn, t("widget.requesting"));
        }
        void retryMicPermission().finally(() => {
          // The retry swallowed its own error and only reports via store state,
          // so read the state it left: still listen-only means the attempt did
          // not acquire the mic, and the persistent notice should stop
          // implying a permission grant is all that stands in the way.
          micRetryFailed = voiceStore.getState().listenOnly;
          if (grantMicBtn) {
            setText(grantMicBtn, t("widget.grantMic"));
            // Delegate the disabled/title state back to render(), which
            // re-runs updateFrozen() — the single authority for the
            // socket-down freeze. Hardcoding `disabled = false` here would
            // silently re-enable this button (and drop its stale title)
            // even while the WS socket is still down and every sibling
            // control remains frozen.
            render();
          }
        });
      },
      { signal: disposable.signal },
    );

    // A persistent line beside the Grant Microphone button: the button is
    // hidden while nothing is wrong, but when the user is in listen-only mode
    // the state needs a reason and a next step (BPR-092), not just a button.
    micNoticeEl = createElement("div", {
      class: "vw-mic-notice setting-desc",
      "data-testid": "vw-mic-notice",
      role: "status",
      "aria-live": "polite",
    });
    micNoticeEl.style.display = "none";

    // A live region present from mount (screen readers skip one inserted
    // already filled) that only fills when a moderator-imposed state lands.
    modStatusEl = createElement("div", {
      class: "vw-mod-status sr-only",
      role: "status",
      "aria-live": "polite",
      "data-testid": "vw-mod-status",
    });

    appendChildren(root, header, statsPane, modStatusEl, grantMicBtn, micNoticeEl, controls);

    render();

    unsubs.push(
      voiceStore.subscribeSelector(
        (s) => ({
          channelId: s.currentChannelId,
          muted: s.localMuted,
          deafened: s.localDeafened,
          serverMuted: s.localServerMuted,
          serverDeafened: s.localServerDeafened,
          camera: s.localCamera,
          screenshare: s.localScreenshare,
          listenOnly: s.listenOnly,
          voiceStatus: s.voiceStatus,
          encryptionDegraded: s.encryptionDegraded === true,
        }),
        () => render(),
        (a, b) =>
          a.channelId === b.channelId &&
          a.muted === b.muted &&
          a.deafened === b.deafened &&
          a.serverMuted === b.serverMuted &&
          a.serverDeafened === b.serverDeafened &&
          a.camera === b.camera &&
          a.screenshare === b.screenshare &&
          a.listenOnly === b.listenOnly &&
          a.voiceStatus === b.voiceStatus &&
          a.encryptionDegraded === b.encryptionDegraded,
      ),
    );
    // Freeze controls reactively when the WS socket drops (§3 connection status).
    unsubs.push(
      uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        () => render(),
      ),
    );
    unsubs.push(
      channelsStore.subscribeSelector(
        (s) => s.channels,
        () => render(),
      ),
    );
    // render() reads the DM call's header name from dmStore, but nothing above
    // fires when it changes — a DM rename/nickname update only touches dmStore,
    // so the header went stale for the whole call (OC-0347).
    unsubs.push(
      dmStore.subscribeSelector(
        (s) => s.channels,
        () => render(),
      ),
    );

    container.appendChild(root);
  }

  function destroy(): void {
    stopStatsPoller();
    stopElapsedTimer();
    disposable.destroy();
    for (const unsub of unsubs) {
      unsub();
    }
    unsubs.length = 0;
    root?.remove();
    root = null;
    channelNameEl = null;
    statusLabel = null;
    securedBadge = null;
    controlsRow = null;
    muteBtn = null;
    deafenBtn = null;
    cameraBtn = null;
    shareBtn = null;
    disconnectBtn = null;
    modStatusEl = null;
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
