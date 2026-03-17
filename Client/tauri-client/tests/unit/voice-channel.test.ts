import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createVoiceChannel } from "../../src/components/VoiceChannel";
import { voiceStore } from "../../src/stores/voice.store";
import { membersStore } from "../../src/stores/members.store";
import type { VoiceUser } from "../../src/stores/voice.store";

function resetStores(): void {
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

function setVoiceUsers(channelId: number, users: VoiceUser[]): void {
  const userMap = new Map<number, VoiceUser>();
  for (const u of users) {
    userMap.set(u.userId, u);
  }
  voiceStore.setState((prev) => {
    const voiceUsers = new Map(prev.voiceUsers);
    voiceUsers.set(channelId, userMap);
    return { ...prev, voiceUsers };
  });
}

describe("VoiceChannel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders channel name and voice icon", () => {
    const result = createVoiceChannel({
      channelId: 1,
      channelName: "Voice Lobby",
      onJoin: vi.fn(),
    });
    container.appendChild(result.element);

    const name = result.element.querySelector(".ch-name");
    expect(name?.textContent).toBe("Voice Lobby");

    const icon = result.element.querySelector(".ch-icon");
    expect(icon).not.toBeNull();

    result.destroy();
  });

  it("calls onJoin when channel item is clicked", () => {
    const onJoin = vi.fn();
    const result = createVoiceChannel({
      channelId: 1,
      channelName: "Voice Lobby",
      onJoin,
    });
    container.appendChild(result.element);

    const channelItem = result.element.querySelector(".channel-item") as HTMLElement;
    channelItem.click();
    expect(onJoin).toHaveBeenCalledOnce();

    result.destroy();
  });

  it("renders voice users from store", () => {
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, {
        id: 10,
        username: "Alice",
        avatar: null,
        role: "member",
        status: "online",
      });
      return { ...prev, members };
    });

    setVoiceUsers(1, [
      {
        userId: 10,
        username: "Alice",
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    ]);

    const result = createVoiceChannel({
      channelId: 1,
      channelName: "Voice Lobby",
      onJoin: vi.fn(),
    });
    container.appendChild(result.element);

    const userItems = result.element.querySelectorAll(".voice-user-item");
    expect(userItems.length).toBe(1);

    const userName = result.element.querySelector(".vu-name");
    expect(userName?.textContent).toBe("Alice");

    result.destroy();
  });

  it("marks channel active when users are present", () => {
    setVoiceUsers(1, [
      {
        userId: 10,
        username: "Alice",
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    ]);

    const result = createVoiceChannel({
      channelId: 1,
      channelName: "Voice Lobby",
      onJoin: vi.fn(),
    });
    container.appendChild(result.element);

    const channelItem = result.element.querySelector(".channel-item");
    expect(channelItem!.classList.contains("active")).toBe(true);

    result.destroy();
  });

  it("shows muted icon for muted users", () => {
    setVoiceUsers(1, [
      {
        userId: 10,
        username: "Alice",
        muted: true,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    ]);

    const result = createVoiceChannel({
      channelId: 1,
      channelName: "Voice Lobby",
      onJoin: vi.fn(),
    });
    container.appendChild(result.element);

    const mutedIcon = result.element.querySelector(".vu-muted");
    expect(mutedIcon).not.toBeNull();

    result.destroy();
  });

  it("shows speaking class for speaking users", () => {
    setVoiceUsers(1, [
      {
        userId: 10,
        username: "Alice",
        muted: false,
        deafened: false,
        speaking: true,
        camera: false,
        screenshare: false,
      },
    ]);

    const result = createVoiceChannel({
      channelId: 1,
      channelName: "Voice Lobby",
      onJoin: vi.fn(),
    });
    container.appendChild(result.element);

    const userItem = result.element.querySelector(".voice-user-item");
    expect(userItem!.classList.contains("speaking")).toBe(true);

    result.destroy();
  });

  it("shows no users when channel is empty", () => {
    const result = createVoiceChannel({
      channelId: 1,
      channelName: "Voice Lobby",
      onJoin: vi.fn(),
    });
    container.appendChild(result.element);

    const userItems = result.element.querySelectorAll(".voice-user-item");
    expect(userItems.length).toBe(0);

    const channelItem = result.element.querySelector(".channel-item");
    expect(channelItem!.classList.contains("active")).toBe(false);

    result.destroy();
  });
});
