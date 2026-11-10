/**
 * micControlState over every combination of the six inputs it reads, checked
 * against explicit expectations for each precedence rule.
 */
import { afterEach, describe, expect, it } from "vitest";
import { voiceStore, type VoiceState } from "@stores/voice.store";
import { micControlState } from "../../src/features/voice/voiceStatusText";
import { voiceText } from "../../src/i18n/voice";
import { clearHost, hostAndroidApp } from "../helpers/androidHost";

interface Inputs {
  inCall: boolean;
  muted: boolean;
  serverMuted: boolean;
  listenOnly: boolean;
  pttGated: boolean;
  afk: boolean;
}

function stateFor(i: Inputs): VoiceState {
  return {
    ...voiceStore.getState(),
    currentChannelId: i.inCall ? 7 : null,
    localMuted: i.muted,
    localServerMuted: i.serverMuted,
    listenOnly: i.listenOnly,
    pttGated: i.pttGated,
    inAfkChannel: i.afk,
  };
}

const TITLE = {
  server: voiceText("widget.mutedByModerator"),
  afk: voiceText("widget.control.afkLocked"),
  listen: voiceText("widget.control.listenOnly"),
  ptt: voiceText("widget.control.pttGated"),
  pttAndroid: voiceText("widget.control.pttGated.android"),
  unmute: voiceText("widget.control.unmute"),
  mute: voiceText("widget.control.mute"),
};

function allInputs(): Inputs[] {
  const out: Inputs[] = [];
  for (let n = 0; n < 64; n++) {
    out.push({
      inCall: (n & 1) !== 0,
      muted: (n & 2) !== 0,
      serverMuted: (n & 4) !== 0,
      listenOnly: (n & 8) !== 0,
      pttGated: (n & 16) !== 0,
      afk: (n & 32) !== 0,
    });
  }
  return out;
}

describe("micControlState", () => {
  afterEach(() => clearHost());

  it.each(allInputs())("reads %j by the documented precedence", (i) => {
    const afkLocked = i.inCall && i.afk;
    const listenOnly = i.inCall && i.listenOnly && !i.serverMuted && !afkLocked;
    const pttGated = i.inCall && i.pttGated && !i.muted && !listenOnly && !afkLocked;
    const expectedTitle = i.serverMuted
      ? TITLE.server
      : afkLocked
        ? TITLE.afk
        : listenOnly
          ? TITLE.listen
          : pttGated
            ? TITLE.ptt
            : i.muted
              ? TITLE.unmute
              : TITLE.mute;
    expect(micControlState(stateFor(i))).toEqual({
      userMuted: i.muted,
      listenOnly,
      pttGated,
      micOff: i.muted || listenOnly || afkLocked,
      pressed: i.muted || afkLocked,
      disabled: i.serverMuted || listenOnly || afkLocked,
      title: expectedTitle,
    });
  });

  it("names the talk button on Android when push-to-talk is gating", () => {
    hostAndroidApp();
    const base = { inCall: true, muted: false, serverMuted: false, listenOnly: false, afk: false };
    expect(micControlState(stateFor({ ...base, pttGated: true })).title).toBe(TITLE.pttAndroid);
  });
});
