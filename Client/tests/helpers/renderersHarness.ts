import { expect, vi, beforeEach, afterEach } from "vitest";
import { setServerHost } from "../../src/components/message-list/renderers";
import type { Message } from "../../src/stores/messages.store";
import { membersStore } from "../../src/stores/members.store";
import { channelsStore, setRoles } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { setConnectionStatus } from "../../src/stores/ui.store";
import type { MessageListOptions } from "../../src/components/MessageList";
import {
  clearExternalImageCache,
  closeActiveLightbox,
} from "../../src/features/messaging/content/attachments";
import { previewMock, imageMock } from "./renderersMocks";
import { resetMembersState } from "./storeResets";

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
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
  }));
  setConnectionStatus("connected");
}

/** Seed a moderator role (MANAGE_MESSAGES) so permission-gated actions render. */
export function seedMessageManager(): void {
  setRoles([{ id: 2, name: "moderator", color: null, permissions: 0x10000 }]);
  authStore.setState(() => ({
    token: "tok",
    user: { id: 999, username: "Mod", avatar: null, role: "moderator" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
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
