import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhoneCallBar, type PhoneCallBar } from "../../src/components/PhoneCallBar";
import {
  channelsStore,
  resetChannelsStore,
  setActiveChannel,
  setChannels,
} from "../../src/stores/channels.store";
import { dmStore, setDmChannels, type DmChannel } from "../../src/stores/dm.store";
import {
  joinVoiceChannel,
  leaveVoiceChannel,
  resetVoiceStore,
  setListenOnly,
  setLocalMuted,
  setVoiceStatus,
  updateVoiceState,
  voiceStore,
} from "../../src/stores/voice.store";
import { membersStore, resetMembersStore } from "../../src/stores/members.store";

const VOICE = 10;
const DM = 20;

function dm(): DmChannel {
  return {
    channelId: DM,
    recipient: { id: 7, username: "bob", avatar: "", status: "online" },
    participants: [{ id: 7, username: "bob", avatar: "", status: "online" }],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

function addPerson(channelId: number, userId: number, username: string): void {
  updateVoiceState({
    channel_id: channelId,
    user_id: userId,
    username,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
  });
}

function flush(): void {
  voiceStore.flush();
  channelsStore.flush();
  dmStore.flush();
  membersStore.flush();
}

function usePhone(on: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: on && q.includes("pointer: coarse") })),
  );
}

describe("PhoneCallBar", () => {
  let host: HTMLDivElement;
  let bar: PhoneCallBar | null = null;
  let gridUp = false;
  const onMuteToggle = vi.fn<() => void>();
  const onLeave = vi.fn<() => void>();
  const onOpenCall = vi.fn<(channelId: number) => void>();

  const root = (): HTMLElement =>
    host.querySelector<HTMLElement>('[data-testid="phone-call-bar"]')!;
  const q = (id: string): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  const detail = (): string => q("pcb-detail").textContent ?? "";

  function mountBar(): PhoneCallBar {
    bar = createPhoneCallBar({ isGridUp: () => gridUp, onMuteToggle, onLeave, onOpenCall });
    bar.mount(host);
    return bar;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    usePhone(true);
    gridUp = false;
    onMuteToggle.mockClear();
    onLeave.mockClear();
    onOpenCall.mockClear();
    resetVoiceStore();
    resetChannelsStore();
    resetMembersStore();
    setDmChannels([]);
    setChannels([{ id: VOICE, name: "Voice Chat", type: "voice", category: null, position: 0 }]);
    flush();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    bar?.destroy?.();
    bar = null;
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function joinCall(channelId = VOICE): void {
    joinVoiceChannel(channelId);
    setVoiceStatus("connected");
    flush();
  }

  describe("when it shows", () => {
    it("is a labelled region and stays hidden outside a call", () => {
      mountBar();
      expect(root().getAttribute("role")).toBe("region");
      expect(root().getAttribute("aria-label")).toBe("Voice call");
      expect(root().hidden).toBe(true);
    });

    it("shows on a phone in a call with the call view down", () => {
      mountBar();
      joinCall();
      expect(root().hidden).toBe(false);
    });

    it("stays hidden off a phone", () => {
      usePhone(false);
      mountBar();
      joinCall();
      expect(root().hidden).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("follows the window across the phone breakpoint", () => {
      usePhone(false);
      mountBar();
      joinCall();
      expect(root().hidden).toBe(true);
      usePhone(true);
      window.dispatchEvent(new Event("resize"));
      expect(root().hidden).toBe(false);
      usePhone(false);
      window.dispatchEvent(new Event("resize"));
      expect(root().hidden).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("steps aside while the call view is up and returns when it closes", () => {
      const b = mountBar();
      joinCall();
      gridUp = true;
      b.refresh();
      expect(root().hidden).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      gridUp = false;
      b.refresh();
      expect(root().hidden).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    });
  });

  describe("while you look at your own DM call", () => {
    it("steps aside, since the DM's call panel has its own controls", () => {
      setDmChannels([dm()]);
      mountBar();
      joinCall(DM);
      expect(root().hidden).toBe(false);

      setActiveChannel(DM);
      flush();
      expect(root().hidden).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("returns when you open another channel, and steps aside again on coming back", () => {
      setDmChannels([dm()]);
      mountBar();
      joinCall(DM);
      setActiveChannel(DM);
      flush();
      expect(root().hidden).toBe(true);

      setActiveChannel(VOICE);
      flush();
      expect(root().hidden).toBe(false);
      expect(vi.getTimerCount()).toBe(1);

      setActiveChannel(DM);
      flush();
      expect(root().hidden).toBe(true);
    });

    it("shows when the DM you are looking at is not the call you are in", () => {
      setDmChannels([dm(), { ...dm(), channelId: 30 }]);
      mountBar();
      joinCall(DM);
      setActiveChannel(30);
      flush();
      expect(root().hidden).toBe(false);
    });

    it("stays up in a guild voice channel's own chat, which has no call panel", () => {
      mountBar();
      joinCall();
      setActiveChannel(VOICE);
      flush();
      expect(root().hidden).toBe(false);
    });

    it("comes back when you leave the call", () => {
      setDmChannels([dm()]);
      mountBar();
      joinCall(DM);
      setActiveChannel(DM);
      flush();
      leaveVoiceChannel();
      flush();
      expect(root().hidden).toBe(true);
      joinCall(VOICE);
      expect(root().hidden).toBe(false);
    });
  });

  describe("what it says", () => {
    it("names the channel and counts the people with the time in the call", () => {
      mountBar();
      addPerson(VOICE, 1, "alice");
      addPerson(VOICE, 2, "bob");
      joinCall();
      expect(q("pcb-name").textContent).toBe("Voice Chat");
      expect(detail()).toBe("2 people · 00:00");
      expect(q("pcb-open").getAttribute("aria-label")).toBe("Open call in Voice Chat");
    });

    it("counts you when your own state has not arrived", () => {
      mountBar();
      joinCall();
      expect(detail()).toBe("1 person · 00:00");
    });

    it("shows at most three avatars", () => {
      mountBar();
      for (const [i, name] of ["alice", "bob", "carol", "dave"].entries()) {
        addPerson(VOICE, i + 1, name);
      }
      joinCall();
      expect(host.querySelectorAll(".pcb-avatar").length).toBe(3);
      expect(detail()).toBe("4 people · 00:00");
    });

    it("names a DM call after the DM", () => {
      setDmChannels([dm()]);
      mountBar();
      joinCall(DM);
      expect(q("pcb-name").textContent).toBe("bob");
      expect(q("pcb-open").disabled).toBe(false);
    });

    it("shows the connection status instead of the time while connecting or reconnecting", () => {
      mountBar();
      joinVoiceChannel(VOICE);
      setVoiceStatus("joining");
      flush();
      expect(detail()).toBe("Connecting…");
      setVoiceStatus("connected");
      flush();
      expect(detail()).toMatch(/ · 00:00$/);
      setVoiceStatus("reconnecting");
      flush();
      expect(detail()).toBe("Reconnecting voice…");
      expect(root().hidden).toBe(false);
    });

    it("cannot open a call whose channel is not known yet", () => {
      mountBar();
      joinCall(99);
      expect(q("pcb-name").textContent).toBe("Voice Channel");
      expect(q("pcb-open").disabled).toBe(true);
    });
  });

  describe("the timer", () => {
    it("ticks once a second while the bar shows", () => {
      mountBar();
      joinCall();
      vi.advanceTimersByTime(5000);
      expect(detail()).toBe("1 person · 00:05");
      vi.advanceTimersByTime(60_000);
      expect(detail()).toBe("1 person · 01:05");
      expect(vi.getTimerCount()).toBe(1);
    });

    it("stops and hides when the call ends from elsewhere", () => {
      mountBar();
      joinCall();
      expect(vi.getTimerCount()).toBe(1);
      // Left on another device, or kicked: the store drops the call.
      leaveVoiceChannel();
      flush();
      expect(root().hidden).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops when the bar is destroyed", () => {
      mountBar();
      joinCall();
      bar?.destroy?.();
      expect(vi.getTimerCount()).toBe(0);
      expect(host.querySelector('[data-testid="phone-call-bar"]')).toBeNull();
      // A store change after teardown does nothing and throws nothing.
      leaveVoiceChannel();
      flush();
    });

    it("starts over for a new call", () => {
      mountBar();
      joinCall();
      vi.advanceTimersByTime(30_000);
      leaveVoiceChannel();
      flush();
      joinCall();
      expect(detail()).toBe("1 person · 00:00");
    });
  });

  describe("the buttons", () => {
    it("Leave calls the leave callback", () => {
      mountBar();
      joinCall();
      q("pcb-leave").click();
      expect(onLeave).toHaveBeenCalledOnce();
      expect(q("pcb-leave").getAttribute("aria-label")).toBe("Leave call");
    });

    it("Mute calls the mute callback and shows the mute state", () => {
      mountBar();
      joinCall();
      const mute = q("pcb-mute");
      expect(mute.getAttribute("aria-pressed")).toBe("false");
      expect(mute.getAttribute("aria-label")).toBe("Mute");
      mute.click();
      expect(onMuteToggle).toHaveBeenCalledOnce();

      setLocalMuted(true);
      flush();
      expect(mute.getAttribute("aria-pressed")).toBe("true");
      expect(mute.getAttribute("aria-label")).toBe("Unmute");
    });

    it("cannot be pressed when a moderator muted you or there is no microphone", () => {
      mountBar();
      joinCall();
      voiceStore.setState((prev) => ({ ...prev, localServerMuted: true }));
      flush();
      expect(q("pcb-mute").disabled).toBe(true);
      expect(q("pcb-mute").getAttribute("aria-label")).toBe("You were muted by a moderator");

      voiceStore.setState((prev) => ({ ...prev, localServerMuted: false }));
      setListenOnly(true);
      flush();
      expect(q("pcb-mute").disabled).toBe(true);
      expect(q("pcb-mute").getAttribute("aria-label")).toBe(
        "Listening only — no microphone access",
      );
    });

    it("the rest of the bar opens the call in its channel", () => {
      mountBar();
      joinCall();
      q("pcb-open").click();
      expect(onOpenCall).toHaveBeenCalledExactlyOnceWith(VOICE);
    });

    it("opens a DM call by the DM's channel id", () => {
      setDmChannels([dm()]);
      mountBar();
      joinCall(DM);
      q("pcb-open").click();
      expect(onOpenCall).toHaveBeenCalledExactlyOnceWith(DM);
    });
  });
});
