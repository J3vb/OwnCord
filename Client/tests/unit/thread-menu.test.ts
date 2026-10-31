import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMessageList } from "@components/MessageList";

import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { resetThreadsStore } from "@stores/threads.store";
import {
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
  seedMessages as seed,
} from "../helpers/message-actions-fixtures";
import { resetMembersState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";

describe("Create Thread in the message menu", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList>;
  const onCreate = vi.fn();

  async function openMenu(): Promise<HTMLElement[]> {
    const text = container.querySelector<HTMLElement>('[data-testid="message-1"] .msg-text')!;
    text.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    await vi.waitFor(() => expect(document.querySelector(".message-context-menu")).not.toBeNull());
    return [...document.querySelectorAll<HTMLElement>(".message-context-menu [role='menuitem']")];
  }

  beforeEach(() => {
    resetGateStores();
    signInAs("member");
    setChannel();
    resetMembersState();
    applyReadyCapabilities({ threads: true });
    onCreate.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    list?.destroy?.();
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    resetServerCapabilities();
    resetThreadsStore();
    resetGateStores();
  });

  function mount(over = {}): void {
    seed([makeMessage({ user: { id: OTHER, username: "alice", avatar: null } })]);
    list = createMessageList(
      makeOpts({ channelType: "text", onCreateThreadClick: onCreate, ...over }),
    );
    list.mount(container);
  }

  it("offers the item and calls back with the message id", async () => {
    mount();
    const item = (await openMenu()).find((el) => el.dataset["testid"] === "msg-menu-create-thread");
    expect(item?.textContent).toBe("Create Thread");
    item!.click();
    expect(onCreate).toHaveBeenCalledWith(1);
  });

  it("does not offer it on a server without threads", async () => {
    applyReadyCapabilities({});
    mount();
    const items = await openMenu();
    expect(items.some((el) => el.dataset["testid"] === "msg-menu-create-thread")).toBe(false);
  });
});
