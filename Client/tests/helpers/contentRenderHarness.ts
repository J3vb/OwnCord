import { afterEach, beforeEach } from "vitest";
import { membersStore } from "../../src/stores/members.store";
import { setChannels } from "../../src/stores/channels.store";
import type { ReadyChannel } from "../../src/lib/types";
import { signInAs, resetChannelsState } from "./storeSeeds";

const CHANNELS: ReadyChannel[] = [
  { id: 1, name: "general", type: "text", category: null, position: 0 },
];

/** One known member (alice, id 10), the signed-in user (id 12) and a #general channel. */
export function seedContentStores(): void {
  membersStore.setState(() => ({
    members: new Map([
      [10, { id: 10, username: "alice", avatar: null, role: "member", status: "online" as const }],
    ]),
    typingUsers: new Map(),
  }));
  signInAs(
    { id: 12, username: "me", avatar: null, role: "member" },
    { token: "t", serverName: null },
  );
  resetChannelsState();
  setChannels(CHANNELS);
}

/** Seeds the stores and gives each test a fresh <div> on document.body; `bind` receives it when the suite needs it. */
export function useContentContainer(bind: (container: HTMLDivElement) => void = () => {}): void {
  let container: HTMLDivElement;

  beforeEach(() => {
    seedContentStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    bind(container);
  });

  afterEach(() => {
    container.remove();
  });
}
