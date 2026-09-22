// Behaviour suite for the `NativeVoice` contract
// (`src/platform/contracts/nativeVoice.ts`): the Linux native LiveKit
// backend's command surface and its one event subscription. There is no
// legacy binding — the capability is new with the Linux voice work.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  NativeVoice,
  NativeVoiceDevices,
  NativeVoiceEnvelope,
} from "../../../src/platform/contracts/nativeVoice";

export interface NativeControl {
  /** The host answers the next connect with this session and identity. */
  connectsAs(session: number, identity: string): void;
  /** The host reports these devices on the next enumeration. */
  hasDevices(devices: NativeVoiceDevices): void;
  /** Every host command issued so far, as `[name, payload]`. */
  commands(): Array<[string, unknown]>;
  /** The host delivers a room event. Resolves once it has been delivered. */
  emits(envelope: NativeVoiceEnvelope): Promise<void>;
}

export interface NativeVoiceSubject {
  readonly subject: NativeVoice;
  readonly native: NativeControl;
}

const audio = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };

export function describeNativeVoiceSuite(
  makeSubject: () => Promise<NativeVoiceSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("NativeVoice", () => {
    let ctx: NativeVoiceSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("hands the room key to the host as the exact text it was given", async () => {
      await ctx.subject.setRoomKey("bW9jay1yb29tLWtleQ==");
      expect(ctx.native.commands()).toEqual([
        ["native_voice_set_key", { key: "bW9jay1yb29tLWtleQ==" }],
      ]);
    });

    check("connect resolves the host's session id and identity", async () => {
      ctx.native.connectsAs(7, "user-42");
      await expect(ctx.subject.connect("ws://127.0.0.1:7881/lk", "tok", audio)).resolves.toEqual({
        session: 7,
        identity: "user-42",
      });
      expect(ctx.native.commands()).toEqual([
        ["native_voice_connect", { url: "ws://127.0.0.1:7881/lk", token: "tok", audio }],
      ]);
    });

    check("scopes microphone, subscription and disconnect to a session id", async () => {
      await ctx.subject.setMicrophone(7, true);
      await ctx.subject.setSubscribed(7, "user-9", "TR_1", false);
      await ctx.subject.disconnect(7);
      await ctx.subject.clearRoomKey();
      expect(ctx.native.commands()).toEqual([
        ["native_voice_set_microphone", { session: 7, enabled: true }],
        [
          "native_voice_set_subscribed",
          { session: 7, identity: "user-9", sid: "TR_1", subscribed: false },
        ],
        ["native_voice_disconnect", { session: 7 }],
        ["native_voice_clear_key", undefined],
      ]);
    });

    check("lists the host's devices and switches by their ids", async () => {
      const devices = {
        inputs: [{ id: "guid-mic", name: "USB Mic" }],
        outputs: [{ id: "guid-spk", name: "Speakers" }],
      };
      ctx.native.hasDevices(devices);
      await expect(ctx.subject.listDevices()).resolves.toEqual(devices);
      await ctx.subject.setDevice(7, "audioinput", "guid-mic");
      await ctx.subject.setDevice(7, "audiooutput", "");
      expect(ctx.native.commands()).toEqual([
        ["native_voice_list_devices", undefined],
        ["native_voice_set_device", { session: 7, kind: "audioinput", deviceId: "guid-mic" }],
        ["native_voice_set_device", { session: 7, kind: "audiooutput", deviceId: "" }],
      ]);
    });

    check("delivers each room event to the handler as the host sent it", async () => {
      const handler = vi.fn();
      ctx.subject.onEvent(handler);
      await ctx.native.emits({ session: 1, event: { type: "reconnecting" } });
      await ctx.native.emits({
        session: 1,
        event: { type: "activeSpeakers", identities: ["user-1"] },
      });
      expect(handler.mock.calls).toEqual([
        [{ session: 1, event: { type: "reconnecting" } }],
        [{ session: 1, event: { type: "activeSpeakers", identities: ["user-1"] } }],
      ]);
    });

    // Paired with a delivery first: "nothing arrives after unsubscribing" is
    // also what a subject that never delivers anything does.
    check("stops delivering once unsubscribed", async () => {
      const handler = vi.fn();
      const unsubscribe = ctx.subject.onEvent(handler);
      await ctx.native.emits({ session: 1, event: { type: "reconnected" } });
      unsubscribe();
      await ctx.native.emits({ session: 1, event: { type: "disconnected", reason: "x" } });
      expect(handler.mock.calls).toEqual([[{ session: 1, event: { type: "reconnected" } }]]);
    });

    check("an unsubscribe issued before the subscription settled still releases it", async () => {
      const handler = vi.fn();
      const unsubscribe = ctx.subject.onEvent(handler);
      unsubscribe();
      await ctx.native.emits({ session: 1, event: { type: "reconnected" } });
      expect(handler).not.toHaveBeenCalled();
      // The late-resolving host handle was released, not leaked: a fresh
      // subscription is the only one that receives.
      const fresh = vi.fn();
      ctx.subject.onEvent(fresh);
      await ctx.native.emits({ session: 2, event: { type: "reconnected" } });
      expect(fresh).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
    });
  });
}
