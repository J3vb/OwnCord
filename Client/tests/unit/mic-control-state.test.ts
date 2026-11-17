/**
 * micControlState over every combination of the seven inputs it reads, checked
 * against explicit expectations for each precedence rule.
 */
import { afterEach, describe, expect, it } from "vitest";
import { voiceStore, type VoiceState } from "@stores/voice.store";
import {
  callStatusText,
  isPhoneCallHold,
  micControlKey,
  micControlState,
} from "../../src/features/voice/voiceStatusText";
import { voiceText } from "../../src/i18n/voice";
import { clearHost, hostAndroidApp } from "../helpers/androidHost";

interface Inputs {
  inCall: boolean;
  muted: boolean;
  serverMuted: boolean;
  listenOnly: boolean;
  pttGated: boolean;
  afk: boolean;
  phoneHold: boolean;
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
    phoneCallHold: i.phoneHold,
  };
}

const TITLE = {
  hold: voiceText("widget.control.phoneCallHold"),
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
  for (let n = 0; n < 128; n++) {
    out.push({
      inCall: (n & 1) !== 0,
      muted: (n & 2) !== 0,
      serverMuted: (n & 4) !== 0,
      listenOnly: (n & 8) !== 0,
      pttGated: (n & 16) !== 0,
      afk: (n & 32) !== 0,
      phoneHold: (n & 64) !== 0,
    });
  }
  return out;
}

describe("micControlState", () => {
  afterEach(() => clearHost());

  it.each(allInputs())("reads %j by the documented precedence", (i) => {
    // A phone call can hold only a call there is.
    const phoneHold = i.inCall && i.phoneHold;
    const afkLocked = i.inCall && i.afk;
    const listenOnly = i.inCall && i.listenOnly && !i.serverMuted && !afkLocked;
    const pttGated = i.inCall && i.pttGated && !i.muted && !listenOnly && !afkLocked && !phoneHold;
    const expectedTitle = phoneHold
      ? TITLE.hold
      : i.serverMuted
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
      phoneHold,
      micOff: i.muted || listenOnly || afkLocked || phoneHold,
      pressed: i.muted || afkLocked || phoneHold,
      disabled: i.serverMuted || listenOnly || afkLocked || phoneHold,
      title: expectedTitle,
    });
  });

  it("keys every input, so a phone call's hold redraws the mic controls", () => {
    const base = {
      inCall: true,
      muted: false,
      serverMuted: false,
      listenOnly: false,
      pttGated: false,
      afk: false,
    };
    const keys = allInputs().map((i) => micControlKey(stateFor(i)));
    expect(new Set(keys).size).toBe(keys.length);
    expect(micControlKey(stateFor({ ...base, phoneHold: true }))).not.toBe(
      micControlKey(stateFor({ ...base, phoneHold: false })),
    );
  });

  it("names the talk button on Android when push-to-talk is gating", () => {
    hostAndroidApp();
    const base = {
      inCall: true,
      muted: false,
      serverMuted: false,
      listenOnly: false,
      afk: false,
      phoneHold: false,
    };
    expect(micControlState(stateFor({ ...base, pttGated: true })).title).toBe(TITLE.pttAndroid);
  });
});

describe("a phone call's hold", () => {
  const call = stateFor({
    inCall: true,
    muted: false,
    serverMuted: false,
    listenOnly: false,
    pttGated: false,
    afk: false,
    phoneHold: true,
  });

  it("holds only a call there is", () => {
    expect(isPhoneCallHold(call)).toBe(true);
    expect(isPhoneCallHold({ ...call, phoneCallHold: false })).toBe(false);
    expect(isPhoneCallHold({ ...call, currentChannelId: null })).toBe(false);
  });

  it("is what the call's status line says, before the state of its session", () => {
    const reconnecting = { ...call, voiceStatus: "reconnecting" as const };
    expect(callStatusText(reconnecting)).toBe(voiceText("call.paused"));
    expect(callStatusText({ ...reconnecting, phoneCallHold: false })).toBe(
      voiceText("status.reconnecting"),
    );
    expect(callStatusText({ ...call, phoneCallHold: false, voiceStatus: "connected" })).toBe(
      voiceText("status.connected"),
    );
  });
});
