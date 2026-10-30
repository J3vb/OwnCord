/**
 * The portal on a page the browser does not count as a secure context (WP
 * 6.13e1): the router renders one notice and nothing else. The browser
 * platform's adapters stay inert there, so no page may be built over them and
 * nothing may reach the API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { ApiClient } from "@lib/api";
import type { ProfileManager } from "@lib/presence/profiles";
import type { WsClient } from "@lib/ws";
import { configureRouter, renderActive } from "../../src/app/router";
import { portalText } from "../../src/i18n/portal";

const apiCalls: string[] = [];
const api = new Proxy(
  {},
  {
    get(_target, name) {
      apiCalls.push(String(name));
      return () => {
        throw new Error(`api.${String(name)} must not be reached`);
      };
    },
  },
) as ApiClient;

let appEl: HTMLElement;

beforeEach(() => {
  apiCalls.length = 0;
  document.body.innerHTML = '<div id="app"></div>';
  appEl = document.getElementById("app")!;
  const profiles = {
    getAll: () => [],
    getAutoConnectProfile: () => undefined,
    loadProfiles: async () => undefined,
  } as unknown as ProfileManager;
  configureRouter(api, {} as WsClient, appEl, profiles, vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("portal on a non-secure page", () => {
  it("non-secure context renders only the notice", async () => {
    vi.stubGlobal("isSecureContext", false);
    await renderActive();

    expect(appEl.textContent).toContain(portalText("insecure.title"));
    expect(appEl.textContent).toContain(portalText("insecure.body"));
    // No form, no server list: nothing a user could type a password into.
    expect(appEl.querySelector(".connect-page, form, input, button")).toBeNull();
    // And nothing touched the API client.
    expect(apiCalls).toEqual([]);
  });
});
