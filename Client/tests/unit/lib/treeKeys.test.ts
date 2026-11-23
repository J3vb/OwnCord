import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableTreeNavigation, type TreeNavigation } from "../../../src/lib/ui/treeKeys";

type Kind = "head" | "row" | "child";

/** A flat tree item as the views draw it: role, kind and a parked tabindex. */
function item(kind: Kind, name: string, extra: Record<string, string> = {}): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "treeitem");
  el.dataset.treeKind = kind;
  el.setAttribute("tabindex", "-1");
  el.setAttribute("data-testid", name);
  const label = document.createElement("span");
  label.className = kind === "child" ? "vu-name" : "ch-name";
  label.textContent = name;
  el.append(label);
  for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
  return el;
}

function group(...children: HTMLElement[]): HTMLElement {
  const g = document.createElement("div");
  g.setAttribute("data-tree-group", "");
  g.append(...children);
  return g;
}

/**
 * INFO (head)         general, rules
 * VOICE (head)        lounge (row) > kade, rin (children), quiet (row)
 * loose (row, no head)  > thread (child)
 */
function build(): {
  tree: HTMLElement;
  nav: TreeNavigation;
  by: (name: string) => HTMLElement;
  life: AbortController;
} {
  const tree = document.createElement("div");
  tree.setAttribute("role", "tree");
  const life = new AbortController();
  const voiceBox = document.createElement("div");
  voiceBox.append(item("row", "lounge"), item("child", "kade"), item("child", "rin"));
  tree.append(
    item("head", "INFO", { "aria-expanded": "true" }),
    group(item("row", "general"), item("row", "rules")),
    item("head", "VOICE", { "aria-expanded": "true" }),
    group(voiceBox, item("row", "quiet")),
    item("row", "loose"),
    item("child", "thread"),
  );
  document.body.append(tree);
  const nav = enableTreeNavigation(tree, life.signal);
  nav.refresh();
  return {
    tree,
    nav,
    life,
    by: (name) => tree.querySelector<HTMLElement>(`[data-testid='${name}']`)!,
  };
}

function press(el: Element, key: string, init: KeyboardEventInit = {}, timeStamp?: number): Event {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  if (timeStamp !== undefined) Object.defineProperty(e, "timeStamp", { value: timeStamp });
  el.dispatchEvent(e);
  return e;
}

let rig: ReturnType<typeof build>;

beforeEach(() => {
  rig = build();
});

afterEach(() => {
  rig.life.abort();
  document.body.replaceChildren();
});

describe("treeKeys refresh", () => {
  it("stamps levels: heads 1, rows 2 inside a group, 1 outside, children under the row before", () => {
    const levels = Array.from(rig.tree.querySelectorAll("[role=treeitem]")).map((el) => [
      el.getAttribute("data-testid"),
      el.getAttribute("aria-level"),
    ]);
    expect(levels).toEqual([
      ["INFO", "1"],
      ["general", "2"],
      ["rules", "2"],
      ["VOICE", "1"],
      ["lounge", "2"],
      ["kade", "3"],
      ["rin", "3"],
      ["quiet", "2"],
      ["loose", "1"],
      ["thread", "2"],
    ]);
  });

  it("stamps set size and position over items sharing a tree parent and level", () => {
    const set = (name: string): string[] => [
      rig.by(name).getAttribute("aria-posinset")!,
      rig.by(name).getAttribute("aria-setsize")!,
    ];
    // The two headers and the uncategorized row have no tree parent: one set of three.
    expect(set("INFO")).toEqual(["1", "3"]);
    expect(set("VOICE")).toEqual(["2", "3"]);
    expect(set("loose")).toEqual(["3", "3"]);
    expect(set("general")).toEqual(["1", "2"]);
    expect(set("lounge")).toEqual(["1", "2"]);
    // A voice channel between two rows of one category counts in the same set.
    expect(set("quiet")).toEqual(["2", "2"]);
    expect(set("kade")).toEqual(["1", "2"]);
    expect(set("rin")).toEqual(["2", "2"]);
    expect(set("thread")).toEqual(["1", "1"]);
  });

  it("makes exactly one item tabbable, the first when nothing else decides", () => {
    const stops = rig.tree.querySelectorAll("[role=treeitem][tabindex='0']");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(rig.by("INFO"));
  });

  it("makes no attribute write on an unchanged tree", () => {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(rig.tree, { attributes: true, subtree: true });
    rig.nav.refresh();
    rig.nav.refresh();
    seen.push(...observer.takeRecords());
    observer.disconnect();
    expect(seen).toEqual([]);
  });

  it("replaces a removed stop with exactly one tabindex 0", () => {
    rig.by("INFO").remove();
    rig.nav.refresh();
    const stops = rig.tree.querySelectorAll("[role=treeitem][tabindex='0']");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(rig.by("general"));
  });

  it("restamps only what changed after an item joins", () => {
    const added = item("row", "extra");
    rig.by("rules").after(added);
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((r) => seen.push(...r));
    observer.observe(rig.tree, { attributes: true, subtree: true });
    rig.nav.refresh();
    seen.push(...observer.takeRecords());
    observer.disconnect();
    expect(added.getAttribute("aria-level")).toBe("2");
    expect(rig.by("general").getAttribute("aria-setsize")).toBe("3");
    // The new item and the two siblings' set size; no tabindex was rewritten.
    expect(seen.some((r) => r.attributeName === "tabindex")).toBe(false);
  });
});

describe("treeKeys keyboard", () => {
  const focusOn = (name: string): HTMLElement => {
    const el = rig.by(name);
    el.focus();
    return el;
  };

  it("steps down and up through the items in DOM order, moving the Tab stop", () => {
    focusOn("INFO");
    press(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(rig.by("general"));
    expect(rig.by("general").getAttribute("tabindex")).toBe("0");
    expect(rig.by("INFO").getAttribute("tabindex")).toBe("-1");
    press(document.activeElement!, "ArrowUp");
    expect(document.activeElement).toBe(rig.by("INFO"));
    press(document.activeElement!, "ArrowUp");
    expect(document.activeElement).toBe(rig.by("INFO"));
    expect(rig.tree.querySelectorAll("[tabindex='0']")).toHaveLength(1);
  });

  it("jumps to the first and last item with Home and End", () => {
    focusOn("rules");
    press(document.activeElement!, "End");
    expect(document.activeElement).toBe(rig.by("thread"));
    press(document.activeElement!, "Home");
    expect(document.activeElement).toBe(rig.by("INFO"));
  });

  it("clicks the focused item on Enter and Space and stops the default", () => {
    const clicked = vi.fn();
    rig.by("general").addEventListener("click", clicked);
    focusOn("general");
    expect(press(rig.by("general"), "Enter").defaultPrevented).toBe(true);
    expect(press(rig.by("general"), " ").defaultPrevented).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(2);
  });

  it("opens a closed header on Right and closes an open one on Left", () => {
    const head = rig.by("INFO");
    const clicked = vi.fn();
    head.addEventListener("click", clicked);
    head.setAttribute("aria-expanded", "false");
    focusOn("INFO");
    press(head, "ArrowRight");
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(head);
    head.setAttribute("aria-expanded", "true");
    press(head, "ArrowLeft");
    expect(clicked).toHaveBeenCalledTimes(2);
  });

  it("moves into the first child on Right and back to the tree parent on Left", () => {
    focusOn("INFO");
    press(rig.by("INFO"), "ArrowRight");
    expect(document.activeElement).toBe(rig.by("general"));
    press(rig.by("general"), "ArrowLeft");
    expect(document.activeElement).toBe(rig.by("INFO"));
    // A voice channel's first user, and back up to the channel, not the DOM parent.
    focusOn("lounge");
    press(rig.by("lounge"), "ArrowRight");
    expect(document.activeElement).toBe(rig.by("kade"));
    press(rig.by("kade"), "ArrowLeft");
    expect(document.activeElement).toBe(rig.by("lounge"));
  });

  it("does nothing on Right from a row with no children, or Left from a top-level row", () => {
    focusOn("rules");
    press(rig.by("rules"), "ArrowRight");
    expect(document.activeElement).toBe(rig.by("rules"));
    focusOn("INFO");
    press(rig.by("INFO"), "ArrowLeft");
    expect(document.activeElement).toBe(rig.by("INFO"));
  });

  it("ignores Alt, Ctrl and Meta before any key is handled", () => {
    focusOn("INFO");
    for (const mod of ["altKey", "ctrlKey", "metaKey"] as const) {
      for (const key of ["ArrowDown", "Enter", "g"]) {
        const e = press(rig.by("INFO"), key, { [mod]: true });
        expect(e.defaultPrevented, `${mod}+${key}`).toBe(false);
      }
    }
    expect(document.activeElement).toBe(rig.by("INFO"));
  });

  it("skips an event another handler already prevented", () => {
    const clicked = vi.fn();
    rig.by("kade").addEventListener("click", clicked);
    rig.by("kade").addEventListener("keydown", (e) => e.preventDefault());
    focusOn("kade");
    press(rig.by("kade"), "Enter");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("leaves a key pressed on a nested control alone", () => {
    const pill = document.createElement("button");
    rig.by("kade").append(pill);
    const clicked = vi.fn();
    rig.by("kade").addEventListener("click", clicked);
    const e = press(pill, "Enter");
    expect(e.defaultPrevented).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  });

  it("counts the participant click once when the row's own Enter handler runs first", () => {
    const row = rig.by("kade");
    const opened = vi.fn();
    row.addEventListener("click", opened);
    // The sidebar's own handler: Enter acts and prevents the default.
    row.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      row.click();
    });
    focusOn("kade");
    press(row, "Enter");
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("does not stop at an unrelated key", () => {
    focusOn("INFO");
    expect(press(rig.by("INFO"), "Tab").defaultPrevented).toBe(false);
    expect(press(rig.by("INFO"), "Escape").defaultPrevented).toBe(false);
  });
});

describe("treeKeys type-ahead", () => {
  it("jumps to the next item whose name starts with the typed letter", () => {
    rig.by("INFO").focus();
    press(rig.by("INFO"), "r", {}, 1000);
    expect(document.activeElement).toBe(rig.by("rules"));
    press(rig.by("rules"), "r", {}, 5000);
    expect(document.activeElement).toBe(rig.by("rin"));
  });

  it("extends the buffer within 500 ms and resets it after", () => {
    rig.by("INFO").focus();
    press(rig.by("INFO"), "q", {}, 1000);
    expect(document.activeElement).toBe(rig.by("quiet"));
    press(rig.by("quiet"), "u", {}, 1400);
    expect(document.activeElement).toBe(rig.by("quiet"));
    // 600 ms later "u" starts a new buffer and matches nothing.
    press(rig.by("quiet"), "u", {}, 2000);
    expect(document.activeElement).toBe(rig.by("quiet"));
    // The search starts after the focused row and wraps: "loose" comes before "lounge".
    press(rig.by("quiet"), "l", {}, 3000);
    expect(document.activeElement).toBe(rig.by("loose"));
  });

  it("reads a header's name from the element its aria-labelledby points to, and ignores a leading #", () => {
    const label = document.createElement("span");
    label.id = "cat-label";
    label.textContent = "#Zeta";
    const head = item("head", "zz", { "aria-labelledby": "cat-label", "aria-expanded": "true" });
    head.querySelector(".ch-name")!.textContent = "unrelated";
    rig.tree.append(head);
    document.body.append(label);
    rig.nav.refresh();
    rig.by("INFO").focus();
    press(rig.by("INFO"), "z", {}, 1000);
    expect(document.activeElement).toBe(head);
    // The row's own text is not the name when a label is named.
    press(head, "u", {}, 9000);
    expect(document.activeElement).toBe(head);
  });

  it("matches a character typed with AltGr, which Windows reports as Ctrl+Alt", () => {
    const at = item("row", "@home");
    rig.tree.append(at);
    rig.nav.refresh();
    rig.by("INFO").focus();
    press(rig.by("INFO"), "@", { ctrlKey: true, altKey: true }, 1000);
    expect(document.activeElement).toBe(at);
  });

  it("leaves Ctrl+letter and Alt+letter alone", () => {
    rig.by("INFO").focus();
    expect(press(rig.by("INFO"), "r", { ctrlKey: true }, 1000).defaultPrevented).toBe(false);
    press(rig.by("INFO"), "r", { altKey: true }, 5000);
    expect(document.activeElement).toBe(rig.by("INFO"));
  });

  it("ignores case", () => {
    rig.by("INFO").focus();
    press(rig.by("INFO"), "V", { shiftKey: true }, 1000);
    expect(document.activeElement).toBe(rig.by("VOICE"));
  });
});

describe("treeKeys focus", () => {
  it("moves the Tab stop to a row focused by mouse, and from a control inside it", () => {
    rig.by("rin").focus();
    expect(rig.by("rin").getAttribute("tabindex")).toBe("0");
    expect(rig.by("INFO").getAttribute("tabindex")).toBe("-1");
    const pill = document.createElement("button");
    pill.tabIndex = -1;
    rig.by("rules").append(pill);
    pill.focus();
    expect(rig.by("rules").getAttribute("tabindex")).toBe("0");
    expect(rig.by("rin").getAttribute("tabindex")).toBe("-1");
    expect(rig.tree.querySelectorAll("[role=treeitem][tabindex='0']")).toHaveLength(1);
  });

  it("stops handling keys once its signal aborts", () => {
    rig.life.abort();
    rig.by("INFO").focus();
    expect(press(rig.by("INFO"), "ArrowDown").defaultPrevented).toBe(false);
  });
});

describe("treeKeys: a collapsed category that still draws the joined voice channel", () => {
  // The header says collapsed, but its container holds the joined channel's row.
  function collapsed(): {
    tree: HTMLElement;
    head: HTMLElement;
    joined: HTMLElement;
    nav: TreeNavigation;
    life: AbortController;
  } {
    document.body.replaceChildren();
    const tree = document.createElement("div");
    const head = item("head", "VOICE", { "aria-expanded": "false" });
    const joined = item("row", "lounge");
    tree.append(head, group(joined), item("head", "ARCHIVE", { "aria-expanded": "false" }));
    document.body.append(tree);
    const life = new AbortController();
    const nav = enableTreeNavigation(tree, life.signal);
    nav.refresh();
    return { tree, head, joined, nav, life };
  }

  it("reaches the row with Down, returns with Left and opens the header with Right", () => {
    const { head, joined, life } = collapsed();
    head.focus();
    press(head, "ArrowDown");
    expect(document.activeElement).toBe(joined);
    press(joined, "ArrowLeft");
    expect(document.activeElement).toBe(head);
    const toggled = vi.fn();
    head.addEventListener("click", toggled);
    press(head, "ArrowRight");
    expect(toggled).toHaveBeenCalledTimes(1);
    life.abort();
  });

  it("keeps focus on the header across the rebuild a toggle causes", () => {
    const { tree, head, nav, life } = collapsed();
    head.focus();
    // The reconciler draws a fresh header (tabindex -1) and hands focus to it.
    const fresh = item("head", "VOICE", { "aria-expanded": "true" });
    head.replaceWith(fresh);
    fresh.focus();
    nav.refresh();
    expect(document.activeElement).toBe(fresh);
    expect(fresh.getAttribute("tabindex")).toBe("0");
    expect(tree.querySelectorAll("[role=treeitem][tabindex='0']")).toHaveLength(1);
    life.abort();
  });
});
