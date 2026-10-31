import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEditChannelModal } from "@components/EditChannelModal";
import { ApiClientError } from "@lib/api";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { Permission, type ForumSettings, type ForumSettingsBody } from "@lib/types";
import { setRoles, updateChannel } from "@stores/channels.store";
import {
  draftFromForum,
  mergeRemote,
  sentNewTags,
  toBody,
  validateDraft,
} from "../../src/features/forums/forumSettingsModel";
import { FORUM, seedForum } from "../helpers/forum-fixtures";
import { signInAs } from "../helpers/storeSeeds";

const MEMBER = Permission.READ_MESSAGES | Permission.SEND_MESSAGES;

function signInWith(permissions: number): void {
  setRoles([{ id: 9, name: "Curator", color: null, permissions }]);
  signInAs({ id: 1, username: "A", avatar: null, role: "Curator" }, { serverName: "T" });
}

const FORUM_STATE: ForumSettings = {
  tags: [
    { id: 1, name: "Bug", emoji: "🐛", position: 0 },
    { id: 2, name: "Idea", position: 1 },
    { id: 3, name: "Question", position: 2 },
  ],
  require_tag: false,
  default_auto_archive_minutes: 4320,
};

describe("forum settings model", () => {
  it("keeps tag ids and list order in the body, and omits the id of a new tag", () => {
    const d = draftFromForum(FORUM_STATE);
    const renamed = {
      ...d,
      tags: [
        ...d.tags.map((t) => (t.id === 2 ? { ...t, name: "Suggestion", emoji: "💡" } : t)),
        { id: 0, key: 99, name: "  Docs ", emoji: "" },
      ],
    };
    expect(toBody(renamed)).toEqual({
      tags: [
        { id: 1, name: "Bug", emoji: "🐛" },
        { id: 2, name: "Suggestion", emoji: "💡" },
        { id: 3, name: "Question" },
        { name: "Docs" },
      ],
      require_tag: false,
      default_auto_archive_minutes: 4320,
    });
  });

  it("states the server's limits before the round trip", () => {
    const d = draftFromForum(FORUM_STATE);
    const tag = (name: string, emoji = "") => ({ id: 0, key: 50, name, emoji });
    expect(validateDraft(d)).toBeNull();
    expect(validateDraft({ ...d, tags: [tag("  ")] })?.kind).toBe("name");
    expect(validateDraft({ ...d, tags: [tag("x".repeat(21))] })?.kind).toBe("name");
    expect(validateDraft({ ...d, tags: [tag("x".repeat(20))] })).toBeNull();
    expect(validateDraft({ ...d, tags: [tag("Bug"), tag("bug")] })?.kind).toBe("duplicate");
    expect(validateDraft({ ...d, tags: [tag("a", "x".repeat(35))] })?.kind).toBe("emoji");
    expect(validateDraft({ ...d, tags: [tag("a", "\u0007")] })?.kind).toBe("emoji");
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: 0,
      key: i,
      name: `t${i}`,
      emoji: "",
    }));
    expect(validateDraft({ ...d, tags: many })?.kind).toBe("count");
  });

  it("merges a tag another admin added and drops one they removed, keeping local edits", () => {
    const base = draftFromForum(FORUM_STATE);
    const draft = {
      ...base,
      requireTag: true,
      tags: base.tags.map((t) => (t.id === 1 ? { ...t, name: "Defect" } : t)),
    };
    const next = draftFromForum({
      ...FORUM_STATE,
      default_auto_archive_minutes: 60,
      tags: [FORUM_STATE.tags[0]!, FORUM_STATE.tags[1]!, { id: 4, name: "News", position: 2 }],
    });
    const merged = mergeRemote(draft, base, next);
    expect(merged.tags.map((t) => [t.id, t.name])).toEqual([
      [1, "Defect"],
      [2, "Idea"],
      [4, "News"],
    ]);
    expect(merged.requireTag).toBe(true);
    expect(merged.autoArchive).toBe(60);
  });
});

describe("mergeRemote keeps another admin's edits to tags this admin left alone", () => {
  const base = draftFromForum(FORUM_STATE);
  const server = (tags: { id: number; name: string; emoji?: string }[]) =>
    draftFromForum({ ...FORUM_STATE, tags: tags.map((t, position) => ({ ...t, position })) });

  it("takes the server's rename and emoji for an untouched tag, and keeps the admin's own edit", () => {
    const draft = {
      ...base,
      tags: base.tags.map((t) => (t.id === 3 ? { ...t, name: "Help" } : t)),
    };
    const next = server([
      { id: 1, name: "Defect", emoji: "🪲" },
      { id: 2, name: "Idea" },
      { id: 3, name: "Q&A" },
    ]);
    const merged = mergeRemote(draft, base, next);
    expect(merged.tags.map((t) => [t.id, t.name, t.emoji])).toEqual([
      [1, "Defect", "🪲"],
      [2, "Idea", ""],
      [3, "Help", ""],
    ]);
  });

  it("adopts the server's order when the admin did not reorder, unsaved rows stay last", () => {
    const draft = { ...base, tags: [...base.tags, { id: 0, key: 77, name: "Docs", emoji: "" }] };
    const next = server([
      { id: 3, name: "Question" },
      { id: 1, name: "Bug", emoji: "🐛" },
      { id: 2, name: "Idea" },
    ]);
    expect(mergeRemote(draft, base, next).tags.map((t) => t.name)).toEqual([
      "Question",
      "Bug",
      "Idea",
      "Docs",
    ]);
  });

  it("keeps the admin's order when the admin reordered", () => {
    const draft = { ...base, tags: [base.tags[2]!, base.tags[0]!, base.tags[1]!] };
    const next = server([
      { id: 2, name: "Idea" },
      { id: 1, name: "Bug", emoji: "🐛" },
      { id: 3, name: "Question" },
    ]);
    expect(mergeRemote(draft, base, next).tags.map((t) => t.id)).toEqual([3, 1, 2]);
  });

  it("gives an echoed new tag to the row that was sent, even if it was renamed since", () => {
    const sentDraft = {
      ...base,
      tags: [...base.tags, { id: 0, key: 88, name: "Docs", emoji: "" }],
    };
    const draft = {
      ...sentDraft,
      tags: sentDraft.tags.map((t) => (t.key === 88 ? { ...t, name: "Guides" } : t)),
    };
    const next = server([...FORUM_STATE.tags, { id: 7, name: "Docs" }]);
    const merged = mergeRemote(draft, base, next, sentNewTags(sentDraft));
    expect(merged.tags.map((t) => [t.id, t.name])).toEqual([
      [1, "Bug"],
      [2, "Idea"],
      [3, "Question"],
      [7, "Guides"],
    ]);
  });
});

describe("Forum settings section in Edit Channel", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    seedForum({}, { tags: FORUM_STATE.tags, default_auto_archive_minutes: 4320 });
    applyReadyCapabilities({ forums: true });
    signInWith(Permission.MANAGE_CHANNELS | MEMBER);
  });
  afterEach(() => {
    container.remove();
    resetServerCapabilities();
    document.body.replaceChildren();
  });

  const q = <T extends HTMLElement>(id: string): T =>
    container.querySelector<T>(`[data-testid='${id}']`) as T;

  async function open(
    save: (b: ForumSettingsBody) => Promise<void> = vi.fn(async () => {}),
    withSave = true,
    type = "forum",
  ) {
    const modal = createEditChannelModal({
      channelId: FORUM,
      channelName: "feedback",
      channelType: type,
      ...(withSave ? { onSaveForum: save } : {}),
      onSave: vi.fn(async () => {}),
      onClose: vi.fn(),
    });
    modal.mount(container);
    // The section is a lazy chunk.
    await new Promise((r) => setTimeout(r, 0));
    return modal;
  }
  const type = (el: HTMLInputElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("shows the tags, the toggle and the default auto-archive", async () => {
    const modal = await open();
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    expect(q<HTMLInputElement>("forum-settings-tag-name-1").value).toBe("Idea");
    expect(q<HTMLInputElement>("forum-settings-tag-emoji-0").value).toBe("🐛");
    expect(q<HTMLInputElement>("forum-settings-require-tag").checked).toBe(false);
    expect(q<HTMLSelectElement>("forum-settings-archive").value).toBe("4320");
    expect(
      Array.from(q<HTMLSelectElement>("forum-settings-archive").options).map((o) => o.value),
    ).toEqual(["60", "1440", "4320", "10080"]);
    modal.destroy?.();
  });

  it("keeps the id on a rename, drops a removed tag and sends the toggle", async () => {
    const save = vi.fn(async (_b: ForumSettingsBody) => {});
    const modal = await open(save);
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    type(q("forum-settings-tag-name-1"), "Suggestion");
    q("forum-settings-tag-remove-2").click();
    q<HTMLInputElement>("forum-settings-require-tag").click();
    const archive = q<HTMLSelectElement>("forum-settings-archive");
    archive.value = "60";
    archive.dispatchEvent(new Event("change", { bubbles: true }));
    q("forum-settings-add").click();
    type(q("forum-settings-tag-name-2"), "Docs");
    q("forum-settings-save").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({
      tags: [{ id: 1, name: "Bug", emoji: "🐛" }, { id: 2, name: "Suggestion" }, { name: "Docs" }],
      require_tag: true,
      default_auto_archive_minutes: 60,
    });
    await vi.waitFor(() => expect(q("forum-settings-note").textContent).toContain("saved"));
    modal.destroy?.();
  });

  it("reorders tags with the move buttons", async () => {
    const save = vi.fn(async (_b: ForumSettingsBody) => {});
    const modal = await open(save);
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    q("forum-settings-tag-down-0").click();
    q("forum-settings-save").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].tags.map((t) => t.id)).toEqual([2, 1, 3]);
    modal.destroy?.();
  });

  it("refuses an invalid tag locally without calling the server", async () => {
    const save = vi.fn(async (_b: ForumSettingsBody) => {});
    const modal = await open(save);
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    type(q("forum-settings-tag-name-1"), "bug");
    q("forum-settings-save").click();
    expect(q("forum-settings-error").textContent).toBe("Tag names must be different");
    expect(save).not.toHaveBeenCalled();
    modal.destroy?.();
  });

  it("shows the server's refusal and lets the admin retry", async () => {
    const save = vi
      .fn<(b: ForumSettingsBody) => Promise<void>>()
      .mockRejectedValueOnce(
        new ApiClientError(400, "BAD_REQUEST", 'tag name "Idea" is used twice'),
      )
      .mockResolvedValueOnce(undefined);
    const modal = await open(save);
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    q<HTMLInputElement>("forum-settings-require-tag").click();
    q("forum-settings-save").click();
    await vi.waitFor(() => expect(q("forum-settings-error").hidden).toBe(false));
    expect(q("forum-settings-error").textContent).toContain("used twice");
    expect(q<HTMLButtonElement>("forum-settings-save").disabled).toBe(false);
    q("forum-settings-save").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(q("forum-settings-error").hidden).toBe(true));
    modal.destroy?.();
  });

  it("merges a live channel_update into an edited draft instead of overwriting it", async () => {
    const save = vi.fn(async (_b: ForumSettingsBody) => {});
    const modal = await open(save);
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    type(q("forum-settings-tag-name-0"), "Defect");
    // Another admin adds a tag while this form is open.
    updateChannel({
      id: FORUM,
      forum: { ...FORUM_STATE, tags: [...FORUM_STATE.tags, { id: 4, name: "News", position: 3 }] },
    });
    await vi.waitFor(() => expect(q("forum-settings-tag-name-3")).not.toBeNull());
    expect(q<HTMLInputElement>("forum-settings-tag-name-0").value).toBe("Defect");
    expect(q("forum-settings-note").textContent).toContain("Another admin");
    q("forum-settings-save").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].tags.map((t) => [t.id, t.name])).toEqual([
      [1, "Defect"],
      [2, "Idea"],
      [3, "Question"],
      [4, "News"],
    ]);
    modal.destroy?.();
  });

  it("follows the store while untouched and adopts the ids of its own save", async () => {
    const save = vi.fn(async (_b: ForumSettingsBody) => {});
    const modal = await open(save);
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    updateChannel({ id: FORUM, forum: { ...FORUM_STATE, require_tag: true } });
    await vi.waitFor(() =>
      expect(q<HTMLInputElement>("forum-settings-require-tag").checked).toBe(true),
    );
    q("forum-settings-add").click();
    type(q("forum-settings-tag-name-3"), "Docs");
    q("forum-settings-save").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    // The broadcast beat the HTTP answer: the new tag arrives with its id, once.
    updateChannel({
      id: FORUM,
      forum: {
        ...FORUM_STATE,
        require_tag: true,
        tags: [...FORUM_STATE.tags, { id: 7, name: "Docs", position: 3 }],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelectorAll(".forum-tag-row")).toHaveLength(4);
    expect(q("forum-settings-note").textContent).not.toContain("Another admin");
    // The next save names the tag by the id the server gave it, not as a new one.
    q("forum-settings-save").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0].tags.at(-1)).toEqual({ id: 7, name: "Docs" });
    modal.destroy?.();
  });

  it("a new tag renamed before its echo arrives is not duplicated", async () => {
    const save = vi.fn(async (_b: ForumSettingsBody) => {});
    const modal = await open(save);
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    q("forum-settings-add").click();
    type(q("forum-settings-tag-name-3"), "Docs");
    q("forum-settings-save").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    type(q("forum-settings-tag-name-3"), "Guides");
    updateChannel({
      id: FORUM,
      forum: { ...FORUM_STATE, tags: [...FORUM_STATE.tags, { id: 7, name: "Docs", position: 3 }] },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelectorAll(".forum-tag-row")).toHaveLength(4);
    expect(q<HTMLInputElement>("forum-settings-tag-name-3").value).toBe("Guides");
    q("forum-settings-save").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0].tags.at(-1)).toEqual({ id: 7, name: "Guides" });
    modal.destroy?.();
  });

  it("keeps focus on the other move button when the moved one is now disabled", async () => {
    const modal = await open();
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    expect(q("forum-settings-tags").getAttribute("aria-labelledby")).not.toBeNull();
    const move = q<HTMLButtonElement>("forum-settings-tag-down-1");
    move.focus();
    move.click();
    // Now last: Down is disabled, so Up holds focus.
    expect(q<HTMLButtonElement>("forum-settings-tag-down-2").disabled).toBe(true);
    expect(document.activeElement).toBe(q("forum-settings-tag-up-2"));
    modal.destroy?.();
  });

  it("does not drop unsaved forum edits on Save or close without saying so", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async () => {});
    const modal = createEditChannelModal({
      channelId: FORUM,
      channelName: "feedback",
      channelType: "forum",
      onSaveForum: vi.fn(async () => {}),
      onSave,
      onClose,
    });
    modal.mount(container);
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(q("forum-settings")).not.toBeNull());
    q<HTMLInputElement>("forum-settings-require-tag").click();
    q("edit-channel-submit").click();
    expect(onClose).not.toHaveBeenCalled();
    expect(q("edit-channel-error").textContent).toContain("unsaved changes");
    // Editing again re-arms the warning; closing twice without editing discards.
    type(q("forum-settings-tag-name-0"), "Defect");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    modal.destroy?.();
  });

  it.each([
    ["without the forums capability", () => applyReadyCapabilities({}), true, "forum"],
    ["without MANAGE_CHANNELS", () => signInWith(MEMBER), true, "forum"],
    ["without a save route", () => {}, false, "forum"],
    ["on a text channel", () => {}, true, "text"],
  ])("is hidden %s", async (_n, arrange, withSave, type) => {
    arrange();
    const modal = await open(
      vi.fn(async () => {}),
      withSave,
      type,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(q("forum-settings")).toBeNull();
    modal.destroy?.();
  });
});
