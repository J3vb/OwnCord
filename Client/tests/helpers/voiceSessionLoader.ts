// main.ts registers the voice session loader at boot and tests/setup.ts does
// the same for every test file. A test that calls vi.resetModules() gets a
// fresh, empty loader module with the next import, so it registers again.
export async function registerTestVoiceSessionLoader(): Promise<void> {
  const { registerVoiceSessionLoader } = await import("../../src/lib/voice/voiceSessionLoader");
  registerVoiceSessionLoader(() => import("../../src/features/voice/livekitSession"));
}
