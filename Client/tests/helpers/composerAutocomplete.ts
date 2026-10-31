import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { createMessageInput } from "../../src/components/MessageInput";
import type { MessageInputOptions } from "../../src/components/MessageInput";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, setRoles } from "../../src/stores/channels.store";
import { resetChannelsState } from "./storeSeeds";

export interface MountedComposer {
  container: HTMLDivElement;
  input: ReturnType<typeof createMessageInput>;
  onSend: Mock<MessageInputOptions["onSend"]>;
}

/** Mounts a fresh composer for each test and destroys it afterwards; `bind` receives it. */
export function useComposer(bind: (composer: MountedComposer) => void): void {
  let current: MountedComposer;

  beforeEach(() => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onSend = vi.fn<MessageInputOptions["onSend"]>();
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend,
      onTyping: vi.fn(),
    });
    input.mount(container);
    current = { container, input, onSend };
    bind(current);
  });

  afterEach(() => {
    current.input.destroy?.();
    current.container.remove();
  });
}

export function composerTextarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector("textarea")!;
}

/** Sets the draft with the caret at its end and fires the input event. */
export function typeInto(container: HTMLElement, value: string): void {
  const ta = composerTextarea(container);
  ta.value = value;
  ta.selectionStart = value.length;
  ta.selectionEnd = value.length;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Presses `key` in the composer; returns whether a handler called preventDefault. */
export function pressIn(container: HTMLElement, key: string): boolean {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  composerTextarea(container).dispatchEvent(ev);
  return ev.defaultPrevented;
}

/** Seeds the member list with `names`, ids 1..n. */
export function seedMembers(names: readonly string[]): void {
  membersStore.setState(() => ({
    members: new Map(
      names.map((n, i) => [
        i + 1,
        {
          id: i + 1,
          username: n,
          avatar: null,
          role: "member" as const,
          status: "online" as const,
        },
      ]),
    ),
    typingUsers: new Map(),
  }));
}

/** Sign in as a role, and register that role's permission mask. */
export function signInAs(role: string, permissions: number): void {
  authStore.setState(() => ({
    token: "t",
    user: { id: 99, username: "me", avatar: null, role },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  resetChannelsState();
  setRoles([{ id: 1, name: role, color: null, permissions }]);
  channelsStore.flush();
}
