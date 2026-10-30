import { describe, it, expect, beforeEach } from "vitest";
import {
  autoInputSensitivity,
  effectiveVoiceGate,
  effectiveVoiceSensitivity,
  inputMode,
  migrateAutoInputSensitivity,
  migrateInputMode,
} from "../../src/lib/ui/inputMode";

const PREFIX = "owncord:settings:";
const set = (key: string, value: unknown): void =>
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
const get = (key: string): unknown => {
  const raw = localStorage.getItem(PREFIX + key);
  return raw === null ? null : JSON.parse(raw);
};

describe("inputMode", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to Voice Activity on a fresh profile", () => {
    expect(inputMode()).toBe("vad");
  });

  it("reads Push to Talk for a profile from before Input Mode with a bound key", () => {
    set("pttVk", 0x41);
    expect(inputMode()).toBe("ptt");
  });

  it("a saved choice wins over the bound key", () => {
    set("pttVk", 0x41);
    set("inputMode", "vad");
    expect(inputMode()).toBe("vad");
  });

  it("ignores a corrupt saved value", () => {
    set("inputMode", "loud");
    expect(inputMode()).toBe("vad");
  });
});

describe("migrateInputMode", () => {
  beforeEach(() => localStorage.clear());

  it("saves Push to Talk for an existing bound key, so the setup does not change", () => {
    set("pttVk", 0x41);
    migrateInputMode();
    expect(get("inputMode")).toBe("ptt");
  });

  it("saves Voice Activity when no key is bound, so a later binding does not switch modes", () => {
    migrateInputMode();
    set("pttVk", 0x41);
    expect(get("inputMode")).toBe("vad");
    expect(inputMode()).toBe("vad");
  });

  it("leaves a saved choice alone", () => {
    set("inputMode", "vad");
    set("pttVk", 0x41);
    migrateInputMode();
    expect(get("inputMode")).toBe("vad");
  });
});

describe("effectiveVoiceSensitivity", () => {
  beforeEach(() => localStorage.clear());

  it("is the saved sensitivity in Voice Activity mode, even with a live key", () => {
    set("voiceSensitivity", 30);
    set("inputMode", "vad");
    set("pttVk", 0x41);
    expect(effectiveVoiceSensitivity(true)).toBe(30);
  });

  it("runs no sensitivity gate while a bound Push to Talk key is live", () => {
    set("voiceSensitivity", 30);
    set("inputMode", "ptt");
    set("pttVk", 0x41);
    expect(effectiveVoiceSensitivity(true)).toBe(100);
  });

  it("keeps the sensitivity gate in Push to Talk mode with no key or no live poller", () => {
    set("voiceSensitivity", 30);
    set("inputMode", "ptt");
    expect(effectiveVoiceSensitivity(true)).toBe(30);
    set("pttVk", 0x41);
    expect(effectiveVoiceSensitivity(false)).toBe(30);
  });
});

describe("autoInputSensitivity", () => {
  beforeEach(() => localStorage.clear());

  it("is on for a fresh profile", () => {
    expect(autoInputSensitivity()).toBe(true);
  });

  it("is on for a profile that kept the default sensitivity", () => {
    set("voiceSensitivity", 50);
    expect(autoInputSensitivity()).toBe(true);
  });

  it("stays manual for a profile that tuned the slider", () => {
    set("voiceSensitivity", 30);
    expect(autoInputSensitivity()).toBe(false);
    set("voiceSensitivity", 100);
    expect(autoInputSensitivity()).toBe(false);
  });

  it("treats a corrupt sensitivity as the default", () => {
    set("voiceSensitivity", "loud");
    expect(autoInputSensitivity()).toBe(true);
  });

  it("a saved choice wins over the slider", () => {
    set("voiceSensitivity", 30);
    set("autoInputSensitivity", true);
    expect(autoInputSensitivity()).toBe(true);
  });
});

describe("migrateAutoInputSensitivity", () => {
  beforeEach(() => localStorage.clear());

  it("saves manual for a tuned slider", () => {
    set("voiceSensitivity", 30);
    migrateAutoInputSensitivity();
    expect(get("autoInputSensitivity")).toBe(false);
  });

  it("saves automatic once, so a later slider move does not switch it off", () => {
    migrateAutoInputSensitivity();
    expect(get("autoInputSensitivity")).toBe(true);
    set("voiceSensitivity", 30);
    migrateAutoInputSensitivity();
    expect(get("autoInputSensitivity")).toBe(true);
    expect(autoInputSensitivity()).toBe(true);
  });

  it("leaves a saved choice alone", () => {
    set("autoInputSensitivity", false);
    migrateAutoInputSensitivity();
    expect(get("autoInputSensitivity")).toBe(false);
  });
});

describe("effectiveVoiceGate", () => {
  beforeEach(() => localStorage.clear());

  it("is automatic in Voice Activity mode when automatic sensitivity is on", () => {
    set("autoInputSensitivity", true);
    set("voiceSensitivity", 30);
    expect(effectiveVoiceGate(false)).toBe("auto");
  });

  it("is the saved sensitivity when automatic sensitivity is off, and off at 100", () => {
    set("autoInputSensitivity", false);
    set("voiceSensitivity", 30);
    expect(effectiveVoiceGate(false)).toBe(30);
    set("voiceSensitivity", 100);
    expect(effectiveVoiceGate(false)).toBe("off");
  });

  it("runs no gate while a bound Push to Talk key is live, even with automatic on", () => {
    set("autoInputSensitivity", true);
    set("inputMode", "ptt");
    set("pttVk", 0x41);
    expect(effectiveVoiceGate(true)).toBe("off");
    // No live poller: the automatic gate keeps gating.
    expect(effectiveVoiceGate(false)).toBe("auto");
  });
});
