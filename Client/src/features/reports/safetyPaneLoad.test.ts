// The Safety pane's lazy sections: where each lands relative to the others,
// and what the pane says (or leaves alone) when a section cannot load or
// the tab closes first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/serverCapabilities";
import { buildSafetyPane } from "./safetyPane";

// A failed import is attempted again on the next one but a loaded module is
// cached, so each section's chunk is driven through this switchboard: the
// failing runs come first, then the runs where the chunks load.
const chunks = vi.hoisted(() => ({
  fail: false,
  gate: null as Promise<void> | null,
  dmGate: null as Promise<void> | null,
  buildDm: vi.fn(),
  loadBlocked: vi.fn(),
  buildReports: vi.fn(),
}));

async function arrive(): Promise<void> {
  if (chunks.gate !== null) await chunks.gate;
  if (chunks.fail) throw new Error("chunk failed");
}

vi.mock("../safety/DmPrivacy", async () => {
  if (chunks.dmGate !== null) await chunks.dmGate;
  await arrive();
  return { buildDmPrivacySection: chunks.buildDm };
});
vi.mock("../safety/BlockedUsers", async () => {
  await arrive();
  return { loadBlockedUsersSection: chunks.loadBlocked };
});
vi.mock("./myReports", async () => {
  await arrive();
  return { buildMyReportsSection: chunks.buildReports };
});

const api = {
  getMyReports: () => Promise.resolve([]),
  listBlocks: () => Promise.resolve({ blocked_user_ids: [] }),
  unblockUser: () => Promise.resolve(),
  getDmPrivacy: () => new Promise<never>(() => undefined),
  putDmPrivacy: () => new Promise<never>(() => undefined),
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function section(className: string): HTMLElement {
  const el = document.createElement("section");
  el.className = className;
  return el;
}

function gate(): { open: () => void } {
  let open!: () => void;
  chunks.gate = new Promise<void>((resolve) => (open = resolve));
  return { open };
}

const DM_FAILED = "Couldn't load your direct message settings. Close Settings and try again.";
const BLOCKED_FAILED = "Couldn't load your blocked users. Close Settings and try again.";
const REPORTS_FAILED = "Couldn't load your reports. Close Settings and try again.";

function alerts(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>("div.form-error")].filter(
    (a) => a.textContent !== "",
  );
}

let tab: AbortController;

beforeEach(() => {
  tab = new AbortController();
  chunks.fail = false;
  chunks.gate = null;
  chunks.dmGate = null;
  chunks.buildDm.mockReset().mockImplementation(() => section("dm-privacy"));
  chunks.loadBlocked
    .mockReset()
    .mockImplementation(() => Promise.resolve(section("blocked-users")));
  chunks.buildReports.mockReset().mockImplementation(() => section("my-reports"));
  applyReadyCapabilities({ dm_privacy: true });
});
afterEach(() => {
  tab.abort();
  document.body.replaceChildren();
  resetServerCapabilities();
});

describe("Safety pane section failures", () => {
  it("says so in the pane for each section that cannot load", async () => {
    chunks.fail = true;
    const pane = buildSafetyPane(tab.signal, api);
    await vi.waitFor(() => expect(alerts(pane)).toHaveLength(3));
    const byText = new Map(alerts(pane).map((a) => [a.textContent, a]));
    for (const text of [DM_FAILED, BLOCKED_FAILED, REPORTS_FAILED]) {
      const alert = byText.get(text)!;
      expect(alert.className).toBe("form-error");
      expect(alert.getAttribute("role")).toBe("alert");
      expect(alert.parentElement).toBe(pane);
    }
    // Reports follow everything else; the other two sit above it.
    expect(pane.lastElementChild).toBe(byText.get(REPORTS_FAILED));
    expect(chunks.buildDm).not.toHaveBeenCalled();
    expect(chunks.loadBlocked).not.toHaveBeenCalled();
    expect(chunks.buildReports).not.toHaveBeenCalled();
  });

  it("says nothing about a failure that arrives after the tab has closed", async () => {
    chunks.fail = true;
    const release = gate();
    const pane = buildSafetyPane(tab.signal, api);
    tab.abort();
    release.open();
    await flush();
    await flush();
    expect(alerts(pane)).toHaveLength(0);
    expect(pane.textContent).toBe("");
  });
});

describe("Safety pane section placement", () => {
  it("puts Direct messages above Blocked users when Blocked users arrives first", async () => {
    // The Blocked users chunk loads at once; Direct messages waits for it to land.
    let releaseDm!: () => void;
    chunks.dmGate = new Promise<void>((resolve) => (releaseDm = resolve));
    const pane = buildSafetyPane(tab.signal, api);
    await vi.waitFor(() => expect(pane.querySelector("section.blocked-users")).not.toBeNull());
    expect(pane.querySelector("section.dm-privacy")).toBeNull();
    releaseDm();
    await vi.waitFor(() => expect(pane.querySelector("section.dm-privacy")).not.toBeNull());
    const order = [...pane.children].map((c) => c.className);
    expect(order.indexOf("dm-privacy")).toBeLessThan(order.indexOf("blocked-users"));
    expect(pane.firstElementChild?.className).toBe("dm-privacy");
    expect(pane.firstElementChild?.nextElementSibling?.className).toBe("blocked-users");
  });

  it("adds nothing for sections whose chunks load after the tab has closed", async () => {
    const release = gate();
    const pane = buildSafetyPane(tab.signal, api);
    tab.abort();
    release.open();
    await flush();
    await flush();
    expect(chunks.buildDm).not.toHaveBeenCalled();
    expect(chunks.buildReports).not.toHaveBeenCalled();
    expect(pane.querySelector("section")).toBeNull();
  });
});
