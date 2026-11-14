/**
 * The channel sidebar's voice rows: a voice channel's wrapper (its chrome, the
 * join click, the drop target) and its participant rows (profile, volume and
 * moderation menu, watch, drag to move), reconciled by user id as the voice
 * inputs change. Owns the indexes the sidebar keeps over them (each
 * participant row by user id, each wrapper by channel) and the focus hand-off
 * when a focused participant leaves; the list render and the listener owners
 * stay with the sidebar, which passes them in.
 */

import { Disposable } from "@lib/disposable";
import { createElement } from "@lib/dom";
import { reconcileModels, sameModel } from "@lib/net/reconcile";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { openMenuOnKeyboard } from "@lib/ui/contextMenu";
import { createLazyScreen } from "../../lib/ui/lazyScreen";
import { getUserLocalMute, getUserVolume } from "@lib/voice/livekitSession";
import { loadPref } from "@lib/prefs/preferences";
import { userMusicMuteKey } from "@lib/voice/audioVolumePrefs";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import type { Channel } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { voiceStore } from "@stores/voice.store";
import type { VoiceUser } from "@stores/voice.store";
import { safetyStore } from "../safety/store";
import { attachVoiceUserDrag, markVoiceDropTarget } from "../voice/dragMove";
import { openPeerShield } from "../voice/peerVerification";
import { joinRetryInMs } from "../voice/joinBackoff";
import { createAvatarElement, pickAvatarColor } from "../profiles/avatar";
import { openUserProfilePopup } from "../profiles/openUserProfilePopup";
import { shellText } from "../../i18n/shell";
import type { ChannelSidebarOptions } from "./channelSidebarTypes";
import {
  drawVoiceChannelChrome,
  drawVoiceUserRow,
  patchVoiceChannelChrome,
  patchVoiceUserRow,
  VOICE_USER_PATCH_FIELDS,
  type VoiceChannelChromeModel,
  type VoiceUserRowModel,
} from "./voiceRow.view";
import {
  channelVoiceUsers,
  voiceChannelChrome,
  voiceUserModel,
  type VoiceRowInputs,
  type VoiceUserContext,
} from "./voiceRowModel";
import { buildVoiceModOptions } from "./voiceModOptions";

// The per-user volume menu loads on its first open.
const volumeMenuScreen = createLazyScreen("user-volume-menu", () => import("./sidebar/volumeMenu"));
// The phone join sheet loads on its first tap.
const joinSheetScreen = createLazyScreen("voice-join-sheet", () => import("./VoiceJoinSheet"));
/** Latest open request per sidebar (keyed by its lifetime signal); an earlier one still loading is dropped. */
const volumeMenuAttempts = new WeakMap<AbortSignal, number>();

/** Where focus sits on a participant row, if it does: its channel, user and
 *  position in that channel's list. */
export interface VoiceFocus {
  readonly channelId: number;
  readonly userId: number;
  readonly index: number;
}

/** The callbacks the voice rows act through. */
export type VoiceRowOptions = Pick<
  ChannelSidebarOptions,
  "onVoiceJoin" | "onOpenCall" | "onVoiceModerate" | "onWatchStream"
>;

export interface VoiceRows {
  /** A voice channel's wrapper, participants included. */
  readonly create: (channel: Channel, signal: AbortSignal) => HTMLDivElement;
  /** Bring a wrapper to the current inputs. */
  readonly update: (el: Element, ch: Channel) => void;
  /** `update` on every live wrapper: the cheap path when occupancy is unchanged. */
  readonly refresh: (channelList: HTMLElement | null) => void;
  readonly captureFocus: (channelList: HTMLElement | null) => VoiceFocus | null;
  readonly restoreFocus: (was: VoiceFocus | null, channelList: HTMLElement | null) => void;
  /** Abort the owner of `el` and of the rows inside it, and drop them from the indexes. */
  readonly disposeOwned: (el: Element) => void;
  /** Close the profile popup and clear the indexes. */
  readonly dispose: () => void;
}

/** Where focus sits now, if it is on a participant row of `channelList`. */
function captureVoiceFocus(channelList: HTMLElement | null): VoiceFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || channelList === null) return null;
  if (!channelList.contains(active)) return null;
  const row = active.closest<HTMLElement>(".voice-users-list > .voice-user-item");
  const list = row?.parentElement ?? null;
  const item = list?.parentElement?.querySelector<HTMLElement>(":scope > .channel-item") ?? null;
  if (row === null || list === null || item === null) return null;
  return {
    channelId: Number(item.dataset.channelId),
    userId: Number(row.dataset.voiceUid),
    index: Array.from(list.children).indexOf(row),
  };
}

/**
 * Open a participant row's per-user volume and moderation menu. The options
 * snapshot is taken now, at click time; the menu code loads on its first open.
 * A newer open supersedes an earlier one still loading (so a double open mounts
 * one menu), and a destroyed sidebar mounts nothing.
 */
function openVolumeMenu(
  channelId: number,
  atEvent: () => VoiceUser,
  onVoiceModerate: VoiceRowOptions["onVoiceModerate"],
  lifetimeSignal: AbortSignal,
  x: number,
  y: number,
): void {
  const user = atEvent();
  const mod = buildVoiceModOptions(channelId, user, onVoiceModerate);
  const username = user.username || shellText("common.unknown");
  const attempt = (volumeMenuAttempts.get(lifetimeSignal) ?? 0) + 1;
  volumeMenuAttempts.set(lifetimeSignal, attempt);
  void volumeMenuScreen
    .load(() => !lifetimeSignal.aborted)
    .then((m) => {
      if (
        m === null ||
        attempt !== volumeMenuAttempts.get(lifetimeSignal) ||
        lifetimeSignal.aborted
      )
        return;
      m.showUserVolumeMenu(user.userId, username, x, y, lifetimeSignal, mod);
      return;
    });
}

export function createVoiceRows(
  options: VoiceRowOptions,
  lifetimeSignal: AbortSignal,
  ownerByEl: WeakMap<Element, Disposable>,
  voiceInputs: () => VoiceRowInputs | undefined,
): VoiceRows {
  const { onVoiceJoin, onOpenCall, onVoiceModerate, onWatchStream } = options;
  /** Closes the profile popup a voice user row opened; dispose() calls it. */
  let closeProfilePopup: (() => void) | null = null;

  /** Each participant row now in the list, by user id: the profile popup's
   *  fallback focus. Set when a row is built; deleted when it is disposed,
   *  only if the map still holds that row (a user moved between channels is
   *  built in the new list before the old row goes). */
  const voiceRowByUserId = new Map<number, HTMLElement>();
  /** Each voice channel's live wrapper, for the refreshes that skip the full
   *  render. Set when the wrapper is built or updated; deleted when it is
   *  disposed, only if the entry is still that element. */
  const voiceWrappers = new Map<number, { el: Element; channel: Channel }>();
  /** The chrome model each voice wrapper was last drawn or patched to. */
  const chromeByEl = new WeakMap<Element, VoiceChannelChromeModel>();
  const voiceCtx: VoiceUserContext = {
    avatarColor: pickAvatarColor,
    // Muted for this client only (the volume menu's Mute, a tile mute, or an
    // older build's volume of 0); the select reruns on USER_LOCAL_MUTE_CHANGED.
    localSilenced: (userId) => getUserLocalMute(userId) || getUserVolume(userId) === 0,
    musicMuted: (userId) => loadPref<boolean>(userMusicMuteKey(userId), false) === true,
    moderation: onVoiceModerate !== undefined,
  };

  /** Open a voice user's profile beside their row. The popup lives on
   *  document.body, so it takes the sidebar-lifetime signal: a voice re-render
   *  while it loads must not drop it. */
  function openProfile(userId: number, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    closeProfilePopup = openUserProfilePopup({
      userId,
      anchorX: rect.right,
      anchorY: rect.top,
      signal: lifetimeSignal,
      fallbackFocus: () => voiceRowByUserId.get(userId) ?? null,
    });
  }

  /** A click on a participant: watch their camera or stream, joining first when
   *  the room is not live; with nothing to watch, open their profile, as in the
   *  member list. */
  function onParticipantClick(row: HTMLElement, channelId: number, user: VoiceUser): void {
    if (onWatchStream === undefined || (!user.camera && !user.screenshare)) {
      openProfile(user.userId, row);
      return;
    }
    // Watching a stream needs a live LiveKit room -- join first.
    if (voiceStore.getState().currentChannelId !== channelId) {
      if (safetyStore.getState().timeout !== null) return;
      if (isPhoneLayout()) {
        openJoinSheet(channelId, row, () => joinAndWatch(channelId, user));
        return;
      }
    }
    joinAndWatch(channelId, user);
  }

  /** Join the room when not in it, then watch the participant's stream. */
  function joinAndWatch(channelId: number, user: VoiceUser): void {
    if (voiceStore.getState().currentChannelId !== channelId) {
      // Read before the join: it refuses inside the wait, and an accepted switch arms one.
      const refused = joinRetryInMs() > 0;
      onVoiceJoin(channelId);
      if (refused) return;
    }
    const voice = voiceStore.getState();
    const live = voice.voiceUsers.get(channelId)?.get(user.userId);
    if (live === undefined || (!live.camera && !live.screenshare)) return;
    const tileId = live.screenshare ? live.userId + SCREENSHARE_TILE_ID_OFFSET : live.userId;
    if (voice.switchingTo === channelId) watchAfterSwitch(channelId, tileId);
    else if (voice.currentChannelId === channelId) onWatchStream?.(tileId);
  }

  /** The phone's confirming sheet: a stray tap in the drawer should not put
   *  you in a call. */
  function openJoinSheet(channelId: number, anchor: HTMLElement, onJoin: () => void): void {
    void joinSheetScreen
      .load(() => !lifetimeSignal.aborted)
      .then((m) => {
        if (m === null || lifetimeSignal.aborted) return;
        m.openVoiceJoinSheet({
          channelId,
          onJoin,
          signal: lifetimeSignal,
          fallbackFocus: () => anchor,
        });
      });
  }

  // Ends the wait below; set while a clicked stream waits for a switch.
  let stopWatchWait: (() => void) | null = null;

  /** Out of another call the join first waits for the server: watch the stream
   *  once the switch lands, and not at all when it is refused. One stream
   *  waits at a time, the one clicked last. */
  function watchAfterSwitch(channelId: number, tileId: number): void {
    stopWatchWait?.();
    const unsubscribe = voiceStore.subscribe((state) => {
      if (state.switchingTo === channelId) return;
      stop();
      if (state.currentChannelId === channelId) onWatchStream?.(tileId);
    });
    const stop = (): void => {
      unsubscribe();
      lifetimeSignal.removeEventListener("abort", stop);
      stopWatchWait = null;
    };
    stopWatchWait = stop;
    lifetimeSignal.addEventListener("abort", stop, { once: true });
  }

  /** The menu and drag handlers of a participant who is not the local user. */
  function bindOtherUserHandlers(
    row: HTMLElement,
    model: VoiceUserRowModel,
    channelId: number,
    atEvent: () => VoiceUser,
    signal: AbortSignal,
  ): void {
    const open = (x: number, y: number): void =>
      openVolumeMenu(channelId, atEvent, onVoiceModerate, lifetimeSignal, x, y);
    row.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        open(e.clientX, e.clientY);
      },
      { signal },
    );
    openMenuOnKeyboard(row, open, signal);
    // Drag onto another voice channel to move them; the menu's "Move to" is
    // the keyboard path to the same command. Bound only where the model
    // draws the row as draggable, so the DOM is the model's draw.
    if (model.draggable && onVoiceModerate !== undefined) {
      attachVoiceUserDrag(
        row,
        channelId,
        model.userId,
        onVoiceModerate.onMove,
        signal,
        lifetimeSignal,
      );
    }
  }

  /** Bind one participant row's handlers. Live data (the user's username,
   *  streams and server mute, the joined channel) is read when an event fires,
   *  through `atEvent`, never kept from the render. */
  function createVoiceUserRow(
    model: VoiceUserRowModel,
    channelId: number,
    atEvent: () => VoiceUser,
  ): HTMLDivElement {
    const row = drawVoiceUserRow(model, createAvatarElement);
    const owner = new Disposable();
    ownerByEl.set(row, owner);
    const { signal } = owner;
    voiceRowByUserId.set(model.userId, row);

    // A blocked peer's shield opens the re-trust prompt, a peer with an
    // identity key their trusted keys. Both show the username, never the
    // nickname: a nickname is user-settable.
    const verifyCls = model.verify?.cls;
    if (verifyCls === "mismatch" || verifyCls === "verified" || verifyCls === "changed") {
      row.querySelector(`:scope > .vu-verify.${verifyCls}`)?.addEventListener(
        "click",
        (e) => {
          e.stopPropagation();
          const username = atEvent().username || shellText("common.unknown");
          // Sidebar-lifetime signal for anything mounted outside this row: a menu
          // or modal on document.body must not be torn down by an unrelated
          // re-render.
          openPeerShield(verifyCls, model.userId, username, lifetimeSignal);
        },
        { signal },
      );
    }

    // Right-click (or Shift+F10 / the Menu key, A11Y-01) for the per-user
    // volume and moderation menu; never on the local user's own row.
    if (!model.self) bindOtherUserHandlers(row, model, channelId, atEvent, signal);

    row.addEventListener(
      "click",
      (e) => {
        // Don't trigger if the right-click menu is open
        if (e.button !== 0) return;
        e.stopPropagation();
        onParticipantClick(row, channelId, atEvent());
      },
      { signal },
    );
    row.addEventListener(
      "keydown",
      (e) => {
        if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        row.click();
      },
      { signal },
    );
    return row;
  }

  /**
   * Bring a voice wrapper to the current inputs: patch its chrome when the
   * chrome model changed, then reconcile its participant rows by user id
   * (speaking patches in place; any other drawn change rebuilds that row).
   * `.voice-users-list` exists only while the channel has people in it.
   */
  function updateVoiceRow(el: Element, ch: Channel): void {
    const inputs = voiceInputs();
    if (inputs === undefined) return;
    const chrome = voiceChannelChrome(ch, inputs);
    const prev = chromeByEl.get(el);
    if (prev !== undefined && !sameModel(prev, chrome)) patchVoiceChannelChrome(el, chrome);
    chromeByEl.set(el, chrome);
    voiceWrappers.set(ch.id, { el, channel: ch });

    const users = channelVoiceUsers(inputs, ch.id);
    let list = el.querySelector<HTMLElement>(":scope > .voice-users-list");
    if (users.length === 0 && list === null) return;
    if (list === null) {
      list = createElement("div", { class: "voice-users-list" });
      el.appendChild(list);
    }
    reconcileModels<VoiceUser, VoiceUserRowModel>(list, users, {
      key: (u) => String(u.userId),
      model: (u) => voiceUserModel(u, ch.id, inputs, voiceCtx),
      patch: { fields: VOICE_USER_PATCH_FIELDS, apply: patchVoiceUserRow },
      create: (model, atEvent) => createVoiceUserRow(model, ch.id, atEvent),
      dispose: disposeOwned,
    });
    if (users.length === 0) list.remove();
  }

  /** A click on a voice channel's own row: open the call when joined, else
   *  join (on a phone, after a confirming sheet). Everything is read now, at
   *  click time: the wrapper is reused across joins and leaves. */
  function onChannelClick(channelId: number, wrapper: HTMLElement): void {
    // Frozen while the WS socket is down or timed out: a no-op, the reason
    // is the row's title.
    const joined = voiceStore.getState().currentChannelId === channelId;
    if (uiStore.getState().connectionStatus !== "connected") return;
    if (!joined && safetyStore.getState().timeout !== null) return;
    if (joined) {
      // A repeat click while this join is still in progress (a double-click,
      // or retrying a slow "securing") must not cancel it: toggling here
      // cycled voice_join/voice_leave several times a second. The voice
      // widget's Disconnect still ends a join in progress.
      const status = voiceStore.getState().voiceStatus;
      if (status === "joining" || status === "securing") return;
      onOpenCall();
    } else if (isPhoneLayout()) {
      openJoinSheet(
        channelId,
        wrapper.querySelector<HTMLElement>(":scope > .channel-item") ?? wrapper,
        () => onVoiceJoin(channelId),
      );
    } else {
      onVoiceJoin(channelId);
    }
  }

  /** A voice channel's wrapper: the chrome, the drop target, the channel
   *  click, then its participant rows, built now so the outer reconcile can
   *  restore focus into them by key. */
  function createVoiceRow(channel: Channel, signal: AbortSignal): HTMLDivElement {
    // The inputs exist from mount() on, before the first render.
    const inputs = voiceInputs();
    // i18n-exempt: developer-facing invariant error, never shown to a user
    if (inputs === undefined) throw new Error("voice row built before the sidebar mounted");
    const wrapper = drawVoiceChannelChrome(voiceChannelChrome(channel, inputs));
    if (onVoiceModerate !== undefined) markVoiceDropTarget(wrapper, channel.id);
    wrapper
      .querySelector(":scope > .channel-item")
      ?.addEventListener("click", () => onChannelClick(channel.id, wrapper), { signal });
    updateVoiceRow(wrapper, channel);
    return wrapper;
  }

  /**
   * A focused participant who left or was moved hands focus to the
   * participant now at their position, else to the channel's own row, never
   * to the page. A kept or rebuilt row keeps focus by itself (the reconciler
   * follows its key), and a wrapper that is gone is the list render's case.
   */
  function restoreVoiceFocus(was: VoiceFocus | null, channelList: HTMLElement | null): void {
    if (was === null || channelList === null) return;
    const entry = voiceWrappers.get(was.channelId);
    if (entry === undefined || !channelList.contains(entry.el)) return;
    const list = entry.el.querySelector(":scope > .voice-users-list");
    const rows = list === null ? [] : Array.from(list.children);
    if (rows.some((r) => (r as HTMLElement).dataset.voiceUid === String(was.userId))) return;
    const next =
      rows.length > 0
        ? rows[Math.min(was.index, rows.length - 1)]
        : entry.el.querySelector(":scope > .channel-item");
    (next as HTMLElement | null | undefined)?.focus();
  }

  /** Run `updateVoiceRow` on every live voice wrapper: the cheap path for a
   *  change that leaves which channels are occupied as it was. */
  function refreshVoiceRows(channelList: HTMLElement | null): void {
    if (channelList === null) return;
    const focus = captureVoiceFocus(channelList);
    for (const { el, channel } of Array.from(voiceWrappers.values())) {
      if (channelList.contains(el)) updateVoiceRow(el, channel);
    }
    restoreVoiceFocus(focus, channelList);
  }

  /** Abort a group's or row's owner and those of the rows inside it,
   *  participant rows included, and forget the ones the sidebar indexes: a
   *  participant row by its user, a wrapper by its channel. */
  function disposeOwned(el: Element): void {
    for (const owned of [
      el,
      ...el.querySelectorAll(".category-channels-container > *, .voice-users-list > *"),
    ]) {
      ownerByEl.get(owned)?.destroy();
      const uid = (owned as HTMLElement).dataset?.voiceUid;
      if (uid !== undefined && voiceRowByUserId.get(Number(uid)) === owned) {
        voiceRowByUserId.delete(Number(uid));
      }
      for (const [channelId, entry] of voiceWrappers) {
        if (entry.el === owned) voiceWrappers.delete(channelId);
      }
    }
  }

  return {
    create: createVoiceRow,
    update: updateVoiceRow,
    refresh: refreshVoiceRows,
    captureFocus: captureVoiceFocus,
    restoreFocus: restoreVoiceFocus,
    disposeOwned,
    dispose: () => {
      closeProfilePopup?.();
      closeProfilePopup = null;
      voiceRowByUserId.clear();
      voiceWrappers.clear();
    },
  };
}
