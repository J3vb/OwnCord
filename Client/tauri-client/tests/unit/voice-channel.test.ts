import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createVoiceChannel } from "../../src/components/VoiceChannel";
import { voiceStore } from "../../src/stores/voice.store";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import type { VoiceUser } from "../../src/stores/voice.store";

function resetStores(): void {
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
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

function addMember(id: number, username: string): void {
  membersStore.setState((prev) => {
    const members = new Map(prev.members);
    members.set(id, {
      id,
      username,
      avatar: null,
      role: "member",
      status: "online",
    });
    return { ...prev, members };
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
    // Clean up context menus attached to body
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
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

  // ── Deafened user icon ──

  it("shows headphones-off icon for deafened users", () => {
    setVoiceUsers(1, [
      {
        userId: 10,
        username: "Alice",
        muted: false,
        deafened: true,
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

    // Deafened shows .vu-muted (headphones-off icon)
    const mutedIcon = result.element.querySelector(".vu-muted");
    expect(mutedIcon).not.toBeNull();

    result.destroy();
  });

  // ── Camera icon ──

  it("shows camera icon for user with active camera", () => {
    setVoiceUsers(1, [
      {
        userId: 10,
        username: "Alice",
        muted: false,
        deafened: false,
        speaking: false,
        camera: true,
        screenshare: false,
      },
    ]);

    const result = createVoiceChannel({
      channelId: 1,
      channelName: "Voice Lobby",
      onJoin: vi.fn(),
    });
    container.appendChild(result.element);

    const statusIcon = result.element.querySelector(".vu-status");
    expect(statusIcon).not.toBeNull();

    result.destroy();
  });

  // ── User avatar initial and color ──

  it("renders first-letter avatar with deterministic background color", () => {
    addMember(10, "Zara");
    setVoiceUsers(1, [
      {
        userId: 10,
        username: "Zara",
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

    const avatar = result.element.querySelector(".vu-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toBe("Z");
    expect((avatar as HTMLElement).style.background).not.toBe("");

    result.destroy();
  });

  it("shows '?' avatar for user with empty username", () => {
    addMember(11, "");
    setVoiceUsers(1, [
      {
        userId: 11,
        username: "",
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

    const avatar = result.element.querySelector(".vu-avatar");
    expect(avatar!.textContent).toBe("?");

    result.destroy();
  });

  // ── "Unknown" username fallback ──

  it("shows 'Unknown' for user not in members store", () => {
    // User 99 has no entry in members store
    setVoiceUsers(1, [
      {
        userId: 99,
        username: "",
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

    const name = result.element.querySelector(".vu-name");
    expect(name?.textContent).toBe("Unknown");

    result.destroy();
  });

  // ── Multiple users rendered ──

  it("renders multiple voice users under the same channel", () => {
    addMember(10, "Alice");
    addMember(20, "Bob");

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
      {
        userId: 20,
        username: "Bob",
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

    const userItems = result.element.querySelectorAll(".voice-user-item");
    expect(userItems.length).toBe(2);

    const names = Array.from(userItems).map(
      (el) => el.querySelector(".vu-name")?.textContent,
    );
    expect(names).toContain("Alice");
    expect(names).toContain("Bob");

    result.destroy();
  });

  // ── Update skips redundant re-render ──

  it("update() skips re-render when voice users map reference is unchanged", () => {
    addMember(10, "Alice");
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

    // Capture original DOM node reference
    const originalRow = result.element.querySelector(".voice-user-item");
    expect(originalRow).not.toBeNull();

    // Call update again with same store state (no change)
    result.update();

    // The same DOM node should still be there (not destroyed and recreated)
    const currentRow = result.element.querySelector(".voice-user-item");
    expect(currentRow).toBe(originalRow);

    result.destroy();
  });

  // ── Store subscription triggers update ──

  it("re-renders when voice store changes after initial render", () => {
    const result = createVoiceChannel({
      channelId: 1,
      channelName: "Voice Lobby",
      onJoin: vi.fn(),
    });
    container.appendChild(result.element);

    // Initially no users
    expect(result.element.querySelectorAll(".voice-user-item").length).toBe(0);

    // Add a user to the store
    addMember(30, "Charlie");
    setVoiceUsers(1, [
      {
        userId: 30,
        username: "Charlie",
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    ]);
    voiceStore.flush();

    // Should now show the user
    expect(result.element.querySelectorAll(".voice-user-item").length).toBe(1);
    expect(result.element.querySelector(".vu-name")?.textContent).toBe("Charlie");

    result.destroy();
  });

  // ── Channel becomes inactive when users leave ──

  it("removes active class when all users leave", () => {
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

    // Remove all users
    voiceStore.setState((prev) => {
      const voiceUsers = new Map(prev.voiceUsers);
      voiceUsers.delete(1);
      return { ...prev, voiceUsers };
    });
    voiceStore.flush();

    expect(channelItem!.classList.contains("active")).toBe(false);

    result.destroy();
  });

  // ── Right-click volume context menu ──

  it("right-click on other user row opens volume context menu on document body", () => {
    // Set current user different from voice user
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Me", avatar: null, role: "member" },
      serverName: null,
      motd: null,
      isAuthenticated: true,
    }));

    addMember(10, "Alice");
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

    const userRow = result.element.querySelector(".voice-user-item") as HTMLElement;
    userRow.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 200,
      clientY: 300,
    }));

    // Menu should be appended to document.body
    const menu = document.body.querySelector(".context-menu");
    expect(menu).not.toBeNull();

    // Should show the username
    expect(menu!.textContent).toContain("Alice");

    // Should have a volume slider
    const slider = menu!.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).not.toBeNull();
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("200");

    // Should have Reset Volume button
    expect(menu!.textContent).toContain("Reset Volume");

    result.destroy();
  });

  it("does not show volume context menu when right-clicking own user row", () => {
    // Set current user to same ID as voice user
    authStore.setState(() => ({
      token: "tok",
      user: { id: 10, username: "Alice", avatar: null, role: "member" },
      serverName: null,
      motd: null,
      isAuthenticated: true,
    }));

    addMember(10, "Alice");
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

    const userRow = result.element.querySelector(".voice-user-item") as HTMLElement;
    userRow.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 200,
      clientY: 300,
    }));

    // No context menu should appear
    const menu = document.body.querySelector(".context-menu");
    expect(menu).toBeNull();

    result.destroy();
  });

  // ── Destroy cleanup ──

  it("destroy cleans up context menu if one is open", () => {
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Me", avatar: null, role: "member" },
      serverName: null,
      motd: null,
      isAuthenticated: true,
    }));

    addMember(10, "Alice");
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

    // Open context menu
    const userRow = result.element.querySelector(".voice-user-item") as HTMLElement;
    userRow.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 200,
      clientY: 300,
    }));

    expect(document.body.querySelector(".context-menu")).not.toBeNull();

    // Destroy should clean up the menu
    result.destroy();

    expect(document.body.querySelector(".context-menu")).toBeNull();
  });

  // ── Members store update triggers re-render ──

  it("re-renders when members store updates (username change)", () => {
    addMember(10, "OldName");
    setVoiceUsers(1, [
      {
        userId: 10,
        username: "OldName",
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

    expect(result.element.querySelector(".vu-name")?.textContent).toBe("OldName");

    // Update member name in store
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, {
        id: 10,
        username: "NewName",
        avatar: null,
        role: "member",
        status: "online",
      });
      return { ...prev, members };
    });
    membersStore.flush();

    expect(result.element.querySelector(".vu-name")?.textContent).toBe("NewName");

    result.destroy();
  });

  // ── User both muted and deafened ──

  it("shows deafened icon when user is both muted and deafened", () => {
    setVoiceUsers(1, [
      {
        userId: 10,
        username: "Alice",
        muted: true,
        deafened: true,
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

    // When deafened, the component shows headphones-off (deafened takes precedence in the conditional)
    const mutedIcon = result.element.querySelector(".vu-muted");
    expect(mutedIcon).not.toBeNull();

    result.destroy();
  });
});
