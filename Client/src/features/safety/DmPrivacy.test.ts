// WP 6.8f: Settings > Safety > Direct messages: load, PUT body, rollback on
// failure, a stale reply, the dependent switch and the capability gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectConsole } from "../../../tests/helpers/console";
import type { DmPrivacy } from "@lib/api";
// Loaded here so the avatar module's app-lifetime listeners predate the first test.
import "@components/message-list/avatar";
import "../reports/myReports";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/serverCapabilities";
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

  it("returns the switch to the server value and says so when the PUT fails", async () => {
    const section = await loaded();
    allowSw(section).click();
    expect(checked(allowSw(section))).toBe("false");
    puts[0]!.reject(new TypeError("offline"));
    await flush();
    expectConsole("warn", /Failed to save direct message settings/);
    expect(checked(allowSw(section))).toBe("true");
    expect(errorLine(section)).toBe("Couldn't save that change. Your settings are unchanged.");
    // The next try starts from the server value.
    allowSw(section).click();
    expect(puts[1]!.body).toEqual({ allow_member_dms: false, message_requests: true });
    expect(errorLine(section)).toBe("");
  });

  it("rapid double toggle: the last click wins and a late earlier reply is ignored", async () => {
    const section = await loaded();
    allowSw(section).click(); // off
    reqSw(section).click(); // disabled now: ignored
    allowSw(section).click(); // back on
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual(both);
    puts[1]!.resolve(both);
    await flush();
    // The first request answers late, from a server that did not honour the abort.
    puts[0]!.resolve({ allow_member_dms: false, message_requests: true });
    await flush();
    expect(checked(allowSw(section))).toBe("true");
    expect(errorLine(section)).toBe("");
  });

  it("a late failure of an earlier request does not roll back the later click", async () => {
    const section = await loaded();
    allowSw(section).click();
    reqSw(section).click(); // ignored, DMs off
    allowSw(section).click();
    puts[1]!.resolve(both);
    puts[0]!.reject(new Error("late"));
    await flush();
    expect(checked(allowSw(section))).toBe("true");
    expect(errorLine(section)).toBe("");
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
