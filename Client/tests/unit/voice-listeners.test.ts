/**
 * Who listens to a music share: the per-member `music_id` the store keeps
 * from voice_watching.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addVoiceUser } from "../helpers/voiceUsers";
import {
  clearPeerWatching,
  joinVoiceChannel,
  removeVoiceUser,
  resetVoiceStore,
  setPeerWatching,
  voiceStore,
  leaveVoiceChannel,
} from "../../src/stores/voice.store";
import { listenersOfMusic } from "../../src/stores/voicePeers";
import { handleVoiceWatching } from "../../src/features/voice/wsHandlers";

const ME = 1;
const SAM = 2;
const ALEX = 3;
const KIM = 4;

function inChannel(): void {
  for (const id of [ME, SAM, ALEX, KIM]) addVoiceUser(10, id, `u${id}`);
  joinVoiceChannel(10);
  voiceStore.setState((prev) => ({ ...prev, musicSharers: new Set([SAM]) }));
  voiceStore.flush();
}

beforeEach(() => {
  resetVoiceStore();
  voiceStore.flush();
});
afterEach(() => {
  resetVoiceStore();
  voiceStore.flush();
});

describe("peerListening in the store", () => {
  it("keeps a member's music_id even with an empty watch set, and clears it on 0", () => {
    inChannel();
    setPeerWatching(ALEX, [], SAM);
    expect(voiceStore.getState().peerListening?.get(ALEX)).toBe(SAM);
    expect(voiceStore.getState().peerWatching?.has(ALEX)).toBe(false);
    expect(listenersOfMusic(voiceStore.getState(), SAM, ME)).toEqual([ALEX]);

    setPeerWatching(ALEX, [], 0);
    expect(voiceStore.getState().peerListening?.has(ALEX)).toBe(false);
  });

  it("lists listeners of that sharer only, sorted, never the sharer or you", () => {
    inChannel();
    setPeerWatching(KIM, [], SAM);
    setPeerWatching(ALEX, [], SAM);
    setPeerWatching(SAM, [], SAM);
    setPeerWatching(ME, [], SAM);
    expect(listenersOfMusic(voiceStore.getState(), SAM, ME)).toEqual([ALEX, KIM]);
    expect(listenersOfMusic(voiceStore.getState(), ALEX, ME)).toEqual([]);
  });

  it("drops a member's listen on leave, on a channel leave, on a clear and a store reset", () => {
    inChannel();
    setPeerWatching(ALEX, [], SAM);
    setPeerWatching(KIM, [], SAM);
    removeVoiceUser({ channel_id: 10, user_id: ALEX });
    expect(voiceStore.getState().peerListening?.has(ALEX)).toBe(false);
    expect(voiceStore.getState().peerListening?.has(KIM)).toBe(true);

    clearPeerWatching();
    expect(voiceStore.getState().peerListening?.size).toBe(0);

    setPeerWatching(KIM, [], SAM);
    leaveVoiceChannel();
    expect(voiceStore.getState().peerListening?.size).toBe(0);
  });

  it("ignores a frame for a member who is not in the channel", () => {
    inChannel();
    setPeerWatching(99, [], SAM);
    expect(voiceStore.getState().peerListening?.has(99)).toBe(false);
  });
});

describe("voice_watching handler", () => {
  it("stores a resumed or joined member's music_id, and treats a bad one as nobody", () => {
    inChannel();
    handleVoiceWatching({ user_id: ALEX, user_ids: [], music_id: SAM });
    expect(voiceStore.getState().peerListening?.get(ALEX)).toBe(SAM);

    for (const bad of [-1, 1.5, "2", null, undefined]) {
      handleVoiceWatching({ user_id: ALEX, user_ids: [], music_id: bad as never });
      expect(voiceStore.getState().peerListening?.has(ALEX)).toBe(false);
      handleVoiceWatching({ user_id: ALEX, user_ids: [], music_id: SAM });
    }
  });

  it("an older server's frame, with no music_id, clears the listen", () => {
    inChannel();
    handleVoiceWatching({ user_id: ALEX, user_ids: [], music_id: SAM });
    handleVoiceWatching({ user_id: ALEX, user_ids: [SAM] });
    expect(voiceStore.getState().peerListening?.has(ALEX)).toBe(false);
  });
});
