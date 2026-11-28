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
import type { ConnectionStats } from "@lib/voice/connectionStats";
import { enhancedNoiseSuppressionEnabled } from "@lib/voice/audioPipeline";
import { reapplyEnhancedNoiseSuppression } from "./livekitSession";
import { writeLiveStats } from "@lib/voice/liveStats";
import { loadPref, onPrefChange, savePref } from "@lib/prefs/preferences";
import { voiceText as t } from "../../i18n/voice";
import { callStatusText, isConnecting, isPhoneCallHold } from "./voiceStatusText";
import { shareBlockReason } from "./shareGate";
import { canPublishScreen } from "@lib/hostOs";
import { createMusicButton, syncMusicButton, watchMusicSupport } from "./musicControl";
import { createSecuredBadge, type SecuredBadge } from "./securedBadge";
import { createStreamCardHost, type StreamCardHost } from "./widget/streamCardHost";
import { createDeckPopover, type DeckPopover } from "./widget/deckPopover";
import {
  createSignalButton,
  createStatsPane,
  type SignalButton,
  type StatsPane,
} from "./widget/statsPane";
import { subscribeVoiceWidget } from "./widget/subscriptions";
import { createStatsHost } from "./widget/statsHost";
import { isShareLive } from "./widget/liveShare";
import { createListenOnlyUi, type ListenOnlyUi } from "./widget/listenOnly";
import { createListeningBar, type ListeningBar } from "./widget/listeningBar";
import { formatDuration } from "@lib/text/duration";
import { setCallRow } from "./callRowMark";
import { moderationText } from "./widget/moderationText";

export interface VoiceWidgetOptions {
  onDisconnect(): void;
  onCameraToggle(): void;
  onScreenshareToggle(): void;
  /** Open the call's channel: the DM for a DM call, the call view for a guild
   *  voice channel. Without it the call name is plain text. */
  onOpenCall?(channelId: number): void;
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
  /** Share music; stays visible (disabled with its reason) where unsupported. */
  let musicBtn: HTMLButtonElement | null = null;
  let disconnectBtn: HTMLButtonElement | null = null;
  /** Quick toggle for the Enhanced Noise Suppression pref Settings also sets. */
  let nsBtn: HTMLButtonElement | null = null;
  /** The share card while you share; loaded on the first share. */
  let shareCard: StreamCardHost | null = null;
  /** Persistent polite status for a moderator-imposed mute/deafen. The
   *  disabled controls carry only a `title`, which a screen reader never
   *  reaches (a disabled button cannot take focus), so the reason is announced
   *  here instead — once, when it appears. */
  let modStatusEl: HTMLDivElement | null = null;

  // Listen-only mode: "Grant Microphone" button + its persistent explanation.
  let listenOnly: ListenOnlyUi | null = null;
  /** "Listening to {name}" with Stop, above the call block while you listen. */
  let listeningBar: ListeningBar | null = null;

  // Connection stats
  let signalBtn: SignalButton | null = null;
  let statsPane: StatsPane | null = null;
  let statsPopover: DeckPopover | null = null;
  const statsHost = createStatsHost(updateSignalIcon, () => statsPane?.resetHistory());

  // Elapsed timer
  let timerEl: HTMLSpanElement | null = null;
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  const unsubs: Array<() => void> = [];

  function updateSignalIcon(stats: ConnectionStats): void {
    writeLiveStats(stats, voiceStore.getState().voiceStatus === "connected");
    if (signalBtn === null || statsPane === null) return;
    signalBtn.draw(stats);
    statsPane.update(stats);
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
      statusLabel.classList.toggle("vw-steady", status === "connected" && !isPhoneCallHold(voice));
    }
    securedBadge?.sync(status === "connected", voice.encryptionDegraded === true);
  }

  /** A live control's tooltip: what a press does next. */
  function liveTitle(btn: HTMLButtonElement): string {
    const { localCamera, localScreenshare } = voiceStore.getState();
    if (btn === cameraBtn) {
      return localCamera ? t("widget.control.cameraOff") : t("widget.control.cameraOn");
    }
    if (btn === shareBtn && shareCard?.opensCard() === true)
      return t("widget.control.shareOptions");
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
    // Camera and share need the room, which exists only once the join has
    // connected; before that the press would bounce off.
    const joining = isConnecting(voiceStore.getState().voiceStatus);
    for (const btn of [cameraBtn, shareBtn, listenOnly?.grantBtn ?? null]) {
      if (btn === null) continue;
      btn.disabled = frozen;
      btn.title = frozen ? reason : liveTitle(btn);
      if (btn === listenOnly?.grantBtn || frozen || !joining) continue;
      btn.disabled = true;
      btn.title = t("status.joining");
    }
    freezeShare();
  }

  /** The share button's own rules over the frozen state. While it opens the
   *  share card (Deck) it stays live: the card's Stop, Quality and Change
   *  source need no chat connection. Otherwise a share the grant or the video
   *  limit rules out is disabled with its reason. */
  function freezeShare(): void {
    if (shareBtn === null) return;
    if (shareCard?.opensCard() === true) {
      shareBtn.disabled = false;
      shareBtn.title = liveTitle(shareBtn);
      return;
    }
    const block = shareBlockReason(voiceStore.getState());
    if (shareBtn.disabled || block === null) return;
    shareBtn.disabled = true;
    shareBtn.title = block;
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
      // A button that opens the share card is not a toggle: aria-expanded
      // and aria-haspopup say what it does instead.
      if (shareCard?.opensCard() === true) shareBtn.removeAttribute("aria-pressed");
      else shareBtn.setAttribute("aria-pressed", String(screenshare));
    }
  }

  function render(): void {
    if (root === null || channelNameEl === null) return;

    const voice = voiceStore.getState();
    const channelId = voice.currentChannelId;
    shareCard?.sync(isShareLive(voice));
    statsHost.sync(voice);

    if (channelId === null) {
      root.classList.remove("visible");
      setCallRow(false);
      stopElapsedTimer();
      statsPopover?.close();
      return;
    }

    root.classList.add("visible");
    setCallRow(true);
    startElapsedTimer();
    statsPopover?.sync();
    updateStatus(voice);
    updateFrozen(uiStore.getState().connectionStatus);
    renderChannelName(channelId);
    renderModStatus(voice.localServerMuted === true, voice.localServerDeafened === true);
    renderMediaButtons(voice.localCamera, voice.localScreenshare);
    if (musicBtn !== null) syncMusicButton(musicBtn, voice);
    listenOnly?.sync(voice.listenOnly);
    listeningBar?.sync(voice);
  }

  function createControlButton(
    label: string,
    icon: IconName,
    handler: (e: MouseEvent) => void,
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

  /** What the popovers sit above: the Deck status bar, so they cover none
   *  of the widget's rows. */
  function statusBarTop(): Element | null {
    return root?.closest(".deck-status-bar") ?? root;
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
    // A click with no pointer (detail 0) came from the keyboard.
    signalBtn = createSignalButton((e) => statsPopover?.toggle(e.detail === 0), disposable.signal);

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
      (e) => (shareCard === null ? options.onScreenshareToggle() : shareCard.press(e.detail === 0)),
      "vw-share-btn",
    );
    musicBtn = createMusicButton(disposable.signal);
    disconnectBtn = createControlButton(
      t("widget.control.disconnect"),
      "phone",
      options.onDisconnect,
      "disconnect",
    );
    // A phone can watch a share but not start one.
    if (!canPublishScreen()) {
      appendChildren(controls, cameraBtn, musicBtn, disconnectBtn);
    } else {
      appendChildren(controls, cameraBtn, shareBtn, musicBtn, disconnectBtn);
    }
    return controls;
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "voice-widget", "data-testid": "voice-widget" });
    const header = buildHeader();
    statsPane = createStatsPane();
    if (signalBtn !== null) {
      statsPopover = createDeckPopover({
        panel: statsPane.el,
        anchor: signalBtn.el,
        openClass: "visible",
        inlineToggle: true,
        signal: disposable.signal,
        base: statusBarTop,
      });
    }
    const controls = buildControls();
    shareCard = createStreamCardHost({
      place: () =>
        root === null || controlsRow === null ? null : { parent: root, before: controlsRow },
      button: () => shareBtn,
      toggleShare: options.onScreenshareToggle,
      base: statusBarTop,
      onChange: () => {
        const { localCamera, localScreenshare } = voiceStore.getState();
        renderMediaButtons(localCamera, localScreenshare);
        updateFrozen(uiStore.getState().connectionStatus);
      },
    });
    listenOnly = createListenOnlyUi(disposable.signal, render);
    listeningBar = createListeningBar(disposable.signal, render);

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
      listeningBar.el,
      header,
      statsPane.el,
      modStatusEl,
      listenOnly.grantBtn,
      listenOnly.noticeEl,
      controls,
    );

    render();
    watchMusicSupport(render, disposable.signal);
    unsubs.push(...subscribeVoiceWidget(render));
    container.appendChild(root);
  }

  function destroy(): void {
    setCallRow(false);
    statsHost.stop();
    stopElapsedTimer();
    shareCard?.destroy();
    shareCard = null;
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
    musicBtn = null;
    disconnectBtn = null;
    modStatusEl = null;
    listenOnly?.dispose();
    listenOnly = null;
    listeningBar = null;
    signalBtn = null;
    timerEl = null;
    statsPane = null;
    statsPopover = null;
  }

  return { mount, destroy };
}
