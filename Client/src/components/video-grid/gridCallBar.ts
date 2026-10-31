/**
 * The video grid's call view: the control bar, the view toggles, popping the
 * whole call out, and per-tile stream stats.
 */
import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { showToast } from "@lib/ui/toast";
import { loadPref, savePref } from "@lib/prefs/preferences";
import { voiceText } from "../../i18n/voice";
import type { StreamSample } from "../../features/voice/remoteTracks";
import { canPublishScreen, isAndroidApp } from "../../features/voice/native/platform";
import { openPopoutWindow } from "../../features/voice/popout";
import { STATS_POLL_MS, VIEW_PREFS, type ViewToggle, log, callButton, sizeOf } from "./gridShared";
import type { GridState, GridApi } from "./gridState";
import type { VideoGridCallbacks } from "../VideoGrid";

export function createGridCallBar(st: GridState, api: GridApi) {
  /** `inCallView` is the call view's own bar (not a full-screen tile's): on a
   *  phone it also holds Chat, the way back to the text channel. */
  function buildCallControls(
    cc: NonNullable<VideoGridCallbacks["callControls"]>,
    inCallView = false,
  ): HTMLElement {
    const bar = createElement("div", {
      class: "video-fs-calls",
      role: "toolbar",
      "aria-label": voiceText("tile.callControls"),
    });
    appendChildren(
      bar,
      callButton(voiceText("widget.control.mute"), "mic", "mute", cc.onMuteToggle),
      callButton(voiceText("widget.control.deafen"), "headphones", "deafen", cc.onDeafenToggle),
    );
    if (cc.onCameraToggle !== undefined) {
      const onCamera = cc.onCameraToggle;
      bar.appendChild(
        callButton(voiceText("widget.control.cameraOn"), "camera", "camera", onCamera),
      );
      const onDevice = cc.onCameraDevice;
      if (onDevice !== undefined) {
        const pick: HTMLButtonElement = callButton(
          voiceText("call.chooseCamera"),
          "chevron-up",
          "camera-device",
          () => onDevice(pick, st.gridListeners.signal),
          " video-fs-btn--device",
        );
        pick.setAttribute("aria-haspopup", "menu");
        bar.appendChild(pick);
      }
      const flip = cc.cameraFlip;
      if (flip !== undefined) {
        const flipBtn = callButton(
          voiceText("call.flipCamera"),
          "switch-camera",
          "camera-flip",
          () => {
            if (st.flipping) return;
            st.flipping = true;
            redrawCallBars();
            void flip
              .flip()
              .catch((err: unknown) => log.warn("Camera flip failed", err))
              .finally(() => {
                st.flipping = false;
                redrawCallBars();
              });
          },
        );
        flipBtn.hidden = true;
        bar.appendChild(flipBtn);
      }
    }
    if (!canPublishScreen()) {
      // A phone can watch a share but not start one: no share button.
    } else if (cc.onScreenshareToggle !== undefined) {
      const toggle = cc.onScreenshareToggle;
      // Starting a share opens its picker in the app window: the call comes
      // back there first, so the picker is in view.
      const onShare = (): void => {
        if (st.callPop !== null && st.callState.screenshare !== true) closeCallPopout(true);
        toggle();
      };
      bar.appendChild(
        callButton(voiceText("widget.control.shareStart"), "monitor", "share", onShare),
      );
    }
    const showChat = st.callbacks.onExitGrid;
    if (inCallView && showChat !== undefined) {
      // Hidden off a phone, where the view bar's own chat control does this.
      bar.appendChild(
        callButton(
          voiceText("grid.showChat"),
          "message-square",
          "chat",
          () => {
            api.setFocusedTile(null);
            showChat();
          },
          " video-fs-btn--chat",
        ),
      );
    }
    appendChildren(
      bar,
      callButton(
        voiceText("tile.leaveCall"),
        "phone-off",
        "leave",
        cc.onLeave,
        " video-fs-btn--leave",
      ),
    );
    drawCallState(bar);
    return bar;
  }

  function drawCallState(bar: Element): void {
    const mute = bar.querySelector<HTMLButtonElement>("[data-call-control='mute']");
    const deafen = bar.querySelector<HTMLButtonElement>("[data-call-control='deafen']");
    if (mute !== null) {
      mute.setAttribute("aria-pressed", String(st.callState.muted));
      mute.querySelector("svg")?.remove();
      mute.appendChild(
        createIcon(st.callState.muted || st.callState.listenOnly ? "mic-off" : "mic", 18),
      );
      mute.disabled = st.callState.listenOnly || st.callState.serverMuted === true;
      mute.title = voiceText(
        st.callState.serverMuted === true
          ? "widget.mutedByModerator"
          : st.callState.listenOnly
            ? "widget.control.listenOnly"
            : "widget.control.mute",
      );
    }
    if (deafen !== null) {
      deafen.setAttribute("aria-pressed", String(st.callState.deafened));
      deafen.querySelector("svg")?.remove();
      deafen.appendChild(createIcon(st.callState.deafened ? "headphones-off" : "headphones", 18));
      deafen.disabled = st.callState.serverDeafened === true;
      deafen.title = voiceText(
        st.callState.serverDeafened === true
          ? "widget.deafenedByModerator"
          : "widget.control.deafen",
      );
    }
    const camera = bar.querySelector<HTMLButtonElement>("[data-call-control='camera']");
    if (camera !== null) {
      const on = st.callState.camera === true;
      drawMediaButton(camera, on, on ? "camera-off" : "camera");
      const label = voiceText(on ? "widget.control.cameraOff" : "widget.control.cameraOn");
      camera.setAttribute("aria-label", label);
      camera.title = mediaLockReason() ?? label;
    }
    const pick = bar.querySelector<HTMLButtonElement>("[data-call-control='camera-device']");
    if (pick !== null) {
      pick.disabled = mediaLockReason() !== null;
      // Its menu opens in the app window.
      pick.style.display = st.callPop === null ? "" : "none";
    }
    const flip = bar.querySelector<HTMLButtonElement>("[data-call-control='camera-flip']");
    if (flip !== null) {
      syncFlipCheck();
      flip.hidden = st.callState.camera !== true || st.flipCheck !== "yes";
      flip.disabled = st.flipping || mediaLockReason() !== null;
    }
    const share = bar.querySelector<HTMLButtonElement>("[data-call-control='share']");
    if (share !== null) {
      const on = st.callState.screenshare === true;
      drawMediaButton(share, on, on ? "monitor-off" : "monitor");
      const label = voiceText(on ? "widget.control.shareStop" : "widget.control.shareStart");
      share.setAttribute("aria-label", label);
      share.title = mediaLockReason() ?? st.callState.shareBlock ?? label;
      if (st.callState.shareBlock !== undefined) share.disabled = true;
    }
  }

  function redrawCallBars(): void {
    for (const bar of st.root?.querySelectorAll(".video-fs-calls") ?? []) drawCallState(bar);
  }

  /** Ask whether the flip can show when the camera comes on; forget the
   *  answer when it goes off, since a "no" before the camera permission was
   *  granted may be a "yes" now. */
  function syncFlipCheck(): void {
    const flip = st.callbacks.callControls?.cameraFlip;
    if (st.callState.camera !== true) {
      // A check still running belongs to the camera-on that just ended.
      if (st.flipCheck !== "idle") st.flipCheckGen++;
      st.flipCheck = "idle";
      return;
    }
    if (flip === undefined || st.flipCheck !== "idle") return;
    st.flipCheck = "checking";
    const gen = st.flipCheckGen;
    const settle = (ok: boolean): void => {
      if (gen !== st.flipCheckGen) return;
      st.flipCheck = ok ? "yes" : "no";
      redrawCallBars();
    };
    void flip.available().then(settle, () => settle(false));
  }

  /** Why camera and share are inert now, or null: the chat socket is down,
   *  or the join has not reached the room yet. */
  function mediaLockReason(): string | null {
    if (st.callState.offline === "reconnecting") return voiceText("status.reconnectingShort");
    if (st.callState.offline === "disconnected") return voiceText("status.notConnected");
    if (st.callState.connecting === true) return voiceText("status.joining");
    return null;
  }

  /** Camera or share: pressed while on, inert while locked. */
  function drawMediaButton(btn: HTMLButtonElement, on: boolean, icon: IconName): void {
    btn.setAttribute("aria-pressed", String(on));
    btn.querySelector("svg")?.remove();
    btn.appendChild(createIcon(icon, 18));
    btn.disabled = mediaLockReason() !== null;
  }

  // --- Call view: view toggles and control bar --------------------------------

  const VIEW_TOGGLES: readonly [ViewToggle, string, IconName][] = [
    ["nonVideo", voiceText("grid.showNonVideo"), "user"],
    ["selfCamera", voiceText("grid.showMyCamera"), "camera"],
    ["strip", voiceText("grid.showStrip"), "layout-grid"],
  ];

  function buildViewBar(): HTMLElement {
    const bar = createElement("div", {
      class: "video-grid__views",
      role: "toolbar",
      "aria-label": voiceText("grid.viewOptions"),
    });
    for (const [key, label, icon] of VIEW_TOGGLES) {
      const btn = createElement("button", {
        type: "button",
        class: "video-grid__view",
        "aria-label": label,
        title: label,
        "data-view-toggle": key,
      });
      btn.appendChild(createIcon(icon, 18));
      btn.addEventListener("click", () => setView(key, !st.viewOn[key]));
      bar.appendChild(btn);
    }
    // The Android app has one window, so there is nothing to pop out to.
    if (!isAndroidApp()) {
      st.popBtn = createElement("button", {
        type: "button",
        class: "video-grid__view",
        "data-grid-control": "popout",
      });
      st.popBtn.appendChild(createIcon("external-link", 18));
      st.popBtn.addEventListener("click", () => {
        if (st.callPop === null) popOutCall();
        else closeCallPopout(true);
      });
      bar.appendChild(st.popBtn);
    }
    if (st.exitBtn !== null) bar.appendChild(st.exitBtn);
    syncPopButton();
    return bar;
  }

  // --- Pop out the whole call ----------------------------------------------------

  function syncPopButton(): void {
    if (st.exitBtn !== null) st.exitBtn.hidden = !st.callView || st.callPop !== null;
    for (const bar of st.root?.querySelectorAll(".video-fs-calls") ?? []) drawCallState(bar);
    if (st.popBtn === null) return;
    const label = voiceText(st.callPop === null ? "grid.popOutCall" : "grid.popInCall");
    st.popBtn.setAttribute("aria-label", label);
    st.popBtn.title = label;
    st.popBtn.setAttribute("aria-pressed", String(st.callPop !== null));
  }

  /** Move the grid, with its toggles and control bar, into a window of its
   *  own; the app window goes back to the chat. */
  function popOutCall(): void {
    const grid = st.root;
    if (grid === null || st.callPop !== null) return;
    api.dropFullscreen();
    st.callHome = grid.parentElement;
    const frame = createElement("div", { style: "position:fixed;inset:0" });
    st.callPop = openPopoutWindow({
      title: voiceText("grid.popoutTitle"),
      content: frame,
      onDraw: (d, signal) => {
        frame.appendChild(grid);
        d.addEventListener("fullscreenchange", api.onFullscreenChange, { signal });
        d.addEventListener("keydown", api.onTheatreKey, { signal });
        d.addEventListener("visibilitychange", api.syncViews, { signal });
        api.observeGrid();
        for (const entry of st.cells.values()) entry.video.play()?.catch(() => {});
      },
      onClosed: (byUser) => bringCallBack(byUser),
    });
    if (st.callPop === null) {
      log.warn("Call pop out window refused");
      showToast(voiceText("tile.popoutFailed"), "error");
      return;
    }
    syncPopButton();
    st.callbacks.onCallPopout?.(true, false);
    api.relayout();
    api.syncViews();
  }

  function closeCallPopout(restore: boolean): void {
    if (st.callPop === null) return;
    st.popRestore = restore;
    st.callPop.close();
  }

  /** The call's window closed: the grid goes back to the app window. */
  function bringCallBack(byUser: boolean): void {
    const restore = byUser || st.popRestore;
    st.popRestore = true;
    api.dropFullscreen();
    st.callPop = null;
    if (st.root !== null) st.callHome?.appendChild(st.root);
    st.callHome = null;
    api.observeGrid();
    syncPopButton();
    st.callbacks.onCallPopout?.(false, restore);
    for (const entry of st.cells.values()) entry.video.play()?.catch(() => {});
    if (restore) st.popBtn?.focus();
    api.relayout();
    api.syncViews();
  }

  /** Turn a view toggle on or off, and remember it. */
  function setView(key: ViewToggle, on: boolean): void {
    st.viewOn[key] = on;
    savePref(VIEW_PREFS[key], on);
    api.relayout();
    syncViewBar();
    syncStatsPolling();
    api.syncViews();
  }

  /** Each toggle's pressed state; the strip toggle only in focus mode. */
  function syncViewBar(): void {
    if (st.viewBar === null) return;
    for (const btn of st.viewBar.querySelectorAll<HTMLButtonElement>("[data-view-toggle]")) {
      const key = btn.dataset["viewToggle"] as ViewToggle;
      btn.setAttribute("aria-pressed", String(st.viewOn[key]));
      if (key === "strip") btn.hidden = st.focusedTileId === null;
    }
  }

  function loadViewPrefs(): void {
    for (const key of Object.keys(VIEW_PREFS) as ViewToggle[]) {
      st.viewOn[key] = loadPref(VIEW_PREFS[key], true);
    }
  }

  /** Show or take down the call view's header toggles and control bar. */
  function setCallView(on: boolean): void {
    if (!on) closeCallPopout(false);
    st.callView = on;
    if (st.exitBtn !== null) st.exitBtn.hidden = !on || st.callPop !== null;
    if (st.root === null) return;
    if (on && st.viewBar === null) st.viewBar = buildViewBar();
    if (!on && st.viewBar !== null) {
      if (st.exitBtn !== null) st.root.insertBefore(st.exitBtn, st.root.firstChild);
      st.viewBar.remove();
      st.viewBar = null;
      st.popBtn = null;
    }
    const cc = st.callbacks.callControls;
    if (on && st.callBar === null && cc !== undefined) {
      st.callBar = buildCallControls(cc, true);
      st.callBar.classList.add("video-grid__controls");
    }
    if (!on && st.callBar !== null) {
      st.callBar.remove();
      st.callBar = null;
    }
    st.root.classList.toggle("video-grid--call", st.callBar !== null);
    api.appendChrome();
    api.relayout();
  }

  // --- Stream info -------------------------------------------------------------

  /** Poll the screen share you are watching (focused or full screen), and
   *  only it: a camera tile has no quality chip. */
  function syncStatsPolling(): void {
    const target = st.fullscreenTile ?? st.theatreTile ?? st.focusedTileId;
    const entry = target === null ? undefined : st.cells.get(target);
    const wanted =
      entry?.config?.isScreenshare === true && !entry.config.isSelf && entry.ending === undefined
        ? target
        : null;
    if (wanted === st.statsTile) return;
    if (st.statsTimer !== null) {
      clearInterval(st.statsTimer);
      st.statsTimer = null;
    }
    st.statsTile = wanted;
    if (wanted === null) return;
    const poll = (): void => void pollStats(wanted);
    poll();
    st.statsTimer = setInterval(poll, STATS_POLL_MS);
  }

  async function pollStats(tileId: number): Promise<void> {
    const entry = st.cells.get(tileId);
    if (entry === undefined) return;
    let sample: StreamSample | null = null;
    try {
      sample = (await st.callbacks.getStreamStats?.(tileId)) ?? null;
    } catch (err) {
      log.debug("Stream stats unavailable", { tileId, err });
    }
    // Loaded on first use: only a watched stream needs the readout.
    st.infoModule ??= await import("./streamInfo");
    const { chipText, renderStats, streamInfo } = st.infoModule;
    if (st.statsTile !== tileId || st.cells.get(tileId) !== entry) return;
    const info = sample !== null ? streamInfo(sample, entry.prevSample) : sizeOf(entry.video);
    if (sample !== null) entry.prevSample = sample;
    const chip = entry.el.querySelector<HTMLButtonElement>(".video-quality");
    const text = chipText(info);
    if (chip !== null) {
      chip.hidden = text === null;
      if (text !== null) {
        chip.textContent = text.text;
        chip.setAttribute("aria-label", text.label);
      }
    }
    const pop = entry.el.querySelector<HTMLElement>(".video-stats");
    if (pop !== null) renderStats(pop, entry.name, info);
    st.lastInfo.set(tileId, info);
  }

  function toggleStats(tileId: number, chip: HTMLButtonElement): void {
    const entry = st.cells.get(tileId);
    if (entry === undefined) return;
    const open = entry.el.querySelector<HTMLElement>(".video-stats");
    if (open !== null) {
      open.remove();
      chip.setAttribute("aria-expanded", "false");
      return;
    }
    const pop = createElement("div", {
      class: "video-stats",
      role: "dialog",
      "aria-label": voiceText("tile.stats"),
      tabindex: "-1",
    });
    st.infoModule?.renderStats(pop, entry.name, st.lastInfo.get(tileId) ?? {});
    pop.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || isImeCommit(e)) return;
        e.stopPropagation();
        pop.remove();
        chip.setAttribute("aria-expanded", "false");
        chip.focus();
      },
      { signal: entry.listeners.signal },
    );
    entry.el.appendChild(pop);
    chip.setAttribute("aria-expanded", "true");
    pop.focus();
  }

  return {
    buildCallControls,
    drawCallState,
    redrawCallBars,
    syncFlipCheck,
    mediaLockReason,
    drawMediaButton,
    buildViewBar,
    syncPopButton,
    popOutCall,
    closeCallPopout,
    bringCallBack,
    setView,
    syncViewBar,
    loadViewPrefs,
    setCallView,
    syncStatsPolling,
    pollStats,
    toggleStats,
  };
}
