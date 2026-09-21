// The registered push-to-talk capability: a facade that loads the service
// (`./pushToTalkService.ts`) on first use. The service gates the mic through
// the voice store, and the voice store's import graph reaches back into this
// registry — a static import here would close an import cycle through every
// module that consumes `desktop`. A dynamic edge is safe to evaluate in any
// order, and it keeps the service out of the startup chunk.
import type { PushToTalk } from "../contracts/pushToTalk";

async function service(): Promise<PushToTalk> {
  return (await import("./pushToTalkService")).pushToTalk;
}

export const pushToTalk: PushToTalk = {
  init: async () => (await service()).init(),
  stop: async () => (await service()).stop(),
  updateKey: async (vk) => (await service()).updateKey(vk),
  captureKeyPress: async () => (await service()).captureKeyPress(),
};
