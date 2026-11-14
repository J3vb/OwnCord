// The registered music-share capability: a facade that loads the host
// bindings (`./musicAudioService.ts`) on first use, so they cost the startup
// chunk nothing.
import type { MusicAudio } from "../contracts/musicAudio";

async function service(): Promise<MusicAudio> {
  return (await import("./musicAudioService")).musicAudio;
}

export const musicAudio: MusicAudio = {
  support: async () => (await service()).support(),
  listApps: async () => (await service()).listApps(),
  start: async (appId) => (await service()).start(appId),
  stop: async () => (await service()).stop(),
};
