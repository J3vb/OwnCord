import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("../../src/platform/desktop", () => ({
  desktop: {
    gpuAdapter: { available: true, list: host.list, set: host.set },
    appProcess: { relaunch: host.relaunch },
  },
}));

const { mountGpuAdapterRow } =
  await import("../../src/features/settings/voice-audio/voiceGpuAdapter");

const cards = [
  { id: "10de:1234:RTX", name: "NVIDIA RTX", vendorId: 0x10de, deviceId: 0x1234 },
  { id: "8086:0001:UHD", name: "Intel UHD", vendorId: 0x8086, deviceId: 1 },
];
const base = {
  cards,
  saved: "auto",
  active: null,
  notFound: false,
  resetAfterCrash: false,
};

let parent: HTMLElement;
let ctl: AbortController;

async function mount(state: unknown): Promise<void> {
  host.list.mockResolvedValue(state);
  mountGpuAdapterRow(parent, ctl.signal);
  await vi.waitFor(() => expect(host.list).toHaveBeenCalled());
  await Promise.resolve();
}

const select = (): HTMLSelectElement =>
  parent.querySelector<HTMLSelectElement>("[data-testid=gpu-adapter-select]")!;
const restart = (): HTMLButtonElement =>
  parent.querySelector<HTMLButtonElement>("[data-testid=gpu-adapter-restart]")!;

describe("graphics card row", () => {
  beforeEach(() => {
    parent = document.createElement("div");
    ctl = new AbortController();
    host.list.mockReset();
    host.set.mockReset().mockResolvedValue(true);
    host.relaunch.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => ctl.abort());

  it("lists Auto and every card, with the saved one selected", async () => {
    await mount({ ...base, saved: cards[1]!.id });
    expect([...select().options].map((o) => o.textContent)).toEqual([
      "Auto (recommended)",
      "NVIDIA RTX",
      "Intel UHD",
    ]);
    expect(select().value).toBe(cards[1]!.id);
    expect(restart().hidden).toBe(true);
  });

  it("is absent when the host cannot answer or finds no card", async () => {
    await mount(null);
    expect(parent.querySelector("[data-testid=gpu-adapter-row]")).toBeNull();
    parent.textContent = "";
    await mount({ ...base, cards: [] });
    expect(parent.querySelector("[data-testid=gpu-adapter-row]")).toBeNull();
  });

  it("saves a change, offers the restart and relaunches on click", async () => {
    await mount(base);
    select().value = cards[0]!.id;
    select().dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(restart().hidden).toBe(false));
    expect(host.set).toHaveBeenCalledWith(cards[0]!.id);
    restart().click();
    expect(host.relaunch).toHaveBeenCalled();
  });

  it("puts the old choice back when the save fails", async () => {
    host.set.mockResolvedValue(false);
    await mount(base);
    select().value = cards[0]!.id;
    select().dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(select().value).toBe("auto"));
    expect(restart().hidden).toBe(true);
    expect(parent.textContent).toContain("Could not save the choice.");
  });

  it("explains a missing saved card and a reset after a crash", async () => {
    await mount({ ...base, notFound: true, resetAfterCrash: true });
    expect(parent.textContent).toContain("Saved card not found, using Auto.");
    expect(parent.textContent).toContain("could not start on that card");
  });

  it("says Auto lets Windows choose and adds no note on a plain start", async () => {
    await mount(base);
    expect(parent.textContent).toContain("Auto lets Windows choose.");
    expect(parent.querySelectorAll("p.setting-desc")).toHaveLength(2);
  });
});
