/**
 * Drag a participant row onto another voice channel to move them there
 * (voice_mod_move). Mouse-based like drag-reorder.ts (WebView2 HTML5 DnD is
 * unreliable), but a separate gesture: it never touches channel reordering.
 *
 * Gated on the source channel's server-computed can_move_voice, the same
 * verdict the volume menu's "Move to" uses (only MOVE_MEMBERS opens a move);
 * the server re-checks the target's access and capacity. Each gesture owns its document listeners and
 * drops them when it ends, so a sidebar re-render mid-drag (speaking rings
 * re-render often) cannot strand one.
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "../../lib/disposable";
import { setOwnedTimeout } from "../../lib/dom";
import { channelsStore } from "../../stores/channels.store";
import { uiStore } from "../../stores/ui.store";
import { voiceStore } from "../../stores/voice.store";

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 5;

/** Marks the element that accepts a dropped participant for one voice channel. */
export const VOICE_DROP_ATTR = "voiceDropChannelId";
const VOICE_DROP_SELECTOR = "[data-voice-drop-channel-id]";

/** Whether the signed-in user may move people out of this voice channel now. */
export function canDragVoiceUser(channelId: number): boolean {
  if (uiStore.getState().connectionStatus !== "connected") return false;
  const ch = channelsStore.getState().channels.get(channelId);
  return ch?.canMoveVoice === true;
}

function contains(r: DOMRect, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** The voice channel whose drop area contains the point, or null. A channel
 *  scrolled out of the list's view still has a rect, over whatever sits above
 *  or below the list, so the point must also be inside the visible list. */
function dropChannelAt(x: number, y: number, fromChannelId: number): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(VOICE_DROP_SELECTOR)) {
    if (Number(el.dataset[VOICE_DROP_ATTR]) === fromChannelId) continue;
    if (!contains(el.getBoundingClientRect(), x, y)) continue;
    const list = el.closest(".channel-list");
    if (list !== null && !contains(list.getBoundingClientRect(), x, y)) continue;
    return el;
  }
  return null;
}

function clearDropHighlight(): void {
  document.querySelectorAll(".voice-drop-target").forEach((el) => {
    el.classList.remove("voice-drop-target");
  });
}

/** Swallow the click that follows a drag's mouseup, so a drop does not also
 *  open the dragged user's profile or stream. */
function suppressNextClick(): void {
  const owner = new Disposable();
  document.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      e.preventDefault();
      owner.destroy();
    },
    { capture: true, signal: owner.signal },
  );
  // The click, when one comes, is dispatched before any timer runs.
  setOwnedTimeout(owner.signal, () => owner.destroy(), 0);
}

/** Mark a voice channel's wrapper (its row and participant list) as a drop area. */
export function markVoiceDropTarget(el: HTMLElement, channelId: number): void {
  el.dataset[VOICE_DROP_ATTR] = String(channelId);
}

/**
 * Make one participant row draggable. `signal` is the row's own signal
 * (scopes the mousedown); `lifetimeSignal` is the sidebar's, and ends an
 * in-flight drag when the sidebar is destroyed.
 *
 * The caller draws the `voice-user-draggable` class (the row model's
 * `draggable`, which carries the inputs of `canDragVoiceUser`) and attaches
 * only to a row drawn that way, so the row's DOM is its model's draw. Each
 * press re-checks `canDragVoiceUser`, so a row drawn from a snapshot that is
 * a moment old never starts a drag the live state refuses.
 */
export function attachVoiceUserDrag(
  row: HTMLElement,
  channelId: number,
  userId: number,
  onMove: (userId: number, toChannelId: number) => void,
  signal: AbortSignal,
  lifetimeSignal: AbortSignal,
): void {
  row.addEventListener(
    "mousedown",
    (e) => {
      // Not stopped: document-level "close on outside press" listeners must
      // still see it. drag-reorder ignores presses on participant rows.
      if (e.button !== 0 || lifetimeSignal.aborted) return;
      if (!canDragVoiceUser(channelId)) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const gesture = new Disposable();
      let ghost: HTMLElement | null = null;

      // Escape clears the visuals but keeps the gesture until the button is
      // released, so that release cannot become a click.
      let cancelled = false;

      const clearVisuals = (): void => {
        ghost?.remove();
        ghost = null;
        clearDropHighlight();
        document.body.classList.remove("voice-user-moving");
        document
          .querySelectorAll(`[data-voice-uid="${userId}"].dragging`)
          .forEach((el) => el.classList.remove("dragging"));
      };
      const end = (): void => {
        gesture.destroy();
        clearVisuals();
      };
      lifetimeSignal.addEventListener("abort", end, { signal: gesture.signal });

      document.addEventListener(
        "mousemove",
        (ev) => {
          if (ev.buttons === 0) {
            end();
            return;
          }
          if (cancelled) return;
          if (ghost === null) {
            if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) {
              return;
            }
            ghost = row.cloneNode(true) as HTMLElement;
            ghost.classList.add("voice-user-drag-ghost");
            ghost.removeAttribute("tabindex");
            ghost.removeAttribute("data-voice-uid");
            ghost.setAttribute("aria-hidden", "true");
            document.body.appendChild(ghost);
            document.body.classList.add("voice-user-moving");
          }
          ghost.style.left = `${ev.clientX + 8}px`;
          ghost.style.top = `${ev.clientY + 8}px`;
          // Re-find the live row: a re-render may have replaced the one pressed.
          document
            .querySelectorAll(`${VOICE_DROP_SELECTOR} [data-voice-uid="${userId}"]`)
            .forEach((el) => el.classList.add("dragging"));
          clearDropHighlight();
          dropChannelAt(ev.clientX, ev.clientY, channelId)?.classList.add("voice-drop-target");
        },
        { signal: gesture.signal },
      );

      document.addEventListener(
        "mouseup",
        (ev) => {
          const dragged = ghost !== null;
          const wasCancelled = cancelled;
          end();
          if (dragged || wasCancelled) suppressNextClick();
          if (!dragged || wasCancelled) return;
          const target = dropChannelAt(ev.clientX, ev.clientY, channelId);
          if (target === null) return;
          const toChannelId = Number(target.dataset[VOICE_DROP_ATTR]);
          if (!Number.isFinite(toChannelId) || !canDragVoiceUser(channelId)) return;
          // They left or were moved while the pointer was down.
          if (voiceStore.getState().voiceUsers.get(channelId)?.has(userId) !== true) return;
          onMove(userId, toChannelId);
        },
        { signal: gesture.signal },
      );

      document.addEventListener(
        "keydown",
        (ev) => {
          if (ev.key !== "Escape" || isImeCommit(ev) || cancelled) return;
          ev.preventDefault();
          if (ghost === null) {
            end();
            return;
          }
          clearVisuals();
          cancelled = true;
        },
        { signal: gesture.signal },
      );
      window.addEventListener("blur", end, { signal: gesture.signal });
    },
    { signal },
  );
}
