import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/platform/desktop", () => ({
  desktop: { urlOpener: { open: vi.fn() }, pushRegistration: { supported: true } },
}));

import { buildPushRow } from "../../../src/features/push/pushSettingRow";
import { INITIAL_PUSH_STATE, pushStore, setPushSetting } from "../../../src/features/push/store";

describe("push setting row", () => {
  const controller = new AbortController();

  afterEach(() => {
    pushStore.setState(() => INITIAL_PUSH_STATE);
  });

  it("names the private push server and says what to do", () => {
    setPushSetting("refused", [], "192.168.1.20:8443");
    const row = buildPushRow(controller.signal);
    expect(row.querySelector("[data-testid=push-desc]")?.textContent).toBe(
      "Your push server (192.168.1.20:8443) is on a private network. OwnCord only sends to public push servers. Pick a public server in your push app (for example ntfy.sh).",
    );
    expect(row.querySelector("[data-testid=push-status]")?.textContent).toBe(
      "Push server not public",
    );
  });

  it("names the port of a push server that is not on 443", () => {
    setPushSetting("port-refused", [], "ntfy.example", "8443");
    const row = buildPushRow(controller.signal);
    expect(row.querySelector("[data-testid=push-desc]")?.textContent).toBe(
      "Your push server (ntfy.example) uses port 8443. OwnCord only sends to push servers on the standard HTTPS port (443).",
    );
  });

  afterAll(() => {
    controller.abort();
  });
});
