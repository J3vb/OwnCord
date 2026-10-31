import { afterEach, beforeEach, vi } from "vitest";
import { createWsClient } from "../../src/lib/ws";
import { eventHandlers, mockInvoke, mockListen } from "../unit/helpers/ws-mocks";

/**
 * Registers the beforeEach/afterEach every ws client suite repeats: fake
 * timers, a reset Tauri invoke/listen pair with no registered event
 * handlers, and a fresh client per test that is disconnected afterwards.
 * `bind` receives each new client so the suite can keep it in a local.
 */
export function useWsClientFixture(
  bind: (client: ReturnType<typeof createWsClient>) => void,
): void {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
    bind(client);
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });
}
