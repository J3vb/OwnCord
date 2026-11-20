// handleVoiceSpeaking: a member's own speaking ring, relayed by the server.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Payload } from "../connection/dispatchContext";
import { handleVoiceSpeaking, wsRoutes } from "./wsHandlers";

vi.mock("../../lib/voice/livekitSession", () => ({ handleRingAnnounced: vi.fn() }));
import { handleRingAnnounced } from "../../lib/voice/livekitSession";

describe("handleVoiceSpeaking", () => {
  beforeEach(() => {
    vi.mocked(handleRingAnnounced).mockClear();
  });

  it("is routed from voice_speaking", () => {
    expect(wsRoutes.map((route) => route.type)).toContain("voice_speaking");
  });

  it.each([true, false, null])("hands a member's ring (%s) to the session", async (speaking) => {
    handleVoiceSpeaking({ user_id: 5, speaking });

    await vi.waitFor(() => expect(handleRingAnnounced).toHaveBeenCalledWith(5, speaking));
  });

  it.each(["yes", 1, undefined])("reads %s as no verdict", async (speaking) => {
    handleVoiceSpeaking({ user_id: 5, speaking } as unknown as Payload<"voice_speaking">);

    await vi.waitFor(() => expect(handleRingAnnounced).toHaveBeenCalledWith(5, null));
  });
});
