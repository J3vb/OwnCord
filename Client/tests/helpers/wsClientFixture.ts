import { afterEach, beforeEach, vi } from "vitest";
import { createWsClient } from "../../src/lib/ws";
import { eventHandlers, mockInvoke, mockListen } from "../unit/helpers/ws-mocks";

export interface WsClientFixtureOptions {
  /** Dependencies handed to each new client, e.g. a pinned jitter source. */
  clientOptions?: Parameters<typeof createWsClient>[0];
  /** Puts mockListen's implementation back after each test that overrides it. */
  restoreListenImpl?: boolean;
}

/**
 * Registers the beforeEach/afterEach every ws client suite repeats: fake
 * timers, a reset Tauri invoke/listen pair with no registered event
 * handlers, and a fresh client per test that is disconnected afterwards.
 * `bind` receives each new client so the suite can keep it in a local.
 */
export function useWsClientFixture(
  bind: (client: ReturnType<typeof createWsClient>) => void,
  options: WsClientFixtureOptions = {},
): void {
  let client: ReturnType<typeof createWsClient>;
  let listenImpl: ReturnType<typeof mockListen.getMockImplementation>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    listenImpl = mockListen.getMockImplementation();
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient(options.clientOptions);
    bind(client);
  });

  afterEach(() => {
    if (options.restoreListenImpl && listenImpl) mockListen.mockImplementation(listenImpl);
    client.disconnect();
    vi.useRealTimers();
  });
}
