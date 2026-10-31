/**
 * The DM call panel's identity check: the peers' verification state, the shield
 * on your own tile, and the announcements and focus moves around them.
 */
import { createElement, setText, setOwnedTimeout } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { voiceStore, type VoiceState, type PeerVerification } from "@stores/voice.store";
import type { DmChannel } from "@stores/dm.store";
import {
  ownIdentityTitle,
  verifyPresentation,
  openIdentityMismatchModal,
} from "../../voice/peerVerification";
import { dmCallText as d } from "../../../i18n/dmCall";
import {
  type AvatarRef,
  callName,
  currentUserId,
  type DmCallView,
  resolvePerson,
} from "../DmCallViewModel";
import { unansweredText } from "./dmCallRender";
import type { DmCallState, DmCallApi } from "./dmCallState";

/** Who the panel may draw, by name and avatar, so a rename or a new avatar
 *  redraws the stage but a presence flip does not. */
export function identitiesOf(v: Exclude<DmCallView, { kind: "none" }>): string {
  const me = currentUserId();
  const voice = voiceStore.getState();
  const ids = new Set([me, ...v.dm.participants.map((p) => p.id)]);
  if (v.kind === "incoming") ids.add(v.ring.fromUserId);
  if (v.kind === "live" || v.kind === "connected") for (const id of v.inRoom) ids.add(id);
  return [...ids]
    .map((id) => {
      const { name, subject } = resolvePerson(id, v.dm, voice, me);
      return `${id}:${name}:${subject.username}:${subject.displayName ?? ""}:${subject.avatar ?? ""}`;
    })
    .join(",");
}

export function createDmCallVerify(st: DmCallState, _dc: DmCallApi) {
  function announce(): void {
    let text = "";
    if (st.view.kind === "incoming") text = d("isCalling", { name: st.view.ring.fromUsername });
    else if (st.view.kind === "outgoing")
      text = d("callingName", { name: callName(st.view.dm, currentUserId()) });
    else if (st.view.kind === "unanswered") {
      text = unansweredText(st.view.reason, callName(st.view.dm, currentUserId()), false);
    }
    if (st.live.textContent !== text) setText(st.live, text);
  }

  /** Where focus goes when the focused shield is replaced: the new shield, else the avatar. */
  function focusFallback(userId: number): HTMLElement | null {
    const ref = st.avatars.get(userId);
    const el = ref?.verify ?? ref?.wrap ?? null;
    if (el !== null && el.tagName !== "BUTTON") el.tabIndex = -1;
    return el;
  }

  /** A peer's identity shield, as in the channel roster: redrawn only
   *  when their verification changes. A blocked peer's is a button that opens
   *  the re-trust prompt, since nothing else says why they cannot be heard. */
  function syncVerify(userId: number, ref: AvatarRef, voice: VoiceState, dm: DmChannel): void {
    const v = voice.peerVerifications?.get(userId) ?? null;
    const key =
      v === null ? "" : `${v.status}|${v.safetyNumber ?? ""}|${v.sessionFingerprint ?? ""}`;
    const hadFocus = ref.verify?.contains(document.activeElement) === true;
    if (key !== ref.verifyKey) {
      ref.verifyKey = key;
      if (st.focusedShield === ref.verify) st.focusedShield = null;
      ref.verify?.remove();
      ref.verify = null;
      if (v !== null) ref.verify = buildShield(userId, v, dm);
    }
    placeShield(userId, ref);
    if (hadFocus) focusFallback(userId)?.focus();
  }

  /** Your own shield: the safety number a peer compares with the one they
   *  see on your shield, while you are in this call. */
  function syncOwnShield(userId: number, ref: AvatarRef, voice: VoiceState | null): void {
    const title =
      voice === null
        ? null
        : ownIdentityTitle(voice.localSafetyNumber ?? null, voice.localSessionFingerprint ?? null);
    const key = title ?? "";
    if (key !== ref.verifyKey) {
      ref.verifyKey = key;
      ref.verify?.remove();
      ref.verify = null;
      if (title !== null) {
        const el = createElement("span", {
          class: "dcp-verify own",
          title,
          role: "img",
          "aria-label": title,
        });
        el.style.color = "var(--text-muted, #949ba4)";
        el.appendChild(createIcon("shield", 14));
        ref.verify = el;
      }
    }
    placeShield(userId, ref);
  }

  /** A camera tile replaces the avatar tile in the grid, so the shield moves with the person. */
  function placeShield(userId: number, ref: AvatarRef): void {
    if (ref.verify === null) return;
    const host =
      st.videoEl.querySelector<HTMLElement>(
        `.video-cell[data-user-id='${userId}'][data-stream-type='camera']`,
      ) ?? ref.wrap;
    if (ref.verify.parentElement !== host) host.appendChild(ref.verify);
  }

  function buildShield(userId: number, v: PeerVerification, dm: DmChannel): HTMLElement {
    const { icon, color, title } = verifyPresentation(v);
    const cls = `dcp-verify ${v.status}`;
    const el =
      v.status === "mismatch"
        ? createElement("button", { type: "button", class: cls, title, "aria-label": title })
        : createElement("span", { class: cls, title, role: "img", "aria-label": title });
    el.style.color = color;
    el.appendChild(createIcon(icon, 14));
    el.addEventListener("focus", () => (st.focusedShield = el), { signal: st.disposable.signal });
    el.addEventListener(
      "blur",
      () =>
        setOwnedTimeout(
          st.disposable.signal,
          () => {
            if (st.focusedShield === el && el.isConnected && document.activeElement !== el) {
              st.focusedShield = null;
            }
          },
          0,
        ),
      { signal: st.disposable.signal },
    );
    if (v.status === "mismatch") {
      el.addEventListener(
        "click",
        (e) => {
          // A tile in the video grid has its own click.
          e.stopPropagation();
          const name = resolvePerson(userId, dm, voiceStore.getState(), currentUserId()).name;
          void openIdentityMismatchModal(userId, name, st.disposable.signal, () =>
            focusFallback(userId),
          );
        },
        { signal: st.disposable.signal },
      );
    }
    return el;
  }

  return {
    announce,
    focusFallback,
    syncVerify,
    syncOwnShield,
    placeShield,
    buildShield,
  };
}
