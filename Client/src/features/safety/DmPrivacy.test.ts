// WP 6.8f: Settings > Safety > Direct messages: load, PUT body, rollback on
// failure, a stale reply, the dependent switch and the capability gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectConsole } from "../../../tests/helpers/console";
import { captureLogs } from "../../../tests/helpers/log-capture";
import type { DmPrivacy } from "@lib/api";
// Loaded here so the avatar module's app-lifetime listeners predate the first test.
import "../profiles/avatar";
import "../reports/myReports";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { buildSafetyPane } from "../reports/safetyPane";
import { buildDmPrivacySection, type DmPrivacyApi } from "./DmPrivacy";

interface Deferred<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal | undefined;
}
interface Put extends Deferred<DmPrivacy> {
  body: DmPrivacy;
}

let gets: Deferred<DmPrivacy>[];
let puts: Put[];
let tab: AbortController;

const api: DmPrivacyApi = {
  getDmPrivacy: (signal) =>
    new Promise((resolve, reject) => gets.push({ resolve, reject, signal })),
  putDmPrivacy: (body, signal) =>
    new Promise((resolve, reject) => puts.push({ resolve, reject, signal, body })),
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const both: DmPrivacy = { allow_member_dms: true, message_requests: true };

function mount(): HTMLElement {
  const section = buildDmPrivacySection(tab.signal, api);
  document.body.appendChild(section);
  return section;
}
const switches = (s: HTMLElement): HTMLElement[] => [
  ...s.querySelectorAll<HTMLElement>("[role=switch]"),
];
const allowSw = (s: HTMLElement): HTMLElement => switches(s)[0]!;
const reqSw = (s: HTMLElement): HTMLElement => switches(s)[1]!;
const hintOf = (s: HTMLElement): HTMLElement =>
  s.querySelector<HTMLElement>("[data-testid^='dm-privacy-requests'][data-testid$='-hint']")!;
const checked = (el: HTMLElement): string | null => el.getAttribute("aria-checked");
const errorLine = (s: HTMLElement): string =>
  s.querySelector("[data-testid='dm-privacy-error']")!.textContent ?? "";

async function loaded(initial: DmPrivacy = both): Promise<HTMLElement> {
  const section = mount();
  gets[0]!.resolve(initial);
  await flush();
  return section;
}

beforeEach(() => {
  gets = [];
  puts = [];
  tab = new AbortController();
  resetServerCapabilities();
});
afterEach(() => {
  tab.abort();
  document.body.replaceChildren();
  resetServerCapabilities();
});

describe("DmPrivacy section", () => {
  it("renders both switches from the GET", async () => {
    const section = await loaded({ allow_member_dms: true, message_requests: false });
    expect(section.querySelector("h3")?.textContent).toBe("Direct messages");
    expect(allowSw(section).getAttribute("role")).toBe("switch");
    expect(checked(allowSw(section))).toBe("true");
    expect(checked(reqSw(section))).toBe("false");
    expect(reqSw(section).hasAttribute("aria-disabled")).toBe(false);
    expect(section.textContent).toContain("Allow direct messages from server members");
    expect(section.textContent).toContain("Message requests");
  });

  it("does not promise that everyone can reach you", async () => {
    const section = await loaded();
    const text = section.textContent ?? "";
    expect(text).not.toMatch(/everyone/i);
    expect(text).toContain("already ignored stays ignored");
  });

  it("sends the full object on a toggle and keeps the stored reply", async () => {
    const section = await loaded();
    reqSw(section).click();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ allow_member_dms: true, message_requests: false });
    expect(checked(reqSw(section))).toBe("false");
    puts[0]!.resolve({ allow_member_dms: true, message_requests: false });
    await flush();
    expect(checked(reqSw(section))).toBe("false");
    expect(errorLine(section)).toBe("");
  });

  it("toggles from the keyboard", async () => {
    const section = await loaded();
    allowSw(section).dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(puts[0]!.body).toEqual({ allow_member_dms: false, message_requests: true });
  });

  it("disables Message requests, with a hint, while direct messages are off", async () => {
    const section = await loaded({ allow_member_dms: false, message_requests: true });
    expect(reqSw(section).getAttribute("aria-disabled")).toBe("true");
    expect(hintOf(section).hidden).toBe(false);
    reqSw(section).click();
    expect(puts).toHaveLength(0);
    allowSw(section).click();
    puts[0]!.resolve(both);
    await flush();
    expect(reqSw(section).hasAttribute("aria-disabled")).toBe(false);
    expect(hintOf(section).hidden).toBe(true);
  });

  it("returns the switch to the re-read server value and says so when the PUT fails", async () => {
    const section = await loaded();
    allowSw(section).click();
    expect(checked(allowSw(section))).toBe("false");
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    expect(gets).toHaveLength(2);
    gets[1]!.resolve(both);
    await flush();
    expect(checked(allowSw(section))).toBe("true");
    expect(errorLine(section)).toBe("Couldn't save that change. Your settings are unchanged.");
    // The next try starts from the server value.
    allowSw(section).click();
    expect(puts[1]!.body).toEqual({ allow_member_dms: false, message_requests: true });
    expect(errorLine(section)).toBe("");
  });

  it("falls back to the last reply when the re-read fails too", async () => {
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    gets[1]!.reject(new TypeError("offline"));
    await flush();
    expect(checked(allowSw(section))).toBe("true");
    expect(errorLine(section)).toBe("Couldn't save that change. Your settings are unchanged.");
  });

  it("rapid double toggle: one PUT at a time, the latest object goes last and wins", async () => {
    const section = await loaded();
    allowSw(section).click(); // off: sent
    allowSw(section).click(); // back on, while the first is in flight
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ allow_member_dms: false, message_requests: true });
    puts[0]!.resolve({ allow_member_dms: false, message_requests: true });
    await flush();
    // The first reply must not overwrite the newer click.
    expect(checked(allowSw(section))).toBe("true");
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual(both);
    puts[1]!.resolve(both);
    await flush();
    expect(checked(allowSw(section))).toBe("true");
    expect(errorLine(section)).toBe("");
  });

  it("an earlier PUT that fails does not roll back a newer click, which is then sent", async () => {
    const section = await loaded();
    allowSw(section).click();
    allowSw(section).click();
    puts[0]!.reject(new Error("late"));
    await flush();
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual(both);
    puts[1]!.resolve(both);
    await flush();
    expect(checked(allowSw(section))).toBe("true");
    expect(errorLine(section)).toBe("");
    expect(gets).toHaveLength(1);
  });

  it("an earlier PUT succeeds late and the later one fails: the UI shows the server value", async () => {
    const section = await loaded();
    allowSw(section).click(); // off: PUT 1
    allowSw(section).click(); // on: queued
    puts[0]!.resolve({ allow_member_dms: false, message_requests: true });
    await flush();
    puts[1]!.reject(new TypeError("offline")); // the latest fails
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    // The server holds PUT 1's values; the re-read says so.
    gets[1]!.resolve({ allow_member_dms: false, message_requests: true });
    await flush();
    expect(checked(allowSw(section))).toBe("false");
    expect(reqSw(section).getAttribute("aria-disabled")).toBe("true");
    expect(errorLine(section)).toBe("Couldn't save that change. Your settings are unchanged.");
  });

  it("offers Retry when the GET fails", async () => {
    const section = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", /Failed to load direct message settings/);
    expect(errorLine(section)).toBe("Couldn't load your direct message settings.");
    section.querySelector<HTMLButtonElement>("[data-testid='dm-privacy-retry']")!.click();
    gets[1]!.resolve(both);
    await flush();
    expect(checked(allowSw(section))).toBe("true");
    expect(errorLine(section)).toBe("");
  });

  it("touches nothing after the tab closes", async () => {
    const section = mount();
    tab.abort();
    gets[0]!.resolve(both);
    await flush();
    expect(section.querySelector("[role=switch]")).toBeNull();
  });
});

const retryOf = (s: HTMLElement): HTMLButtonElement =>
  s.querySelector<HTMLButtonElement>("[data-testid='dm-privacy-retry']")!;
const statusOf = (s: HTMLElement): HTMLElement => s.querySelector<HTMLElement>("[role=status]")!;
const keydown = (el: HTMLElement, key: string): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};
const num = (el: HTMLElement): number => Number(el.id.slice("dm-privacy-".length));
const sameServer: DmPrivacy = { allow_member_dms: false, message_requests: true };

describe("DmPrivacy markup", () => {
  it("labels the section by its heading and gives each section its own ids", async () => {
    const first = await loaded();
    const heading = first.querySelector<HTMLElement>("h3")!;
    expect(first.className).toBe("dm-privacy");
    expect(first.getAttribute("data-testid")).toBe("dm-privacy");
    expect(heading.id).toMatch(/^dm-privacy-\d+$/);
    expect(first.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.className).toBe("safety-heading");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    const second = mount();
    const secondHeading = second.querySelector<HTMLElement>("h3")!;
    expect(secondHeading.id).not.toBe(heading.id);
    expect(num(secondHeading)).toBeGreaterThan(num(heading));
    expect(num(heading)).toBeGreaterThan(0);
  });

  it("gives the description, status, error and rows list their styling and roles", async () => {
    const section = await loaded();
    expect(section.querySelector("p")?.className).toBe("setting-desc");
    expect(statusOf(section).className).toBe("my-reports-status");
    const alert = section.querySelector<HTMLElement>("[role=alert]")!;
    expect(alert.className).toBe("form-error");
    expect(alert.getAttribute("data-testid")).toBe("dm-privacy-error");
    const rows = section.querySelector<HTMLElement>(".dm-privacy-rows")!;
    expect(rows.querySelectorAll("[role=switch]")).toHaveLength(2);
    const retry = retryOf(section);
    expect(retry.getAttribute("type")).toBe("button");
    expect(retry.className).toBe("ac-btn secondary");
  });

  it("wires each switch to its label, help and hint, and keeps it focusable", async () => {
    const section = await loaded();
    const rows = [...section.querySelectorAll<HTMLElement>(".setting-row")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const toggle = row.querySelector<HTMLElement>("[role=switch]")!;
      const id = toggle.getAttribute("data-testid")!;
      expect(row.getAttribute("data-testid")).toBe(`${id}-row`);
      expect(toggle.className).toContain("toggle");
      expect(toggle.getAttribute("tabindex")).toBe("0");
      const label = row.querySelector<HTMLElement>(".setting-label")!;
      expect(label.id).toBe(`${id}-label`);
      expect(toggle.getAttribute("aria-labelledby")).toBe(label.id);
      const descs = [...row.querySelectorAll<HTMLElement>(".setting-desc")];
      expect(descs.map((d) => d.id)).toEqual([`${id}-desc`, `${id}-hint`]);
      expect(toggle.getAttribute("aria-describedby")).toBe(`${id}-desc ${id}-hint`);
    }
    expect(allowSw(section).getAttribute("data-testid")).toMatch(/^dm-privacy-allow-\d+$/);
    expect(reqSw(section).getAttribute("data-testid")).toMatch(/^dm-privacy-requests-\d+$/);
  });
});

describe("DmPrivacy loading state", () => {
  it("shows a busy section and a disabled hidden Retry until the GET settles", async () => {
    const section = mount();
    expect(statusOf(section).textContent).toBe("Loading your direct message settings…");
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(retryOf(section).hidden).toBe(true);
    expect(retryOf(section).getAttribute("aria-disabled")).toBe("true");
    gets[0]!.resolve(both);
    await flush();
    expect(statusOf(section).textContent).toBe("");
    expect(section.hasAttribute("aria-busy")).toBe(false);
    expect(retryOf(section).hidden).toBe(true);
  });

  it("clears the busy state and the loading line when the GET fails, and shows Retry", async () => {
    const logs = captureLogs();
    const section = mount();
    gets[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to load direct message settings/);
    expect(statusOf(section).textContent).toBe("");
    expect(section.hasAttribute("aria-busy")).toBe(false);
    expect(retryOf(section).hidden).toBe(false);
    expect(retryOf(section).hasAttribute("aria-disabled")).toBe(false);
    const [entry] = logs.find("Failed to load direct message settings");
    expect(entry?.component).toBe("DmPrivacy");
    expect(entry?.data).toEqual({ error: "TypeError: offline" });
  });

  it("hides Retry again after a successful reload", async () => {
    const section = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", /Failed to load direct message settings/);
    retryOf(section).click();
    expect(statusOf(section).textContent).toBe("Loading your direct message settings…");
    gets[1]!.resolve(both);
    await flush();
    expect(retryOf(section).hidden).toBe(true);
    expect(statusOf(section).textContent).toBe("");
    expect(section.hasAttribute("aria-busy")).toBe(false);
  });

  it("ignores Retry while a load is already running", () => {
    const section = mount();
    retryOf(section).click();
    retryOf(section).click();
    expect(gets).toHaveLength(1);
  });

  it("moves focus to the heading when the focused Retry button goes away", async () => {
    const section = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", /Failed to load direct message settings/);
    retryOf(section).focus();
    expect(document.activeElement).toBe(retryOf(section));
    retryOf(section).click();
    gets[1]!.resolve(both);
    await flush();
    expect(document.activeElement).toBe(section.querySelector("h3"));
  });

  it("leaves focus alone when Retry did not have it", async () => {
    const section = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", /Failed to load direct message settings/);
    retryOf(section).click();
    gets[1]!.resolve(both);
    await flush();
    expect(document.activeElement).not.toBe(section.querySelector("h3"));
  });

  it("makes no request for a tab that is already closed", () => {
    tab.abort();
    const section = mount();
    expect(gets).toHaveLength(0);
    expect(statusOf(section).textContent).toBe("");
  });
});

describe("DmPrivacy keyboard and teardown", () => {
  it("toggles on Enter and Space and consumes those keys", async () => {
    const section = await loaded();
    expect(keydown(allowSw(section), "Enter").defaultPrevented).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual(sameServer);
    puts[0]!.resolve(both);
    await flush();
    expect(keydown(reqSw(section), " ").defaultPrevented).toBe(true);
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual({ allow_member_dms: true, message_requests: false });
  });

  it("ignores other keys and leaves them to the browser", async () => {
    const section = await loaded();
    for (const key of ["a", "Tab", "Escape", "ArrowDown"]) {
      expect(keydown(allowSw(section), key).defaultPrevented).toBe(false);
    }
    expect(puts).toHaveLength(0);
    expect(checked(allowSw(section))).toBe("true");
  });

  it("stops listening to clicks, keys and Retry once the tab closes", async () => {
    const failed = mount();
    gets[0]!.reject(new Error("offline"));
    await flush();
    expectConsole("warn", /Failed to load direct message settings/);
    const section = await (async () => {
      const s = mount();
      gets[1]!.resolve(both);
      await flush();
      return s;
    })();
    tab.abort();
    allowSw(section).click();
    keydown(reqSw(section), "Enter");
    retryOf(failed).click();
    expect(puts).toHaveLength(0);
    expect(gets).toHaveLength(2);
  });

  it("sends nothing more and shows nothing when a reply arrives after the tab closes", async () => {
    const section = await loaded();
    allowSw(section).click();
    allowSw(section).click(); // a newer click is waiting
    tab.abort();
    puts[0]!.resolve({ allow_member_dms: false, message_requests: true });
    await flush();
    expect(puts).toHaveLength(1);
  });

  it("does not retry, re-read or report a failed save after the tab closes", async () => {
    const logs = captureLogs();
    const section = await loaded();
    allowSw(section).click();
    tab.abort();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expect(gets).toHaveLength(1);
    expect(errorLine(section)).toBe("");
    expect(logs.find("Failed to save direct message settings")).toHaveLength(0);
  });

  it("does not send a queued click when the failed save settles after the tab closes", async () => {
    const section = await loaded();
    allowSw(section).click();
    allowSw(section).click();
    tab.abort();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expect(puts).toHaveLength(1);
    expect(gets).toHaveLength(1);
  });

  it("does not touch the switches when the re-read settles after the tab closes", async () => {
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    tab.abort();
    gets[1]!.resolve(both);
    await flush();
    expect(checked(allowSw(section))).toBe("false");
  });

  it("does not send a queued click when the re-read settles after the tab closes", async () => {
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    allowSw(section).click();
    tab.abort();
    gets[1]!.resolve(both);
    await flush();
    expect(puts).toHaveLength(1);
  });

  it("shows no load failure and no Retry when the first read fails after the tab closes", async () => {
    const logs = captureLogs();
    const section = mount();
    tab.abort();
    gets[0]!.reject(new TypeError("offline"));
    await flush();
    expect(errorLine(section)).toBe("");
    expect(retryOf(section).hidden).toBe(true);
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(logs.find("Failed to load direct message settings")).toHaveLength(0);
  });

  it("does not send a queued click when the failed re-read settles after the tab closes", async () => {
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    allowSw(section).click();
    tab.abort();
    gets[1]!.reject(new TypeError("offline"));
    await flush();
    expect(puts).toHaveLength(1);
  });
});

describe("DmPrivacy save sequencing", () => {
  it("sends the next click once the previous save has been confirmed", async () => {
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.resolve(sameServer);
    await flush();
    expect(puts).toHaveLength(1);
    allowSw(section).click();
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual(both);
  });

  it("shows the stored reply, including a value the server changed", async () => {
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.resolve({ allow_member_dms: false, message_requests: false });
    await flush();
    expect(checked(allowSw(section))).toBe("false");
    expect(checked(reqSw(section))).toBe("false");
    expect(reqSw(section).getAttribute("aria-disabled")).toBe("true");
    expect(hintOf(section).hidden).toBe(false);
  });

  it("logs which save failed with the error text", async () => {
    const logs = captureLogs();
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    const [entry] = logs.find("Failed to save direct message settings");
    expect(entry?.component).toBe("DmPrivacy");
    expect(entry?.data).toEqual({ error: "TypeError: offline" });
  });

  it("accepts a click after the re-read failed too", async () => {
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    gets[1]!.reject(new TypeError("offline"));
    await flush();
    allowSw(section).click();
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual(sameServer);
  });

  it("sends a click made while the re-read is running, and keeps it on screen", async () => {
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    allowSw(section).click(); // back to on, while the re-read is in flight
    expect(puts).toHaveLength(1);
    gets[1]!.resolve(sameServer);
    await flush();
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual(both);
    expect(checked(allowSw(section))).toBe("true");
  });

  it("sends a click made while the re-read is running when the re-read fails", async () => {
    const section = await loaded();
    allowSw(section).click();
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    allowSw(section).click();
    gets[1]!.reject(new TypeError("offline"));
    await flush();
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual(both);
    expect(checked(allowSw(section))).toBe("true");
  });
});

describe("DmPrivacy in the Safety pane", () => {
  const paneApi = {
    ...api,
    getMyReports: () => Promise.resolve([]),
    listBlocks: () => Promise.resolve({ blocked_user_ids: [] }),
    unblockUser: () => Promise.resolve(),
  };

  it("sits above Blocked users when the server has dm_privacy", async () => {
    applyReadyCapabilities({ dm_privacy: true });
    const pane = buildSafetyPane(tab.signal, paneApi);
    await vi.waitFor(() => expect(pane.querySelector("section.blocked-users") !== null).toBe(true));
    await vi.waitFor(() => expect(pane.querySelector("section.dm-privacy") !== null).toBe(true));
    expect(pane.firstElementChild?.matches("section.dm-privacy")).toBe(true);
    expect(pane.firstElementChild?.nextElementSibling?.matches("section.blocked-users")).toBe(true);
    expect(gets).toHaveLength(1);
  });

  it("is hidden, and never fetched, without the capability", async () => {
    applyReadyCapabilities({});
    const pane = buildSafetyPane(tab.signal, paneApi);
    await vi.waitFor(() => expect(pane.querySelector("section.blocked-users") !== null).toBe(true));
    expect(pane.querySelector("section.dm-privacy")).toBeNull();
    expect(gets).toHaveLength(0);
  });
});
