import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { createUserBar } from "@components/UserBar";
import { voiceStore, resetVoiceStore, joinVoiceChannel } from "@stores/voice.store";
import { channelsStore, setChannels, updateChannel } from "@stores/channels.store";
import { cascadedDeclaration, keyword, varToken } from "../helpers/app-css";
import { signInAs } from "../helpers/storeSeeds";

const connection = vi.hoisted(() => ({ status: "connected" }));

vi.mock("@stores/ui.store", () => ({
  openSettings: vi.fn(),
  uiStore: {
    getState: () => ({ connectionStatus: connection.status }),
    subscribe: () => () => {},
    subscribeSelector: () => () => {},
  },
}));

// WP 1D-1: the mic and headphone buttons moved from the voice widget to the
// user panel, next to Settings, and work in a call or not.
describe("UserBar mute and deafen", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createUserBar>;
  let onMuteToggle: ReturnType<typeof vi.fn<() => void>>;
  let onDeafenToggle: ReturnType<typeof vi.fn<() => void>>;

  function mount(): { mute: HTMLButtonElement; deafen: HTMLButtonElement } {
    comp = createUserBar({ onMuteToggle, onDeafenToggle });
    comp.mount(container);
    return {
      mute: container.querySelector<HTMLButtonElement>('[data-testid="ub-mute"]')!,
      deafen: container.querySelector<HTMLButtonElement>('[data-testid="ub-deafen"]')!,
    };
  }

  function setVoice(patch: Partial<ReturnType<typeof voiceStore.getState>>): void {
    voiceStore.setState((prev) => ({ ...prev, ...patch }));
    voiceStore.flush();
  }

  const icon = (btn: HTMLButtonElement): string | null =>
    btn.querySelector("svg")!.getAttribute("data-icon");

  useMountContainer(
    (c) => {
      container = c;
    },
    () => comp?.destroy?.(),
  );

  beforeEach(() => {
    resetVoiceStore();
    signInAs(
      { id: 1, username: "alice", avatar: null, role: "member" },
      { serverName: "TestServer" },
    );
    connection.status = "connected";
    onMuteToggle = vi.fn<() => void>();
    onDeafenToggle = vi.fn<() => void>();
  });

  it("puts the mic and headphone buttons before Settings", () => {
    mount();

    const labels = [...container.querySelectorAll(".ub-controls button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels.slice(0, 3)).toEqual(["Mute", "Deafen", "Settings"]);
  });

  it("shows no voice buttons when the page gives no toggles", () => {
    comp = createUserBar();
    comp.mount(container);

    expect(container.querySelector('[data-testid="ub-mute"]')).toBeNull();
    expect(container.querySelector('[data-testid="ub-deafen"]')).toBeNull();
  });

  it("runs the toggles outside a call", () => {
    const { mute, deafen } = mount();

    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(mute.disabled).toBe(false);
    expect(deafen.disabled).toBe(false);
    mute.click();
    deafen.click();

    expect(onMuteToggle).toHaveBeenCalledOnce();
    expect(onDeafenToggle).toHaveBeenCalledOnce();
  });

  it("paints mute and deafen from the store, in a call or not", () => {
    const { mute, deafen } = mount();
    expect(mute.classList.contains("active-ctrl")).toBe(false);
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(icon(mute)).toBe("mic");
    expect(mute.title).toBe("Mute");

    setVoice({ localMuted: true });
    expect(mute.classList.contains("active-ctrl")).toBe(true);
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(icon(mute)).toBe("mic-off");
    expect(mute.title).toBe("Unmute");

    setVoice({ localDeafened: true });
    expect(deafen.classList.contains("active-ctrl")).toBe(true);
    expect(deafen.getAttribute("aria-pressed")).toBe("true");
    expect(icon(deafen)).toBe("headphones-off");
    expect(deafen.title).toBe("Undeafen");

    joinVoiceChannel(4);
    voiceStore.flush();
    expect(mute.classList.contains("active-ctrl")).toBe(true);
    expect(deafen.classList.contains("active-ctrl")).toBe(true);
  });

  // Moved from the voice widget: PTT never writes localMuted, so an idle gate
  // is pttGated && !localMuted and gets its own affordance.
  it("reads an idle PTT gate as not muted, with its own affordance", () => {
    joinVoiceChannel(4);
    setVoice({ localMuted: false, pttGated: true });
    const { mute } = mount();

    expect(mute.classList.contains("active-ctrl")).toBe(false);
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(mute.classList.contains("ptt-gated")).toBe(true);
    expect(mute.title).toBe("Push-to-talk — hold your key to talk");

    // The user's own mute wins over the idle gate.
    setVoice({ localMuted: true });
    expect(mute.classList.contains("active-ctrl")).toBe(true);
    expect(mute.classList.contains("ptt-gated")).toBe(false);

    // Outside a call there is no gate to show.
    setVoice({ localMuted: false });
    expect(mute.classList.contains("ptt-gated")).toBe(true);
    setVoice({ currentChannelId: null });
    expect(mute.classList.contains("ptt-gated")).toBe(false);
  });

  it("does not paint the mic button as unmuted while joined listen-only", () => {
    joinVoiceChannel(4);
    setVoice({ listenOnly: true, localMuted: false });
    const { mute } = mount();

    expect(mute.disabled).toBe(true);
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(icon(mute)).toBe("mic-off");
    expect(mute.classList.contains("ub-listen-only")).toBe(true);
    expect(mute.classList.contains("active-ctrl")).toBe(false);
    expect(mute.title).toBe("Listening only — no microphone access");
    // jsdom applies no stylesheet: the class must carry a disabled look and
    // cancel the hover highlight in the parsed app.css.
    expect(
      keyword(cascadedDeclaration(".user-bar .ub-controls button.ub-listen-only", "opacity")),
    ).toBe("0.5");
    expect(
      varToken(
        cascadedDeclaration(".user-bar .ub-controls button.ub-listen-only:hover", "background"),
      ),
    ).toBe("--bg-active");

    // A granted microphone clears it.
    setVoice({ listenOnly: false });
    expect(mute.disabled).toBe(false);
    expect(mute.classList.contains("ub-listen-only")).toBe(false);
    expect(icon(mute)).toBe("mic");
  });

  it("disables the buttons under a moderator's mute or deafen, and re-enables them when lifted", () => {
    joinVoiceChannel(4);
    const { mute, deafen } = mount();

    setVoice({ localServerMuted: true, localServerDeafened: true });
    expect(mute.disabled).toBe(true);
    expect(mute.title).toBe("You were muted by a moderator");
    expect(deafen.disabled).toBe(true);
    expect(deafen.title).toBe("You were deafened by a moderator");

    setVoice({ localServerMuted: false, localServerDeafened: false });
    expect(mute.disabled).toBe(false);
    expect(mute.title).toBe("Mute");
    expect(deafen.disabled).toBe(false);
    expect(deafen.title).toBe("Deafen");
  });

  // Moved from the voice widget: mute and deafen apply locally, so a dropped
  // chat socket does not freeze them (the reconnect restates the state).
  it("keeps mute and deafen usable while the WS socket is down", () => {
    connection.status = "reconnecting";
    joinVoiceChannel(4);
    const { mute, deafen } = mount();

    expect(mute.disabled).toBe(false);
    expect(mute.title).toBe("Mute");
    expect(deafen.disabled).toBe(false);
    mute.click();
    deafen.click();
    expect(onMuteToggle).toHaveBeenCalledOnce();
    expect(onDeafenToggle).toHaveBeenCalledOnce();

    // A moderator's mute still holds while the socket is down.
    setVoice({ localServerMuted: true });
    expect(mute.disabled).toBe(true);
  });

  describe("in the AFK channel", () => {
    const channel = (id: number, afk: boolean) => ({
      id,
      name: `room-${id}`,
      type: "voice" as const,
      category: "Voice",
      position: id,
      afk,
    });

    beforeEach(() => {
      setChannels([channel(4, false), channel(9, true)]);
    });

    afterEach(() => {
      setChannels([]);
      channelsStore.flush();
    });

    it("locks the mic muted with a tooltip that says why", () => {
      const { mute } = mount();
      joinVoiceChannel(9);
      voiceStore.flush();

      expect(voiceStore.getState().inAfkChannel).toBe(true);
      expect(mute.disabled).toBe(true);
      expect(mute.title).toBe("You can't speak in the AFK channel");
      expect(icon(mute)).toBe("mic-off");
      expect(mute.getAttribute("aria-pressed")).toBe("true");
      // Deafening is still the user's own.
      expect(
        container.querySelector<HTMLButtonElement>('[data-testid="ub-deafen"]')!.disabled,
      ).toBe(false);
    });

    it("unlocks on leaving for an ordinary channel", () => {
      const { mute } = mount();
      joinVoiceChannel(9);
      voiceStore.flush();
      joinVoiceChannel(4);
      voiceStore.flush();

      expect(voiceStore.getState().inAfkChannel).toBe(false);
      expect(mute.disabled).toBe(false);
      expect(mute.title).toBe("Mute");
    });

    it("follows the flag when an admin sets it while the user is inside", () => {
      const { mute } = mount();
      joinVoiceChannel(4);
      voiceStore.flush();
      expect(mute.disabled).toBe(false);

      updateChannel({ id: 4, afk: true });
      channelsStore.flush();
      voiceStore.flush();

      expect(mute.disabled).toBe(true);
    });
  });

  it("stops following the store once destroyed", () => {
    const { mute } = mount();
    comp.destroy?.();

    setVoice({ localMuted: true });

    expect(mute.classList.contains("active-ctrl")).toBe(false);
  });
});
