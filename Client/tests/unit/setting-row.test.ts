import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChoiceRow,
  buildSettingRow,
  createSegmented,
} from "../../src/features/settings/settingRow";

type Pick3 = "a" | "b" | "c";
const OPTIONS: readonly (readonly [Pick3, string])[] = [
  ["a", "Alpha"],
  ["b", "Beta"],
  ["c", "Gamma"],
];

describe("buildSettingRow", () => {
  it("puts the title and description beside the control", () => {
    const control = document.createElement("button");
    const row = buildSettingRow({ label: "Compact", desc: "Tighter rows", control });
    expect(row.className).toBe("setting-row");
    const info = row.firstElementChild as HTMLElement;
    expect(info.className).toBe("setting-info");
    expect(info.querySelector(".setting-label")!.textContent).toBe("Compact");
    expect(info.querySelector(".setting-desc")!.textContent).toBe("Tighter rows");
    expect(row.lastElementChild).toBe(control);
  });

  it("leaves the description out when there is none, and stacks a wide control", () => {
    const row = buildSettingRow({
      label: "Theme",
      control: document.createElement("div"),
      stacked: true,
    });
    expect(row.className).toBe("setting-row stacked");
    expect(row.querySelector(".setting-desc")).toBeNull();
  });
});

describe("createSegmented", () => {
  let ac: AbortController;
  afterEach(() => ac.abort());

  function make(start: Pick3 = "a"): {
    seg: ReturnType<typeof createSegmented<Pick3>>;
    save: ReturnType<typeof vi.fn>;
    state: { v: Pick3 };
  } {
    ac = new AbortController();
    const state = { v: start };
    const save = vi.fn((v: Pick3) => {
      state.v = v;
    });
    const seg = createSegmented<Pick3>({
      signal: ac.signal,
      label: "Pick",
      testId: "pick",
      options: OPTIONS,
      current: () => state.v,
      save,
    });
    document.body.appendChild(seg.el);
    return { seg, save, state };
  }
  const radio = (v: Pick3): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(`[data-testid='pick-${v}']`)!;
  const select = (): HTMLSelectElement =>
    document.querySelector<HTMLSelectElement>("[data-testid='pick-select']")!;

  afterEach(() => document.body.replaceChildren());

  it("draws a labelled radiogroup and a matching select, both on the current value", () => {
    make("b");
    const group = document.querySelector("[data-testid='pick']")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Pick");
    expect(select().getAttribute("aria-label")).toBe("Pick");
    expect([...select().options].map((o) => [o.value, o.textContent])).toEqual([
      ["a", "Alpha"],
      ["b", "Beta"],
      ["c", "Gamma"],
    ]);
    expect(radio("b").getAttribute("aria-checked")).toBe("true");
    expect(radio("b").classList.contains("active")).toBe(true);
    expect(radio("a").getAttribute("aria-checked")).toBe("false");
    expect(select().value).toBe("b");
  });

  it("a radio click saves and moves both forms", () => {
    const { save } = make();
    radio("c").click();
    expect(save).toHaveBeenCalledWith("c");
    expect(radio("c").getAttribute("aria-checked")).toBe("true");
    expect(radio("a").getAttribute("aria-checked")).toBe("false");
    expect(select().value).toBe("c");
  });

  it("a select change saves and moves the radios", () => {
    const { save } = make();
    select().value = "b";
    select().dispatchEvent(new Event("change"));
    expect(save).toHaveBeenCalledWith("b");
    expect(radio("b").getAttribute("aria-checked")).toBe("true");
  });

  it("paint follows a change made elsewhere", () => {
    const { seg, state } = make();
    state.v = "c";
    seg.paint();
    expect(radio("c").getAttribute("aria-checked")).toBe("true");
    expect(select().value).toBe("c");
  });

  it("stops listening once the signal aborts", () => {
    const { save } = make();
    ac.abort();
    radio("b").click();
    select().value = "c";
    select().dispatchEvent(new Event("change"));
    expect(save).not.toHaveBeenCalled();
  });
});

describe("buildChoiceRow", () => {
  it("is a setting row whose control is the segmented choice", () => {
    const ac = new AbortController();
    const { row } = buildChoiceRow<Pick3>({
      signal: ac.signal,
      label: "Pick",
      desc: "One of three",
      testId: "pick",
      options: OPTIONS,
      current: () => "a",
      save: vi.fn(),
    });
    expect(row.className).toBe("setting-row");
    expect(row.querySelector(".setting-desc")!.textContent).toBe("One of three");
    expect(row.lastElementChild!.className).toBe("segmented-wrap");
    ac.abort();
  });
});
