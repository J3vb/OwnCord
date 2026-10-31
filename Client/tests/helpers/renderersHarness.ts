import { expect, vi, beforeEach, afterEach } from "vitest";
import { renderMessage, setServerHost } from "../../src/components/message-list/renderers";
import type { Message } from "../../src/stores/messages.store";
import { membersStore } from "../../src/stores/members.store";
import { channelsStore, setRoles } from "../../src/stores/channels.store";
import { setConnectionStatus } from "../../src/stores/ui.store";
import type { MessageListOptions } from "../../src/components/MessageList";
import {
  clearExternalImageCache,
  closeActiveLightbox,
} from "../../src/features/messaging/content/attachments";
import { previewMock, imageMock } from "./renderersMocks";
import { resetMembersState } from "./storeResets";
import { resetAuthState, signInAs } from "./storeSeeds";

export let blobCounter = 0;

export const createObjectURLMock = vi.fn(() => `blob:test/${++blobCounter}`);

/** Wait until `count` inline images carry a broker blob: src, and return them. */
export async function brokerImages(count: number): Promise<HTMLImageElement[]> {
  let imgs: HTMLImageElement[] = [];
  await vi.waitFor(() => {
    imgs = [...document.querySelectorAll<HTMLImageElement>('.msg-image img[src^="blob:"]')];
    expect(imgs.length).toBe(count);
  });
  return imgs;
}

export function resetStores(): void {
  resetMembersState();
  channelsStore.setState((prev) => ({ ...prev, roles: [] }));
  resetAuthState();
  setConnectionStatus("connected");
}

/** Seed a moderator role (MANAGE_MESSAGES) so permission-gated actions render. */
export function seedMessageManager(): void {
  setRoles([{ id: 2, name: "moderator", color: null, permissions: 0x10000 }]);
  signInAs({ id: 999, username: "Mod", avatar: null, role: "moderator" }, { serverName: null });
}

/** Seed the member list so @tokens resolve — unresolvable tokens stay plain text. */
export function seedMentionMembers(): void {
  membersStore.setState((prev) => ({
    ...prev,
    members: new Map([
      [10, { id: 10, username: "alice", avatar: null, role: "member", status: "online" as const }],
      [11, { id: 11, username: "bob", avatar: null, role: "member", status: "online" as const }],
    ]),
  }));
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    channelId: 1,
    user: { id: 10, username: "Alice", avatar: null },
    content: "Hello world",
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2025-01-15T12:30:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
    ...overrides,
  };
}

export function makeOpts(overrides: Partial<MessageListOptions> = {}): MessageListOptions {
  return {
    channelId: 1,
    channelName: "general",
    currentUserId: 10,
    onScrollTop: vi.fn(),
    onReplyClick: vi.fn(),
    onEditClick: vi.fn(),
    onEditSave: vi.fn(() => true),
    onEmptyEdit: vi.fn(),
    onDeleteClick: vi.fn(),
    onReactionClick: vi.fn(),
    onPinClick: vi.fn(),
    ...overrides,
  };
}

/** Registers the shared beforeEach/afterEach for every renderers test file; `bind` receives each fresh container. */
export function useRenderersHarness(bind: (el: HTMLDivElement) => void): void {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    // jsdom sets window.location.origin to "null", which breaks new URL(relativeUrl, origin).
    // Set a server host so resolveServerUrl converts relative paths to absolute URLs before isSafeUrl parses them.
    setServerHost("localhost:8080");
    URL.createObjectURL = createObjectURLMock;
    URL.revokeObjectURL = vi.fn();
    imageMock.mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/png" }) });
    previewMock.mockResolvedValue({
      ok: true,
      value: { title: null, description: null, siteName: null, image: null },
    });
    clearExternalImageCache();
    imageMock.mockClear();
    previewMock.mockClear();
    createObjectURLMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    bind(container);
  });

  afterEach(() => {
    // Close a lightbox a test left open, releasing its document listeners.
    closeActiveLightbox();
    setServerHost("");
    container.remove();
  });
}

/** Renders `msg` as the only message in `container`; the caller aborts `ac` when done. */
export function mountMessage(
  container: HTMLElement,
  msg: Message,
  opts: MessageListOptions = makeOpts(),
): { el: HTMLElement; ac: AbortController } {
  const ac = new AbortController();
  const el = renderMessage(msg, false, [msg], opts, ac.signal);
  container.appendChild(el);
  return { el, ac };
}

/** Seed a member with no permissions, so permission-gated actions stay hidden. */
export function seedPlainMember(): void {
  setRoles([{ id: 3, name: "member", color: null, permissions: 0 }]);
  signInAs({ id: 999, username: "Nobody", avatar: null, role: "member" }, { serverName: null });
}

/** Renders Alice's message for viewer 999, who is not its author. */
export function mountAsOtherViewer(
  container: HTMLElement,
  optsOverrides: Partial<MessageListOptions> = {},
): { el: HTMLElement; ac: AbortController } {
  const opts = makeOpts({ currentUserId: 999, ...optsOverrides });
  const msg = makeMessage({ user: { id: 10, username: "Alice", avatar: null } });
  return mountMessage(container, msg, opts);
}

/** Sets the role-colors preference and notifies listeners the way savePref does. */
export function setRoleColorsPref(value: "true" | "false"): void {
  localStorage.setItem("owncord:settings:roleColors", value);
  window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "roleColors" } }));
}

/** Renders a message with `content` as the only message in `container`. */
export function mountContent(
  container: HTMLElement,
  content: string,
): { el: HTMLElement; ac: AbortController } {
  return mountMessage(container, makeMessage({ content }));
}
