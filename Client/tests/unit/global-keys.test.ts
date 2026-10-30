import { beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_KEYS_PORTAL_BOUND_PREF,
  anyTriggerBound,
  clearPortalBound,
  functionKeyVk,
  globalKeysErrorCode,
  markPortalBound,
  portalBoundBefore,
  portalHoldsShortcuts,
} from "@lib/ui/globalKeys";
import { STORAGE_PREFIX } from "@lib/prefs/preferences";
import type { GlobalKeysStatus } from "../../src/platform/contracts/globalShortcuts";

function status(
  triggers: Partial<GlobalKeysStatus["triggers"]> = {},
  extra: Partial<GlobalKeysStatus> = {},
): GlobalKeysStatus {
  return {
    backend: "portal",
    portalVersion: 2,
    triggers: { ptt: null, mute: null, deafen: null, ...triggers },
    canConfigure: false,
    triggersUnnamed: false,
    sessionRefused: false,
    ...extra,
  };
}

beforeEach(() => localStorage.clear());

describe("portal bound marker", () => {
  it("reads false until a bind is remembered", () => {
    expect(portalBoundBefore()).toBe(false);
  });

  it("remembers a bind under its own preference key", () => {
    markPortalBound();
    expect(portalBoundBefore()).toBe(true);
    expect(localStorage.getItem(STORAGE_PREFIX + GLOBAL_KEYS_PORTAL_BOUND_PREF)).toBe("true");
    expect(GLOBAL_KEYS_PORTAL_BOUND_PREF).toBe("globalKeysPortalBound");
  });

  it("forgets the bind so the next start does not reopen the dialog", () => {
    markPortalBound();
    clearPortalBound();
    expect(portalBoundBefore()).toBe(false);
    expect(localStorage.getItem(STORAGE_PREFIX + GLOBAL_KEYS_PORTAL_BOUND_PREF)).toBe("false");
  });

  it("reads a corrupted stored value as not bound", () => {
    localStorage.setItem(STORAGE_PREFIX + GLOBAL_KEYS_PORTAL_BOUND_PREF, '"yes"');
    expect(portalBoundBefore()).toBe(false);
  });
});

describe("anyTriggerBound / portalHoldsShortcuts", () => {
  it("is false when no trigger is bound", () => {
    expect(anyTriggerBound(status())).toBe(false);
    expect(portalHoldsShortcuts(status())).toBe(false);
  });

  it.each(["ptt", "mute", "deafen"] as const)("is true when only %s is bound", (name) => {
    const s = status({ [name]: "CTRL+F1" });
    expect(anyTriggerBound(s)).toBe(true);
    expect(portalHoldsShortcuts(s)).toBe(true);
  });

  it("counts an empty-string trigger as bound, since only null is unbound", () => {
    expect(anyTriggerBound(status({ mute: "" }))).toBe(true);
  });

  it("holds the shortcuts when the portal lists all three without naming a key", () => {
    const s = status({}, { triggersUnnamed: true });
    expect(anyTriggerBound(s)).toBe(false);
    expect(portalHoldsShortcuts(s)).toBe(true);
  });

  it("does not hold them for a refused session with nothing bound", () => {
    expect(portalHoldsShortcuts(status({}, { sessionRefused: true }))).toBe(false);
  });
});

describe("functionKeyVk", () => {
  it("maps F1 to F24 onto consecutive virtual keys from 0x70", () => {
    expect(functionKeyVk("F1")).toBe(0x70);
    expect(functionKeyVk("F9")).toBe(0x78);
    expect(functionKeyVk("F10")).toBe(0x79);
    expect(functionKeyVk("F12")).toBe(0x7b);
    expect(functionKeyVk("F19")).toBe(0x82);
    expect(functionKeyVk("F20")).toBe(0x83);
    expect(functionKeyVk("F24")).toBe(0x87);
  });

  it.each(["F0", "F25", "F30", "F100", "f1", "F", "F1x", "xF1", " F1", "F01", "Space", "KeyF", ""])(
    "gives nothing for %j",
    (code) => {
      expect(functionKeyVk(code)).toBeNull();
    },
  );
});

describe("globalKeysErrorCode", () => {
  it("reads the code of a rejected bind", () => {
    const err = Object.assign(new Error("cancelled"), { code: "bind_cancelled" as const });
    expect(globalKeysErrorCode(err)).toBe("bind_cancelled");
  });

  it("is unknown for an error without a code, and for anything that is not an error", () => {
    expect(globalKeysErrorCode(new Error("plain"))).toBe("unknown");
    expect(globalKeysErrorCode({ code: "bind_failed" })).toBe("unknown");
    expect(globalKeysErrorCode("bind_failed")).toBe("unknown");
    expect(globalKeysErrorCode(null)).toBe("unknown");
    expect(globalKeysErrorCode(undefined)).toBe("unknown");
  });
});
