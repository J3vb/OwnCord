/**
 * VoiceWidget component — shows active voice channel info with controls.
 * Hidden when not connected to a voice channel.
 * Users are displayed under the voice channel in the sidebar, NOT here.
 * Step 6.50
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon, swapIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/text/safeRender";
import { voiceStore, type VoiceState } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { uiStore } from "@stores/ui.store";
import {
  createConnectionStatsPoller,
  type ConnectionStats,
  type ConnectionStatsPoller,
} from "@lib/voice/connectionStats";
import { enhancedNoiseSuppressionEnabled } from "@lib/voice/audioPipeline";
import { getRoomForStats, reapplyEnhancedNoiseSuppression } from "@lib/voice/livekitSession";
import { loadPref, onPrefChange, savePref } from "@lib/prefs/preferences";
import { voiceText as t } from "../../i18n/voice";
import { callStatusText, isConnecting, isPhoneCallHold } from "./voiceStatusText";
import { shareBlockReason } from "./shareGate";
import { canPublishScreen } from "./native/platform";
import { createSecuredBadge, type SecuredBadge } from "./securedBadge";
import type { StreamCard } from "./voiceWidget/streamCard";
import {
  createSignalButton,
  createStatsPane,
  type SignalButton,
  type StatsPane,
} from "./widget/statsPane";
import { subscribeVoiceWidget } from "./widget/subscriptions";
import { isShareLive } from "./widget/liveShare";
import { createListenOnlyUi, type ListenOnlyUi } from "./widget/listenOnly";
import { formatDuration } from "@lib/text/duration";

export interface VoiceWidgetOptions {
  onDisconnect(): void;
  onCameraToggle(): void;
  onScreenshareToggle(): void;
  /** Open the call's channel: the DM for a DM call, the call view for a guild
   *  voice channel. Without it the call name is plain text. */
  onOpenCall?(channelId: number): void;
}

/** The moderator-imposed state as a sentence, or "" when there is none. */
function moderationText(serverMuted: boolean, serverDeafened: boolean): string {
  if (serverMuted && serverDeafened) return t("widget.moderatedMutedDeafened");
  if (serverMuted) return t("widget.mutedByModerator");
  if (serverDeafened) return t("widget.deafenedByModerator");
  return "";
}

export function createVoiceWidget(options: VoiceWidgetOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let channelNameEl: HTMLElement | null = null;
  /** The call the name link opens; read at click time. */
  let linkedChannelId: number | null = null;
  let statusLabel: HTMLSpanElement | null = null;
  let securedBadge: SecuredBadge | null = null;
  let controlsRow: HTMLDivElement | null = null;
  let cameraBtn: HTMLButtonElement | null = null;
  let shareBtn: HTMLButtonElement | null = null;
  let disconnectBtn: HTMLButtonElement | null = null;
  /** Quick toggle for the Enhanced Noise Suppression pref Settings also sets. */
  let nsBtn: HTMLButtonElement | null = null;
  /** The stream card while you share; loaded on the first share. */
  let streamCard: StreamCard | null = null;
  /** Owns the current card's listeners; aborted when the card goes. */
  let streamCardScope: Disposable | null = null;
  let streamCardLoad = 0;
  /** Persistent polite status for a moderator-imposed mute/deafen. The
   *  disabled controls carry only a `title`, which a screen reader never
   *  reaches (a disabled button cannot take focus), so the reason is announced
   *  here instead — once, when it appears. */
  let modStatusEl: HTMLDivElement | null = null;

  // Listen-only mode: "Grant Microphone" button + its persistent explanation.
  let listenOnly: ListenOnlyUi | null = null;

  // Connection stats
  let signalBtn: SignalButton | null = null;
  let statsPane: StatsPane | null = null;
  let statsPoller: ConnectionStatsPoller | null = null;
  let statsUnlisten: (() => void) | null = null;

  // Elapsed timer
  let timerEl: HTMLSpanElement | null = null;
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  const unsubs: Array<() => void> = [];

  function updateSignalIcon(stats: ConnectionStats): void {
    if (signalBtn === null || statsPane === null) return;
    signalBtn.draw(stats);
    statsPane.update(stats);
  }

  function startStatsPoller(): void {
    if (statsPoller !== null) return;
    statsPoller = createConnectionStatsPoller(() => getRoomForStats());
    statsUnlisten = statsPoller.onUpdate(updateSignalIcon);
    // The stats pane opens only on demand. A quality change updates the signal
    // bars via onUpdate, but never expands the pane on its own.
    statsPoller.start();
    // Paint the initial state now. updateSignalIcon only runs on a sample;
    // where none arrives (the first poll is 2 s out, or the native host has
    // no sample) the widget would otherwise keep its constructed
    // 4-green-bars default.
    updateSignalIcon(statsPoller.getStats());
  }

  function stopStatsPoller(): void {
    statsUnlisten?.();
    statsUnlisten = null;
    statsPoller?.stop();
    statsPoller = null;
  }

  function updateElapsedTimer(): void {
    const joinedAt = voiceStore.getState().joinedAt;
    if (timerEl === null || joinedAt === null) return;
    setText(timerEl, formatDuration(Date.now() - joinedAt, true));
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
   *  `encryptionDegraded` is the SDK's own signal — via
   *  RoomEvent.EncryptionError, wired in livekitSession.ts's createRoom() —
   *  that the E2EE worker died after the key exchange already succeeded.
   *  voiceStatus alone reaches "connected" in that case, so the badge must
   *  never claim "Secured" from voiceStatus in isolation: it renders a
   *  distinct, still-visible not-secured warning instead of just hiding. */
  function updateStatus(voice: VoiceState): void {
    const status = voice.voiceStatus;
    if (statusLabel !== null) {
      setText(statusLabel, callStatusText(voice));
      statusLabel.classList.toggle("vw-securing", status === "securing");
      statusLabel.classList.toggle("vw-reconnecting", status === "reconnecting");
      statusLabel.classList.toggle("vw-paused", isPhoneCallHold(voice));
    }
    securedBadge?.sync(status === "connected", voice.encryptionDegraded === true);
  }

  /** A live control's tooltip: what a press does next. */
  function liveTitle(btn: HTMLButtonElement): string {
    const { localCamera, localScreenshare } = voiceStore.getState();
    if (btn === cameraBtn) {
      return localCamera ? t("widget.control.cameraOff") : t("widget.control.cameraOn");
    }
    if (btn === shareBtn) {
      return localScreenshare ? t("widget.control.shareStop") : t("widget.control.shareStart");
    }
    return "";
  }

  /** Freeze controls that need WS signaling, while keeping local hangup
   *  available: the LiveKit call may still be live when chat is disconnected.
   *  Mute and deafen live in the user panel (UserBar). */
  function updateFrozen(status: "connected" | "reconnecting" | "disconnected"): void {
    const frozen = status !== "connected";
    const reason =
      status === "reconnecting" ? t("status.reconnectingShort") : t("status.notConnected");
    controlsRow?.classList.toggle("vw-controls--frozen", frozen);
    for (const btn of [cameraBtn, shareBtn, listenOnly?.grantBtn ?? null]) {
      if (btn === null) continue;
      btn.disabled = frozen;
      btn.title = frozen ? reason : liveTitle(btn);
    }
    // Camera and share need the room, which exists only once the join has
    // connected; before that the press would bounce off.
    const joining = isConnecting(voiceStore.getState().voiceStatus);
    for (const btn of [cameraBtn, shareBtn]) {
      if (btn === null || frozen || !joining) continue;
      btn.disabled = true;
      btn.title = t("status.joining");
    }
    const block = shareBlockReason(voiceStore.getState());
    if (shareBtn !== null && !shareBtn.disabled && block !== null) {
      shareBtn.disabled = true;
      shareBtn.title = block;
    }
  }

  function renderNs(): void {
    if (nsBtn === null) return;
    nsBtn.disabled = !loadPref("noiseSuppression", true);
    nsBtn.setAttribute("aria-pressed", String(enhancedNoiseSuppressionEnabled()));
  }

  /** The call's name: a DM call resolves through the DM store rather than the
   *  channels store, whose row for a DM is synthesised when the conversation is
   *  opened, so accepting a call for a DM the user has not looked at yet would
   *  otherwise label the call "Voice Channel". The name is a link back to the
   *  call: the DM for a DM call, where the call panel is, or the guild voice
   *  channel's call view. A call whose channel is not known yet stays plain
   *  text. */
  function renderChannelName(channelId: number): void {
    if (channelNameEl === null) return;
    const channel = channelsStore.getState().channels.get(channelId);
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    const asLink =
      options.onOpenCall !== undefined && (dm !== undefined || channel?.type === "voice");
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
  }

  /** Announce a moderator-imposed state once (render runs on every store
   *  change; the text only changes when the state actually does, so a screen
   *  reader does not re-read it on unrelated updates). */
  function renderModStatus(serverMuted: boolean, serverDeafened: boolean): void {
    if (modStatusEl === null) return;
    const text = moderationText(serverMuted, serverDeafened);
    if (modStatusEl.textContent !== text) setText(modStatusEl, text);
  }

  /** The camera and share buttons' active state lives entirely on the button:
   *  the aria-pressed state, the icon swap and the active-control tint. */
  function renderMediaButtons(camera: boolean, screenshare: boolean): void {
    cameraBtn?.classList.toggle("active-ctrl", camera);
    if (cameraBtn) {
      swapIcon(cameraBtn, camera ? "camera-off" : "camera");
      cameraBtn.setAttribute("aria-pressed", String(camera));
    }
    shareBtn?.classList.toggle("active-ctrl", screenshare);
    if (shareBtn) {
      swapIcon(shareBtn, screenshare ? "monitor-off" : "monitor");
      shareBtn.setAttribute("aria-pressed", String(screenshare));
    }
  }

  function render(): void {
    if (root === null || channelNameEl === null) return;

    const voice = voiceStore.getState();
    const channelId = voice.currentChannelId;
    syncStreamCard(isShareLive(voice));

    if (channelId === null) {
      root.classList.remove("visible");
      stopStatsPoller();
      stopElapsedTimer();
      statsPane?.el.classList.remove("visible");
      return;
    }

    root.classList.add("visible");
    startStatsPoller();
    startElapsedTimer();
    updateStatus(voice);
    updateFrozen(uiStore.getState().connectionStatus);
    renderChannelName(channelId);
    renderModStatus(voice.localServerMuted === true, voice.localServerDeafened === true);
    renderMediaButtons(voice.localCamera, voice.localScreenshare);
    listenOnly?.sync(voice.listenOnly);
  }

  function syncStreamCard(sharing: boolean): void {
    if (!sharing) {
      streamCardLoad++;
      streamCardScope?.destroy();
      streamCardScope = null;
      streamCard?.el.remove();
      streamCard = null;
      return;
    }
    if (streamCard !== null) {
      streamCard.update();
      return;
    }
    const load = ++streamCardLoad;
    void import("./voiceWidget/streamCard").then(({ createStreamCard }) => {
      if (load !== streamCardLoad || root === null || controlsRow === null) return;
      streamCardScope = new Disposable();
      streamCard = createStreamCard(options.onScreenshareToggle, streamCardScope.signal);
      root.insertBefore(streamCard.el, controlsRow);
    });
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

  function toggleStatsPane(): void {
    if (statsPane === null || signalBtn === null) return;
    const open = statsPane.el.classList.toggle("visible");
    signalBtn.el.setAttribute("aria-expanded", String(open));
  }

  function createNoiseButton(): HTMLButtonElement {
    const nsLabel = t("widget.control.noiseSuppression");
    const btn = createElement("button", {
      type: "button",
      class: "vw-ns",
      "aria-label": nsLabel,
      title: nsLabel,
      "data-testid": "vw-ns",
    });
    btn.appendChild(createIcon("audio-lines", 14));
    btn.addEventListener(
      "click",
      () => {
        savePref("enhancedNoiseSuppression", !loadPref("enhancedNoiseSuppression", false));
        void reapplyEnhancedNoiseSuppression();
      },
      { signal: disposable.signal },
    );
    return btn;
  }

  /** Header, two lines: lifecycle status + elapsed timer, then the channel
   *  name + a small Secured chip + the signal/ping button. */
  function buildHeader(): HTMLDivElement {
    const header = createElement("div", { class: "vw-header" });
    statusLabel = createElement("span", {
      class: "vw-connected",
      "data-testid": "vw-status",
    });
    setText(statusLabel, t("status.connected"));
    // Persistent E2EE affirmation, shown only once the room key is ready.
    securedBadge = createSecuredBadge("vw-secured");
    timerEl = createElement("span", { class: "vw-timer" }, "00:00");
    channelNameEl = createElement("span", { class: "vw-channel" }, t("widget.channelFallback"));
    signalBtn = createSignalButton(toggleStatsPane, disposable.signal);

    const headerMain = createElement("div", { class: "vw-header-main" });
    appendChildren(headerMain, statusLabel, timerEl);
    nsBtn = createNoiseButton();
    // savePref announces every change, so a toggle in Settings shows here too.
    onPrefChange(["noiseSuppression", "enhancedNoiseSuppression"], renderNs, disposable.signal);
    renderNs();

    const headerSub = createElement("div", { class: "vw-header-sub" });
    appendChildren(headerSub, channelNameEl, securedBadge.el, signalBtn.el, nsBtn);
    appendChildren(header, headerMain, headerSub);
    return header;
  }

  function buildControls(): HTMLDivElement {
    const controls = createElement("div", { class: "vw-controls" });
    controlsRow = controls;
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
    // A phone can watch a share but not start one.
    if (!canPublishScreen()) {
      appendChildren(controls, cameraBtn, disconnectBtn);
    } else {
      appendChildren(controls, cameraBtn, shareBtn, disconnectBtn);
    }
    return controls;
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "voice-widget", "data-testid": "voice-widget" });
    const header = buildHeader();
    statsPane = createStatsPane();
    const controls = buildControls();
    listenOnly = createListenOnlyUi(disposable.signal, render);

    // A live region present from mount (screen readers skip one inserted
    // already filled) that only fills when a moderator-imposed state lands.
    modStatusEl = createElement("div", {
      class: "vw-mod-status sr-only",
      role: "status",
      "aria-live": "polite",
      "data-testid": "vw-mod-status",
    });

    appendChildren(
      root,
      header,
      statsPane.el,
      modStatusEl,
      listenOnly.grantBtn,
      listenOnly.noticeEl,
      controls,
    );

    render();
    unsubs.push(...subscribeVoiceWidget(render));
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
    cameraBtn = null;
    nsBtn = null;
    shareBtn = null;
    disconnectBtn = null;
    streamCardScope?.destroy();
    streamCardScope = null;
    streamCard = null;
    streamCardLoad++;
    modStatusEl = null;
    listenOnly?.dispose();
    listenOnly = null;
    signalBtn = null;
    timerEl = null;
    statsPane = null;
  }

  return { mount, destroy };
}
