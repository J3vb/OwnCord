// The Command Deck top bar names the connection with one word. These tests pin
// that word's rules, and check it against the connection banner it must agree
// with: the real wireConnectionBanner and a real banner, over every state the
// store can hold.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionLabel,
  wireConnectionBanner,
  type ConnectionLabel,
} from "../../../src/features/connection/connectionBanner";
import { createServerBanner } from "../../../src/features/server-rail/ServerBanner";
import { shellText } from "../../../src/i18n/shell";
import { authStore } from "../../../src/stores/auth.store";
import { setConnectionStatus, setSessionReplaced, uiStore } from "../../../src/stores/ui.store";
import { fakeWs } from "../../helpers/mainPageHarness";
import { resetUiState } from "../../helpers/dmHarness";
import { resetAuthState } from "../../helpers/storeSeeds";

type Input = Parameters<typeof connectionLabel>[0];
const base: Input = {
  sessionReplaced: false,
  status: "disconnected",
  dialFailed: false,
  offline: false,
};
const label = (o: Partial<Input>): ConnectionLabel => connectionLabel({ ...base, ...o });

describe("connectionLabel", () => {
  it("row 1: signed in elsewhere", () => {
    expect(label({ sessionReplaced: true })).toBe("elsewhere");
  });

  it("row 2: connected", () => {
    expect(label({ status: "connected" })).toBe("connected");
  });

  it("row 3: offline", () => {
    expect(label({ offline: true })).toBe("offline");
    expect(label({ status: "reconnecting", offline: true })).toBe("offline");
  });

  it("row 4: reconnecting", () => {
    expect(label({ status: "reconnecting" })).toBe("reconnecting");
  });

  it("row 5: unreachable", () => {
    expect(label({ status: "disconnected" })).toBe("unreachable");
  });

  it("elsewhere outranks connected", () => {
    expect(label({ sessionReplaced: true, status: "connected" })).toBe("elsewhere");
  });

  it("connected outranks offline", () => {
    expect(label({ status: "connected", offline: true })).toBe("connected");
  });

  it("reconnecting after a failed dial is unreachable", () => {
    expect(label({ status: "reconnecting", dialFailed: true })).toBe("unreachable");
  });

  it("undefined offline is not offline", () => {
    expect(label({ offline: undefined })).toBe("unreachable");
    expect(label({ status: "reconnecting", offline: undefined })).toBe("reconnecting");
  });
});

describe("connectionLabel parity with the connection banner", () => {
  const STATUSES = ["connected", "reconnecting", "disconnected"] as const;
  const OFFLINE = [true, false, undefined] as const;
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    resetUiState();
    resetAuthState();
    authStore.setState((s) => ({ ...s, token: "tok" }));
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    vi.restoreAllMocks();
  });

  it("the banner says what the label says, for every state the store can hold", () => {
    const banner = createServerBanner();
    teardown = wireConnectionBanner({
      getBanner: () => banner,
      ws: fakeWs(),
      getHost: () => "host:1",
      onConnected: () => {},
    });
    const onLine = vi.spyOn(navigator, "onLine", "get");
    let checked = 0;
    for (const status of STATUSES) {
      for (const dialFailed of [false, true]) {
        for (const offline of OFFLINE) {
          for (const sessionReplaced of [false, true]) {
            // A live connection clears sessionReplaced, so the store cannot hold both.
            if (sessionReplaced && status === "connected") continue;
            setConnectionStatus(status, dialFailed);
            setSessionReplaced(sessionReplaced);
            // An absent API reads undefined; otherwise onLine is the opposite of offline.
            onLine.mockReturnValue((offline === undefined ? undefined : !offline) as boolean);
            window.dispatchEvent(new Event(offline === true ? "offline" : "online"));
            uiStore.flush();

            const state = `${status}/dialFailed=${dialFailed}/offline=${offline}/replaced=${sessionReplaced}`;
            const result = connectionLabel({
              sessionReplaced,
              status,
              dialFailed,
              offline,
            });
            const visible = banner.element.classList.contains("visible");
            const text = banner.element.textContent ?? "";
            switch (result) {
              case "elsewhere":
                expect(visible, state).toBe(true);
                expect(text.startsWith(shellText("banner.signedInElsewhere")), state).toBe(true);
                break;
              case "connected":
                expect(visible, state).toBe(false);
                break;
              case "offline":
                expect(text.startsWith(shellText("banner.deviceOffline")), state).toBe(true);
                break;
              case "reconnecting":
                expect(text, state).toBe(shellText("banner.reconnecting"));
                break;
              case "unreachable":
                expect(text.startsWith(shellText("banner.serverUnreachable")), state).toBe(true);
                break;
            }
            if (result !== "connected") expect(visible, state).toBe(true);
            checked++;
          }
        }
      }
    }
    // 3 statuses x 2 x 3 x 2, less the six connected-and-replaced combinations.
    expect(checked).toBe(30);
    banner.destroy();
  });
});
