/**
 * A click on a voice channel's own row: open the call when joined, else join
 * (on a phone, after a confirming sheet). Everything is read now, at click
 * time: the wrapper is reused across joins and leaves.
 */

import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { uiStore } from "@stores/ui.store";
import { voiceStore } from "@stores/voice.store";
import { safetyStore } from "../safety/store";

/** What the click acts through, supplied by the sidebar. */
export interface VoiceChannelClickDeps {
  readonly onVoiceJoin: (channelId: number) => void;
  readonly onOpenCall: () => void;
  readonly openJoinSheet: (channelId: number, anchor: HTMLElement, join: () => void) => void;
}

export function voiceChannelClick(
  channelId: number,
  wrapper: HTMLElement,
  deps: VoiceChannelClickDeps,
): void {
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
    deps.onOpenCall();
  } else if (isPhoneLayout()) {
    deps.openJoinSheet(
      channelId,
      wrapper.querySelector<HTMLElement>(":scope > .channel-item") ?? wrapper,
      () => deps.onVoiceJoin(channelId),
    );
  } else {
    deps.onVoiceJoin(channelId);
  }
}
