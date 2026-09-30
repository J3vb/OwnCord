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
  formatRateCompact,
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
  /** Open the DM a DM call belongs to. Without it the call name is plain text. */
  onOpenCall?(channelId: number): void;
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
export function headerStatusText(status: VoiceStatus): string {
  // i18n-exempt: catalog key assembled from the VoiceStatus wire value
  return t(`status.${status}`);
}

/** Format milliseconds elapsed into HH:MM:SS or MM:SS. */
export function formatElapsed(ms: number): string {
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

/** Update a stats value and mark it empty (zero/missing) so the CSS can
 *  soften it instead of showing it at full strength. */
function setStatValue(el: HTMLSpanElement | null, text: string, empty: boolean): void {
  if (el === null) return;
  setText(el, text);
  el.classList.toggle("vw-stat-value--empty", empty);
}

/** One direction's tile: an arrow + label, a big rate, and its packet count. */
function statTile(
  arrow: string,
  label: string,
): { tile: HTMLDivElement; rate: HTMLSpanElement; packets: HTMLSpanElement } {
  const tile = createElement("div", { class: "vw-stats-tile" });
  const labelEl = createElement("div", { class: "vw-stats-tile-label" });
  appendChildren(
    labelEl,
    createElement("span", { class: "vw-stat-arrow", "aria-hidden": "true" }, arrow),
    createElement("span", {}, label),
  );
  const rate = createElement("span", { class: "vw-stat-value vw-stat-rate" });
  const packets = createElement("span", { class: "vw-stat-packets" });
  appendChildren(tile, labelEl, rate, packets);
  return { tile, rate, packets };
}

/** A direction's packet count as prose; zero reads "no packets". */
function packetText(count: number): string {
  return count === 0 ? t("widget.noPackets") : t("widget.packetCount", { count });
}

export function createVoiceWidget(options: VoiceWidgetOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let channelNameEl: HTMLElement | null = null;
  /** The call the name link opens; read at click time. */
  let linkedChannelId: number | null = null;
  let statusLabel: HTMLSpanElement | null = null;
  let securedBadge: HTMLSpanElement | null = null;
  let securedText: HTMLSpanElement | null = null;
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
  let inRateEl: HTMLSpanElement | null = null;
  let inPacketsEl: HTMLSpanElement | null = null;
  /** The footer's leading slot: "RTT 42.0 ms" once known, else "Session". */
  let footerLeadEl: HTMLSpanElement | null = null;
  let rttEl: HTMLSpanElement | null = null;
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

    // Update expanded stats pane fields if they exist. An idle direction
    // reads "Idle" / "no packets" softly (the CSS dims .vw-stat-value--empty)
    // rather than as another full-strength zero competing for attention.
    setStatValue(
      outRateEl,
      stats.outRate === 0 ? t("widget.idle") : formatRateCompact(stats.outRate),
      stats.outRate === 0,
    );
    if (outPacketsEl) setText(outPacketsEl, packetText(stats.outPackets));
    setStatValue(
      inRateEl,
      stats.inRate === 0 ? t("widget.idle") : formatRateCompact(stats.inRate),
      stats.inRate === 0,
    );
    if (inPacketsEl) setText(inPacketsEl, packetText(stats.inPackets));
    // The RTT only takes the footer's lead once it is known; until then the
    // slot just labels the totals, so no "—" placeholder is ever shown.
    if (footerLeadEl !== null && rttEl !== null) {
      if (stats.rtt > 0) {
        // i18n-exempt: numeric RTT value with its unit, not translatable prose
        setText(rttEl, `${stats.rtt.toFixed(1)} ms`);
        if (!rttEl.isConnected) {
          footerLeadEl.replaceChildren(`${t("widget.rtt")} `, rttEl);
        }
      } else if (footerLeadEl.textContent !== t("widget.session")) {
        setText(footerLeadEl, t("widget.session"));
      }
    }
    setStatValue(totalUpEl, formatBytes(stats.totalUp), stats.totalUp === 0);
    setStatValue(totalDownEl, formatBytes(stats.totalDown), stats.totalDown === 0);
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
    if (securedBadge !== null && securedText !== null) {
      const connected = status === "connected";
      const degraded = connected && encryptionDegraded;
      const wasDegraded = securedBadge.classList.contains("vw-secured--degraded");
      securedBadge.classList.toggle("vw-secured--degraded", degraded);
      if (degraded !== wasDegraded) {
        securedBadge.querySelector("svg")?.remove();
        securedBadge.prepend(createIcon(degraded ? "shield-alert" : "shield-check", 12));
      }
      if (degraded) {
        setText(securedText, t("widget.unsecured"));
        securedBadge.title = t("encryption.unsecuredLabel");
      } else {
        setText(securedText, t("widget.secured"));
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
    // A DM call's name is a link back to the DM, where the call panel is.
    const asLink = dm !== undefined && options.onOpenCall !== undefined;
    if (asLink !== channelNameEl instanceof HTMLButtonElement) {
      const next = asLink ? createChannelLink() : createElement("span", { class: "vw-channel" });
      channelNameEl.replaceWith(next);
      channelNameEl = next;
    }
    linkedChannelId = asLink ? channelId : null;
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
    // The screen-share active state lives entirely on the button: the
    // aria-pressed state, the icon swap and the active-control tint. The old
    // squeezed "Sharing" text label is gone.
    shareBtn?.classList.toggle("active-ctrl", voice.localScreenshare);
    if (shareBtn) {
      swapIcon(shareBtn, voice.localScreenshare ? "monitor-off" : "monitor");
      shareBtn.setAttribute("aria-pressed", String(voice.localScreenshare));
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
      const text = !voice.listenOnly
        ? ""
        : micRetryFailed
          ? t("widget.listenOnlyBlocked")
          : t("widget.listenOnlyHint");
      // Set only on change: render() runs on unrelated store updates, and a
      // screen reader can re-read a replaced text node even when identical,
      // which would break the "announced once" goal.
      if (micNoticeEl.textContent !== text) setText(micNoticeEl, text);
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

  function createChannelLink(): HTMLButtonElement {
    const link = createElement("button", {
      type: "button",
      class: "vw-channel vw-channel-link",
      title: t("call.goToCall"),
      "data-testid": "vw-channel-link",
    });
    link.addEventListener(
      "click",
      () => {
        if (linkedChannelId !== null) options.onOpenCall?.(linkedChannelId);
      },
      { signal: disposable.signal },
    );
    return link;
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "voice-widget", "data-testid": "voice-widget" });

    // Header, two lines: lifecycle status + elapsed timer, then the channel
    // name + a small Secured chip + the signal/ping button.
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
    securedText = createElement("span", {}, t("widget.secured"));
    appendChildren(securedBadge, createIcon("shield-check", 12), securedText);
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

    const headerMain = createElement("div", { class: "vw-header-main" });
    appendChildren(headerMain, statusLabel, timerEl);
    const headerSub = createElement("div", { class: "vw-header-sub" });
    appendChildren(headerSub, channelNameEl, securedBadge, signalWrap);
    appendChildren(header, headerMain, headerSub);

    // Expanded stats pane (hidden by default): Upload and Download tiles,
    // then one footer line with the RTT (once known) and the session totals.
    // The old visible "Transport Statistics" title is the pane's name now.
    statsPane = createElement("div", {
      class: "vw-stats",
      role: "group",
      "aria-label": t("widget.transportStatistics"),
    });
    const statsGrid = createElement("div", { class: "vw-stats-grid" });
    const upload = statTile("\u2191", t("widget.upload"));
    outRateEl = upload.rate;
    outPacketsEl = upload.packets;
    const download = statTile("\u2193", t("widget.download"));
    inRateEl = download.rate;
    inPacketsEl = download.packets;
    for (const dir of [upload, download]) {
      setStatValue(dir.rate, t("widget.idle"), true);
      setText(dir.packets, packetText(0));
    }
    appendChildren(statsGrid, upload.tile, download.tile);

    const footer = createElement("div", { class: "vw-stats-footer" });
    footerLeadEl = createElement("span", { class: "vw-stats-footer-lead" }, t("widget.session"));
    rttEl = createElement("span", { class: "vw-stat-value" });
    const totalsRow = createElement("span", { class: "vw-stats-totals" });
    totalUpEl = createElement("span", { class: "vw-stat-value" });
    totalDownEl = createElement("span", { class: "vw-stat-value" });
    setStatValue(totalUpEl, t("widget.zeroBytes"), true);
    setStatValue(totalDownEl, t("widget.zeroBytes"), true);
    const upWrap = createElement("span", { class: "vw-stat-total" });
    upWrap.appendChild(createElement("span", { class: "vw-stat-arrow" }, "\u2191"));
    upWrap.appendChild(totalUpEl);
    const downWrap = createElement("span", { class: "vw-stat-total" });
    downWrap.appendChild(createElement("span", { class: "vw-stat-arrow" }, "\u2193"));
    downWrap.appendChild(totalDownEl);
    appendChildren(totalsRow, upWrap, downWrap);
    appendChildren(footer, footerLeadEl, totalsRow);

    appendChildren(statsPane, statsGrid, footer);

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
      // No `setting-desc`: its margin/font would apply even while this live
      // region is empty (it stays rendered but empty outside listen-only mode
      // so a screen reader hears it fill, not appear filled), adding a stray
      // gap to every voice session. `.vw-mic-notice` owns its own type.
      class: "vw-mic-notice",
      "data-testid": "vw-mic-notice",
      role: "status",
      "aria-live": "polite",
    });

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
    securedText = null;
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
    footerLeadEl = null;
    inRateEl = null;
    inPacketsEl = null;
    totalUpEl = null;
    totalDownEl = null;
  }

  return { mount, destroy };
}
