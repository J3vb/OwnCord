/**
 * The channel right-click menu's rows and their order, per channel kind and
 * per what the role and the page allow: pins which entries each gate shows and
 * where the separators fall.
 */
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "@stores/channels.store";
import { makeChannel } from "../../helpers/channelFactory";
import { contextMenuAt4, openChannelMenu, useChannelMenuHost } from "../../helpers/channelMenuHost";
import { attachChannelContextMenu } from "../../../src/features/channels/sidebar/contextMenu";
import { setDeveloperMode } from "../../helpers/message-actions-fixtures";

const FULL = { manageChannels: true, manageMessages: true, manageInvites: true };
const NONE = { manageChannels: false, manageMessages: false, manageInvites: false };

let container: HTMLDivElement;
let ac: AbortController;
useChannelMenuHost((c, a) => {
  container = c;
  ac = a;
  localStorage.clear();
});

type Handlers = Partial<{
  edit: boolean;
  delete: boolean;
  purge: boolean;
  reorder: boolean;
  invite: boolean;
}>;

/** The popover's top-level rows in order: a row's test id, or "|" for a separator. */
function menuRows(
  ch: Channel,
  access: typeof FULL | undefined,
  h: Handlers = {},
): (string | null)[] {
  const el = document.createElement("div");
  container.appendChild(el);
  attachChannelContextMenu(
    el,
    ch,
    ac.signal,
    ac.signal,
    h.edit ? vi.fn() : undefined,
    h.delete ? vi.fn() : undefined,
    h.purge ? () => Promise.resolve() : undefined,
    h.reorder ? [ch] : undefined,
    h.reorder ? vi.fn() : undefined,
    h.invite ? vi.fn() : undefined,
    access,
  );
  contextMenuAt4(el);
  const menu = document.querySelector('[data-testid="channel-context-menu"]')!;
  const rows = [...menu.children].map((child) =>
    child.classList.contains("context-menu-sep") ? "|" : child.getAttribute("data-testid"),
  );
  menu.remove();
  return rows.filter((r) => r !== null);
}

const EVERYTHING: Handlers = { edit: true, delete: true, purge: true, reorder: true, invite: true };

describe("channel menu rows", () => {
  it("lists a text channel's rows in order, with a separator before each management group", () => {
    expect(menuRows(makeChannel({ id: 7 }), FULL, EVERYTHING)).toEqual([
      "ctx-mark-read",
      "ctx-mute-channel",
      "ctx-notify-settings",
      "ctx-copy-channel-link",
      "ctx-invite-people",
      "ctx-move-up",
      "ctx-move-down",
      "|",
      "ctx-edit-channel",
      "|",
      "ctx-delete-channel",
      "|",
      "ctx-purge-messages",
      "purge-form",
    ]);
  });

  it("gives a voice channel Open Chat but no read state, mute, link or purge", () => {
    expect(menuRows(makeChannel({ id: 7, type: "voice" }), FULL, EVERYTHING)).toEqual([
      "ctx-open-chat",
      "ctx-invite-people",
      "ctx-move-up",
      "ctx-move-down",
      "|",
      "ctx-edit-channel",
      "|",
      "ctx-delete-channel",
    ]);
  });

  it("gives a forum a mute and a link but no read state", () => {
    expect(menuRows(makeChannel({ id: 7, type: "forum" }), NONE)).toEqual([
      "ctx-mute-channel",
      "ctx-notify-settings",
      "ctx-copy-channel-link",
    ]);
  });

  it("gives a member only the rows that touch their own state", () => {
    expect(menuRows(makeChannel({ id: 7 }), NONE, EVERYTHING)).toEqual([
      "ctx-mark-read",
      "ctx-mute-channel",
      "ctx-notify-settings",
      "ctx-copy-channel-link",
    ]);
  });

  it("follows the role's bits independently: invites, messages and channels", () => {
    const ch = makeChannel({ id: 7 });
    expect(menuRows(ch, { ...NONE, manageInvites: true }, EVERYTHING)).toContain(
      "ctx-invite-people",
    );
    const purgeOnly = menuRows(ch, { ...NONE, manageMessages: true }, EVERYTHING);
    expect(purgeOnly.slice(-3)).toEqual(["|", "ctx-purge-messages", "purge-form"]);
    expect(purgeOnly).not.toContain("ctx-edit-channel");
    const manageOnly = menuRows(ch, { ...NONE, manageChannels: true }, EVERYTHING);
    expect(manageOnly).toContain("ctx-move-up");
    expect(manageOnly).not.toContain("ctx-purge-messages");
  });

  it("drops a row whose callback the page did not wire", () => {
    const ch = makeChannel({ id: 7 });
    expect(menuRows(ch, FULL, { delete: true })).toEqual([
      "ctx-mark-read",
      "ctx-mute-channel",
      "ctx-notify-settings",
      "ctx-copy-channel-link",
      "|",
      "ctx-delete-channel",
    ]);
    // Move needs both the group and the reorder callback; here neither.
    expect(menuRows(ch, FULL, { edit: true })).not.toContain("ctx-move-up");
  });

  it("adds Copy Channel ID after Move in developer mode, and only then", () => {
    const ch = makeChannel({ id: 7 });
    expect(menuRows(ch, FULL, { reorder: true })).not.toContain("ctx-copy-channel-id");
    setDeveloperMode(true);
    try {
      const rows = menuRows(ch, FULL, { reorder: true });
      expect(rows.slice(-3)).toEqual(["ctx-move-up", "ctx-move-down", "ctx-copy-channel-id"]);
    } finally {
      setDeveloperMode(false);
    }
  });

  it("opens a menu on a plain voice row with nothing wired", () => {
    const el = openChannelMenu(container, makeChannel({ id: 7, type: "voice" }), ac.signal);
    expect(el).toBeInstanceOf(HTMLElement);
    expect(document.querySelector('[data-testid="ctx-open-chat"]')).not.toBeNull();
  });
});
