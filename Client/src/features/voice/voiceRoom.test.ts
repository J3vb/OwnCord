import { describe, expectTypeOf, it } from "vitest";
import type { Room } from "livekit-client";
import type { NativeRoom } from "./native/nativeRoom";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

// A failure here is a compile error: tsc covers test files (tsconfig.json).
describe("VoiceRoom", () => {
  it("is satisfied by livekit's Room with no cast", () => {
    expectTypeOf<Room>().toExtend<VoiceRoom>();
  });

  it("is satisfied by the Linux NativeRoom with no cast", () => {
    expectTypeOf<NativeRoom>().toExtend<VoiceRoom>();
  });
});
