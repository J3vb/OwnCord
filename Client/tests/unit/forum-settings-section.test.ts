import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { ApiClientError } from "@lib/api";
import type { ForumSettings, ForumSettingsBody } from "@lib/types";
import { removeChannel, updateChannel } from "@stores/channels.store";
import {
  createForumSettingsSection,
  type ForumSettingsSection,
} from "../../src/features/forums/ForumSettingsSection";
import { forumsText } from "../../src/i18n/forums";
import { FORUM, TAGS, seedForum } from "../helpers/forum-fixtures";

type Save = (body: ForumSettingsBody) => Promise<void>;

const STATE: ForumSettings = { tags: TAGS, require_tag: false, default_auto_archive_minutes: 4320 };
const numbered = (n: number): ForumSettings["tags"] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `t${i}`, position: i }));
const ONE = [{ id: 1, name: "Only", position: 0 }];
const NAME_ERR = "Every tag needs a name of 1 to 20 characters";

describe("createForumSettingsSection", () => {
  let container: HTMLDivElement;
  let section: ForumSettingsSection | null = null;
  useMountContainer((c) => {
    container = c;
  });
  beforeEach(() => seedForum());
  afterEach(() => {
    section?.destroy();
    section = null;
  });

  const q = <T extends HTMLElement>(id: string): T =>
    container.querySelector<T>(`[data-testid='${id}']`) as T;
  const rows = (): HTMLElement[] => Array.from(container.querySelectorAll(".forum-tag-row"));
  const names = (): string[] =>
    rows().map((r) => r.querySelector<HTMLInputElement>(".forum-tag-row-name")!.value);
  const count = (): string | null | undefined =>
    q("forum-settings-add").nextElementSibling?.textContent;
  const type = (el: HTMLInputElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const name = (i: number, v: string): void => type(q(`forum-settings-tag-name-${i}`), v);
  const period = (v: string): void => {
    const a = q<HTMLSelectElement>("forum-settings-archive");
    a.value = v;
    a.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const click = (id: string): void => q(id).click();
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const live = (over: Partial<ForumSettings>): void =>
    updateChannel({ id: FORUM, forum: { ...STATE, ...over } });
  const note = (): HTMLElement => q("forum-settings-note");
  const error = (): HTMLElement => q("forum-settings-error");
  const props = (
    el: Element | null | undefined,
    ...keys: string[]
  ): (string | null | undefined)[] =>
    keys.map((k) =>
      k === "text" ? el?.textContent : k === "class" ? el?.className : el?.getAttribute(k),
    );
  const chk = (): HTMLInputElement => q("forum-settings-require-tag");
  const sel = (): HTMLSelectElement => q("forum-settings-archive");
  const val = (id: string): string => q<HTMLInputElement>(id).value;
  const noteShown = (): Promise<void> => vi.waitFor(() => expect(note().hidden).toBe(false));
  const pending = (): Promise<void> => new Promise<void>(() => {});

  function mount(save: Save = vi.fn(async () => {})): ForumSettingsSection {
    const s = createForumSettingsSection({ channelId: FORUM, save });
    if (s === null) throw new Error("section did not mount");
    container.appendChild(s.element);
    section = s;
    return s;
  }

  describe("mounting", () => {
    it("returns null for an unknown channel or one without a forum block", () => {
      const save = vi.fn(async () => {});
      expect(createForumSettingsSection({ channelId: 12345, save })).toBeNull();
      seedForum({ type: "text", forum: undefined });
      expect(createForumSettingsSection({ channelId: FORUM, save })).toBeNull();
    });

    it("lays out the title, groups, labels, hints and options, with no note or error yet", () => {
      mount();
      const root = q("forum-settings");
      const groups = Array.from(root.querySelectorAll(":scope > .form-group"));
      const label = groups[0]!.querySelector(".form-label")!;
      const foot = groups[0]!.querySelector(".forum-tag-editor-foot")!;
      const lbl = groups[2]!.querySelector("label");
      expect(groups).toHaveLength(3);
      expect(props(root.querySelector(".form-section-title"), "text")).toEqual(["Forum settings"]);
      expect(props(label, "text", "id")).toEqual(["Tags", `forum-settings-tags-label-${FORUM}`]);
      expect(props(q("forum-settings-tags"), "role", "aria-labelledby")).toEqual([
        "list",
        label.id,
      ]);
      expect(Array.from(foot.children).map((c) => c.tagName)).toEqual(["BUTTON", "SPAN"]);
      expect(count()).toBe("3/20 tags");
      expect(groups.map((g) => props(g.lastElementChild, "class", "text"))).toEqual([
        ["form-hint", forumsText("settings.tagsHint")],
        ["form-hint", forumsText("settings.requireTagHint")],
        ["form-hint", forumsText("settings.archiveHint")],
      ]);
      expect(props(chk().parentElement, "class", "text")).toEqual([
        "form-check",
        "Require a tag on new posts",
      ]);
      expect(props(lbl, "class", "for", "text")).toEqual([
        "form-label",
        sel().id,
        "Default auto-archive",
      ]);
      expect(sel().id).toBe(`forum-settings-archive-${FORUM}`);
      expect(Array.from(sel().options).map((o) => [o.value, o.textContent])).toEqual([
        ["60", "1 hour"],
        ["1440", "24 hours"],
        ["4320", "3 days"],
        ["10080", "1 week"],
      ]);
      expect(props(q("forum-settings-add"), "text", "type")).toEqual(["Add tag", "button"]);
      expect(props(q("forum-settings-save"), "text", "type")).toEqual([
        "Save forum settings",
        "button",
      ]);
      const classes = [".form-section", ".form-group", ".form-hint", ".form-label", ".form-check"];
      classes.push(".forum-tag-editor", ".forum-tag-editor-foot", ".forum-tag-add", ".btn-primary");
      classes.push(
        ".forum-settings-error",
        ".form-input",
        ".forum-tag-row-emoji",
        ".forum-tag-row-name",
      );
      classes.push(".forum-tag-row-btn", ".form-section-title");
      expect(classes.map((c) => document.querySelectorAll(c).length)).toEqual([
        1, 3, 5, 2, 1, 1, 1, 1, 1, 1, 7, 3, 3, 9, 1,
      ]);
      expect([note().hidden, error().hidden]).toEqual([true, true]);
      expect(props(note(), "role")).toEqual(["status"]);
      expect(props(error(), "role")).toEqual(["alert"]);
    });

    it("shows the store's values, ordered by position", () => {
      const tags = [
        { id: 1, name: "Late", position: 5 },
        { id: 2, name: "Early", position: 1 },
      ];
      seedForum({}, { require_tag: true, default_auto_archive_minutes: 10080, tags });
      mount();
      expect([chk().checked, sel().value, names()]).toEqual([true, "10080", ["Early", "Late"]]);
    });

    it("says there are no tags and enables Add when the forum has none", () => {
      seedForum({}, { tags: [] });
      mount();
      expect(q("forum-settings-no-tags").textContent).toBe("No tags yet");
      expect(q("forum-settings-no-tags").className).toBe("form-hint");
      expect(count()).toBe("0/20 tags");
      expect(q<HTMLButtonElement>("forum-settings-add").disabled).toBe(false);
    });
  });

  describe("tag rows", () => {
    it("labels each row's inputs and buttons by position and name", () => {
      mount();
      expect(props(rows()[0], "role", "data-testid")).toEqual(["listitem", "forum-settings-tag-0"]);
      expect([val("forum-settings-tag-emoji-0"), val("forum-settings-tag-emoji-2")]).toEqual([
        "🐛",
        "",
      ]);
      for (const [kind, ph] of [
        ["emoji", "Emoji"],
        ["name", "Name"],
      ]) {
        const keys = ["placeholder", "aria-label", "autocomplete"];
        expect(props(q(`forum-settings-tag-${kind}-1`), ...keys)).toEqual([
          ph,
          `Tag 2 ${kind}`,
          "off",
        ]);
      }
      for (const [id, text, move, icon] of [
        ["up", "Move Idea up", "-1", "chevron-up"],
        ["down", "Move Idea down", "1", "chevron-down"],
        ["remove", "Remove Idea", null, "trash-2"],
      ]) {
        const b = q(`forum-settings-tag-${id}-1`);
        expect(props(b, "aria-label", "title", "data-move")).toEqual([text, text, move]);
        expect(props(b.querySelector("svg"), "data-icon")).toEqual([icon]);
      }
    });

    it("disables Up on the first row and Down on the last only; a single row has both off", () => {
      mount();
      const off = (id: string): boolean =>
        q<HTMLButtonElement>(`forum-settings-tag-${id}`).disabled;
      expect([0, 1, 2].map((i) => [off(`up-${i}`), off(`down-${i}`), off(`remove-${i}`)])).toEqual([
        [true, false, false],
        [false, false, false],
        [false, true, false],
      ]);
      q("forum-settings-tag-remove-1").click();
      q("forum-settings-tag-remove-1").click();
      expect([off("up-0"), off("down-0"), off("remove-0")]).toEqual([true, true, false]);
    });

    it("names a blank or padded tag in its button labels", () => {
      mount();
      name(1, "   ");
      click("forum-settings-add");
      name(3, "  Docs  ");
      click("forum-settings-add");
      const label = (id: string): string | null => q(id).getAttribute("aria-label");
      expect(label("forum-settings-tag-up-1")).toBe("Move this tag up");
      expect(label("forum-settings-tag-remove-1")).toBe("Remove this tag");
      expect(label("forum-settings-tag-down-3")).toBe("Move Docs down");
      expect(label("forum-settings-tag-remove-3")).toBe("Remove Docs");
    });
  });

  describe("adding, removing and reordering", () => {
    it("adds an empty row, focuses its name, and updates the count", () => {
      const s = mount();
      click("forum-settings-add");
      expect(rows()).toHaveLength(4);
      expect(q<HTMLInputElement>("forum-settings-tag-name-3").value).toBe("");
      expect(document.activeElement).toBe(q("forum-settings-tag-name-3"));
      expect(count()).toBe("4/20 tags");
      expect(s.isDirty()).toBe(true);
    });

    it("stops at the tag limit: Add is disabled and a click adds nothing", () => {
      seedForum({}, { tags: numbered(20) });
      mount();
      const add = q<HTMLButtonElement>("forum-settings-add");
      expect([add.disabled, count()]).toEqual([true, "20/20 tags"]);
      add.disabled = false;
      add.click();
      expect(rows()).toHaveLength(20);
      click("forum-settings-tag-remove-0");
      expect([q<HTMLButtonElement>("forum-settings-add").disabled, count()]).toEqual([
        false,
        "19/20 tags",
      ]);
    });

    it("removes only the clicked row and focuses the first input, or Add when none is left", () => {
      const s = mount();
      click("forum-settings-tag-remove-1");
      expect(names()).toEqual(["Bug", "Question"]);
      expect(document.activeElement).toBe(q("forum-settings-tag-emoji-0"));
      expect(s.isDirty()).toBe(true);
      seedForum({}, { tags: ONE });
      s.destroy();
      container.replaceChildren();
      mount();
      click("forum-settings-tag-remove-0");
      expect(q("forum-settings-no-tags").textContent).toBe("No tags yet");
      expect(document.activeElement).toBe(q("forum-settings-add"));
    });

    it("moves rows by one and ignores a click on a disabled move button", () => {
      mount();
      click("forum-settings-tag-up-2");
      expect(names()).toEqual(["Bug", "Question", "Idea"]);
      click("forum-settings-tag-down-0");
      expect(names()).toEqual(["Question", "Bug", "Idea"]);
      for (const id of ["forum-settings-tag-up-0", "forum-settings-tag-down-2"]) {
        q(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      expect(names()).toEqual(["Question", "Bug", "Idea"]);
    });

    it.each([
      ["down-0", "down-1", "down-1"],
      ["up-2", "up-1", "up-1"],
      ["up-1", "up-0", "down-0"],
    ])(
      "clicking %s leaves focus on %s's button, or the other when disabled",
      (from, _to, focus) => {
        mount();
        const b = q<HTMLButtonElement>(`forum-settings-tag-${from}`);
        b.focus();
        b.click();
        expect(document.activeElement).toBe(q(`forum-settings-tag-${focus}`));
      },
    );
  });

  describe("editing", () => {
    it("tracks dirtiness, clears it when an edit is reverted, and counts the toggle and period", () => {
      const s = mount();
      const dirty: boolean[] = [s.isDirty()];
      for (const step of [
        () => name(0, "Defect"),
        () => name(0, "Bug"),
        () => type(q("forum-settings-tag-emoji-2"), "❓"),
        () => type(q("forum-settings-tag-emoji-2"), ""),
        () => click("forum-settings-require-tag"),
        () => click("forum-settings-require-tag"),
        () => period("1440"),
      ]) {
        step();
        dirty.push(s.isDirty());
      }
      expect(dirty).toEqual([false, true, false, true, false, true, false, true]);
    });

    it.each([
      ["a name", () => name(0, "Bug fix")],
      ["an emoji", () => type(q("forum-settings-tag-emoji-0"), "🔥")],
      ["the toggle", () => click("forum-settings-require-tag")],
      ["the period", () => period("60")],
      ["a removal", () => click("forum-settings-tag-remove-0")],
      ["an addition", () => click("forum-settings-add")],
      ["a move", () => click("forum-settings-tag-down-0")],
    ])("hides a shown note and a validation error once %s changes", async (_n, edit) => {
      mount();
      click("forum-settings-save");
      await noteShown();
      edit();
      expect([note().hidden, note().textContent]).toEqual([true, ""]);
      name(1, "  ");
      click("forum-settings-save");
      expect(error().hidden).toBe(false);
      edit();
      expect([error().hidden, error().textContent]).toEqual([true, ""]);
    });
  });

  describe("saving", () => {
    it("sends the whole settings, with the period as a number", async () => {
      const save = vi.fn<Save>(async () => {});
      mount(save);
      period("1440");
      click("forum-settings-save");
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(save.mock.calls[0]![0]).toEqual({
        tags: [
          { id: 1, name: "Bug", emoji: "🐛" },
          { id: 2, name: "Idea" },
          { id: 3, name: "Question" },
        ],
        require_tag: false,
        default_auto_archive_minutes: 1440,
      });
    });

    it("shows Saving while in flight, ignores a second click, then restores the button", async () => {
      let release: () => void = () => {};
      const save = vi.fn<Save>(() => new Promise<void>((resolve) => (release = resolve)));
      mount(save);
      const btn = q<HTMLButtonElement>("forum-settings-save");
      btn.click();
      expect([btn.disabled, btn.textContent]).toEqual([true, "Saving…"]);
      btn.disabled = false;
      btn.click();
      expect(save).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(btn.disabled).toBe(false));
      expect([btn.textContent, note().textContent, note().hidden, error().hidden]).toEqual([
        "Save forum settings",
        "Forum settings saved",
        false,
        true,
      ]);
    });

    it("shows the rejection's message or the generic one, re-enables Save, and hides it on retry", async () => {
      const save = vi
        .fn<Save>()
        .mockRejectedValueOnce("network down")
        .mockRejectedValueOnce(new Error("socket closed"))
        .mockRejectedValueOnce(new ApiClientError(400, "BAD_REQUEST", "tag name is used twice"))
        .mockImplementationOnce(pending);
      mount(save);
      const btn = q<HTMLButtonElement>("forum-settings-save");
      for (const want of ["Couldn't save the forum settings", "socket closed", "used twice"]) {
        btn.click();
        await vi.waitFor(() => expect(error().textContent).toContain(want));
        expect([btn.disabled, btn.textContent, note().hidden]).toEqual([
          false,
          "Save forum settings",
          true,
        ]);
      }
      btn.click();
      expect([error().hidden, error().textContent]).toEqual([true, ""]);
    });

    it("treats a change that arrives after a failed save as another admin's", async () => {
      mount(vi.fn<Save>().mockRejectedValueOnce(new Error("nope")));
      name(0, "Defect");
      click("forum-settings-save");
      await vi.waitFor(() => expect(error().hidden).toBe(false));
      live({ tags: [...TAGS, { id: 4, name: "News", position: 3 }] });
      await vi.waitFor(() => expect(rows()).toHaveLength(4));
      expect(note().textContent).toContain("Another admin");
      expect(val("forum-settings-tag-name-0")).toBe("Defect");
    });
  });

  describe("validation before saving", () => {
    it.each([
      ["a blank name", () => name(1, "  "), NAME_ERR, 1],
      ["a long name", () => name(2, "x".repeat(21)), NAME_ERR, 2],
      ["a repeated name", () => name(1, "BUG"), "Tag names must be different", 1],
      [
        "a bad emoji",
        () => type(q("forum-settings-tag-emoji-2"), "x".repeat(40)),
        "A tag's emoji must be a single emoji",
        2,
      ],
    ] as const)(
      "refuses %s, names the problem and focuses that row's name",
      async (_n, edit, text, i) => {
        const save = vi.fn<Save>(async () => {});
        mount(save);
        click("forum-settings-save");
        await noteShown();
        edit();
        document.body.focus();
        click("forum-settings-save");
        expect([error().hidden, error().textContent, note().hidden]).toEqual([false, text, true]);
        expect(document.activeElement).toBe(q(`forum-settings-tag-name-${i}`));
        expect(save).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ["requiring a tag on a forum with none", [], "Add a tag before requiring one on every post"],
      ["a forum over the tag limit", numbered(21), "A forum holds at most 20 tags"],
    ])("refuses %s without calling save, leaving Save usable and focus alone", (_n, tags, text) => {
      seedForum({}, { tags });
      const save = vi.fn<Save>(async () => {});
      mount(save);
      if (tags.length === 0) click("forum-settings-require-tag");
      chk().focus();
      click("forum-settings-save");
      const btn = q<HTMLButtonElement>("forum-settings-save");
      expect([error().textContent, btn.disabled, btn.textContent]).toEqual([
        text,
        false,
        "Save forum settings",
      ]);
      expect(document.activeElement).toBe(chk());
      expect(save).not.toHaveBeenCalled();
    });

    it.each([
      ["refused locally", "idea", async () => undefined],
      ["valid and in flight", "Defect", async () => pending()],
    ])("hides a foreign-change note once a save is %s", async (_n, edit, impl) => {
      const save = vi.fn<Save>(impl);
      mount(save);
      name(0, edit);
      live({ default_auto_archive_minutes: 60 });
      await noteShown();
      click("forum-settings-save");
      expect([note().hidden, note().textContent]).toEqual([true, ""]);
    });
  });

  describe("live changes", () => {
    it("follows the server while untouched, silently", async () => {
      const s = mount();
      live({
        tags: [{ id: 1, name: "Renamed", position: 0 }],
        require_tag: true,
        default_auto_archive_minutes: 60,
      });
      await vi.waitFor(() => expect(names()).toEqual(["Renamed"]));
      expect([chk().checked, sel().value, note().hidden, count(), s.isDirty()]).toEqual([
        true,
        "60",
        true,
        "1/20 tags",
        false,
      ]);
    });

    it("keeps a dirty draft through a write with the same settings, or a forum block that went away", async () => {
      const s = mount();
      name(0, "Defect");
      const before = q("forum-settings-tag-name-0");
      live({ tags: TAGS.map((t) => ({ ...t })) });
      await flush();
      expect(q("forum-settings-tag-name-0")).toBe(before);
      seedForum({ forum: undefined });
      await flush();
      removeChannel(FORUM);
      await flush();
      expect([names(), note().hidden, s.isDirty()]).toEqual([
        ["Defect", "Idea", "Question"],
        true,
        true,
      ]);
    });

    it("keeps an edit through a foreign change, shows the note, and measures dirt against the new base", async () => {
      const s = mount();
      click("forum-settings-require-tag");
      live({ default_auto_archive_minutes: 60 });
      await noteShown();
      expect(note().textContent).toBe(
        "Another admin changed these settings; their changes were merged in",
      );
      expect([chk().checked, sel().value, s.isDirty()]).toEqual([true, "60", true]);
      click("forum-settings-require-tag");
      expect(s.isDirty()).toBe(false);
    });

    it("adopts the echo of its own save, with the server's normalised copy, leaving the form clean", async () => {
      const save = vi.fn<Save>(async () => {});
      const s = mount(save);
      click("forum-settings-add");
      name(3, "  Docs  ");
      click("forum-settings-save");
      await vi.waitFor(() => expect(save).toHaveBeenCalled());
      await flush();
      live({ tags: [...TAGS, { id: 7, name: "Docs", position: 3 }] });
      await vi.waitFor(() => expect(val("forum-settings-tag-name-3")).toBe("Docs"));
      expect([s.isDirty(), note().textContent, rows().length]).toEqual([
        false,
        "Forum settings saved",
        4,
      ]);
    });

    it("treats a second change after the echo as another admin's", async () => {
      const save = vi.fn<Save>(async () => {});
      mount(save);
      click("forum-settings-require-tag");
      click("forum-settings-save");
      await vi.waitFor(() => expect(save).toHaveBeenCalled());
      live({ require_tag: true });
      await flush();
      name(0, "Defect");
      live({ require_tag: true, default_auto_archive_minutes: 60 });
      await vi.waitFor(() => expect(note().textContent).toContain("Another admin"));
    });

    it("keeps focus and caret in a tag field across a live re-render, and leaves outside focus alone", async () => {
      mount();
      const input = q<HTMLInputElement>("forum-settings-tag-name-1");
      input.focus();
      type(input, "Idea!");
      input.setSelectionRange(2, 2);
      live({ require_tag: true });
      await vi.waitFor(() => expect(chk().checked).toBe(true));
      const now = q<HTMLInputElement>("forum-settings-tag-name-1");
      expect(now).not.toBe(input);
      expect([document.activeElement, now.selectionStart, now.selectionEnd, now.value]).toEqual([
        now,
        2,
        2,
        "Idea!",
      ]);
      q("forum-settings-tag-emoji-0").focus();
      live({ require_tag: false });
      await vi.waitFor(() => expect(chk().checked).toBe(false));
      expect(document.activeElement).toBe(q("forum-settings-tag-emoji-0"));
      chk().focus();
      live({ default_auto_archive_minutes: 60 });
      await vi.waitFor(() => expect(sel().value).toBe("60"));
      expect(document.activeElement).toBe(chk());
    });

    it("drops focus when the focused tag is gone", async () => {
      mount();
      q("forum-settings-tag-name-2").focus();
      live({ tags: [TAGS[0]!, TAGS[1]!] });
      await vi.waitFor(() => expect(rows()).toHaveLength(2));
      expect(container.contains(document.activeElement)).toBe(false);
    });
  });

  describe("destroy", () => {
    it("stops reacting to input, clicks and store changes", async () => {
      const save = vi.fn<Save>(async () => {});
      const s = mount(save);
      s.destroy();
      name(0, "Defect");
      type(q("forum-settings-tag-emoji-1"), "💡");
      for (const id of ["require-tag", "save", "add", "tag-down-0", "tag-up-2", "tag-remove-2"]) {
        click(`forum-settings-${id}`);
      }
      period("60");
      expect(save).not.toHaveBeenCalled();
      expect([rows().length, s.isDirty()]).toEqual([3, false]);
      live({ tags: [TAGS[0]!] });
      await flush();
      expect(rows()).toHaveLength(3);
    });
  });
});
