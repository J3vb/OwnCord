import { describe, expect, it } from "vitest";

// Imported inside the first test body so the module's starting flags are what
// is read, before any other test has touched them.
describe("voiceDeafened", () => {
  it("starts silent for neither flag, and each flag alone stays quiet", async () => {
    const { isVoiceDeafened, setVoiceDeafened, setVoiceInSession } =
      await import("../../src/lib/voice/voiceDeafened");
    expect(isVoiceDeafened()).toBe(false);
    setVoiceInSession(true);
    expect(isVoiceDeafened()).toBe(false);
    setVoiceInSession(false);
    setVoiceDeafened(true);
    expect(isVoiceDeafened()).toBe(false);
  });

  it("silences sounds only while deafened inside a voice session", async () => {
    const { isVoiceDeafened, setVoiceDeafened, setVoiceInSession } =
      await import("../../src/lib/voice/voiceDeafened");
    setVoiceDeafened(true);
    setVoiceInSession(true);
    expect(isVoiceDeafened()).toBe(true);
    setVoiceInSession(false);
    expect(isVoiceDeafened()).toBe(false);
    setVoiceInSession(true);
    setVoiceDeafened(false);
    expect(isVoiceDeafened()).toBe(false);
  });
});
