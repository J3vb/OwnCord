import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/mainPageMocks";
import { channelsStore } from "../../../src/stores/channels.store";
import { uiStore } from "../../../src/stores/ui.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { dmStore } from "../../../src/stores/dm.store";
import { membersStore } from "../../../src/stores/members.store";
import { openImageLightbox } from "../../../src/features/messaging/content/media";
import { saveUserStatus } from "../../../src/lib/presence/userStatus";
import {
  startRingChime,
  startRingback,
  stopRingback,
} from "../../../src/lib/media/notificationSound";
import {
  alertIncomingCall,
  alertMissedCall,
} from "../../../src/features/direct-messages/callAlerts";
import {
  FakeWsClient,
  finishCallJoin,
  fakeWs,
  useWiredMainPage,
  mountPage,
  voiceUser,
  connectedDm,
  mountSettled,
  startCall,
  callPanelEl,
  incomingCall,
  callDeclined,
  roster,
  leaveVoice,
  incomingBannerEl,
} from "../../helpers/mainPageHarness";
import { withFakeTimers } from "../../helpers/withFakeTimers";

vi.mock("../../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentExternalMock(importOriginal),
);
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/media/notificationSound", () => mocks.mediaNotificationSoundMock());
vi.mock("../../../src/features/direct-messages/callAlerts", () => mocks.messagesCallAlertsMock());
vi.mock("@components/UpdateNotifier", () => mocks.updateNotifierMock());
vi.mock("@lib/voice/audioElements", () => mocks.voiceAudioElementsMock());
vi.mock("@lib/presence/autoIdle", () => mocks.presenceAutoIdleMock());
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/pages/main-page/ChannelController", () => mocks.pageChannelControllerMock());
vi.mock("../../../src/pages/main-page/SidebarArea", () => mocks.pageSidebarAreaMock());
vi.mock("../../../src/features/navigation/destinations", () => mocks.navigationDestinationsMock());
vi.mock("../../../src/pages/main-page/ChatArea", () => mocks.pageChatAreaMock());

const { mockSetAudioVolumeHost, mockCreateChatArea } = mocks;

function makeGroupWithDan(status: "online" | "offline"): void {
  dmStore.setState((prev) => ({
    channels: prev.channels.map((c) => ({
      ...c,
      isGroup: true,
      participants: [...c.participants, { id: 12, username: "dan", avatar: "", status }],
    })),
  }));
}

describe("MainPage — video grid, DM profile panel, calls, settings", () => {
  const m = useWiredMainPage();

  it("tells the caller when the callee declines, and Ring again rings once more", async () => {
    const ws = fakeWs();
    connectedDm(50);
    m.page = await mountSettled(m.container, ws);

    startCall();
    finishCallJoin();
    const panel = callPanelEl();
    expect(panel.dataset.state).toBe("outgoing");

    callDeclined(ws);
    expect(panel.dataset.state).toBe("unanswered");
    // The panel is the caller's feedback while the DM is open: no toast too.
    expect(m.container.querySelector('[data-testid="toast"]')).toBeNull();

    vi.mocked(ws.send).mockClear();
    // Past the server's 3s ring window plus slack, so the redial goes out at once.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4000);
    (panel.querySelector('[data-testid="dcp-ring-again"]') as HTMLElement).click();
    now.mockRestore();
    expect(ws.send).toHaveBeenCalledWith({ type: "call_ring", payload: { channel_id: 50 } });
    expect(panel.dataset.state).toBe("outgoing");

    // The call timer is the page's to stop.
    m.page.destroy?.();
  });

  it("a group call is declined once every online callee declined; offline members are not waited on", async () => {
    const ws = fakeWs();
    connectedDm(50);
    makeGroupWithDan("offline");
    m.page = await mountSettled(m.container, ws);

    startCall();
    finishCallJoin();
    const panel = callPanelEl();
    expect(panel.dataset.state).toBe("outgoing");

    callDeclined(ws);
    expect(panel.dataset.state).toBe("unanswered");
    m.page.destroy?.();
  });

  it("Ring again in a connected group call with a member missing re-rings the group without a Calling… state (3B-8)", async () => {
    const ws = fakeWs();
    connectedDm(50);
    makeGroupWithDan("online");
    m.page = await mountSettled(m.container, ws);

    // Alice and bob are in the room; dan is not.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceStatus: "connected" as const,
      voiceUsers: new Map([
        [
          50,
          new Map(
            [
              [1, "alice"],
              [10, "bob"],
            ].map(([userId, username]) => [
              userId as number,
              voiceUser(userId as number, { username: username as string }),
            ]),
          ),
        ],
      ]),
    }));
    voiceStore.flush();
    const panel = callPanelEl();
    expect(panel.dataset.state).toBe("connected");
    const again = panel.querySelector('[data-testid="dcp-ring-again"]') as HTMLElement;
    expect(again).not.toBeNull();

    vi.mocked(ws.send).mockClear();
    again.click();
    expect(ws.send).toHaveBeenCalledWith({ type: "call_ring", payload: { channel_id: 50 } });
    // Bob is in the call: no ringing state is started over a live call.
    expect(panel.dataset.state).toBe("connected");
    m.page.destroy?.();
  });

  it("calling an offline 1:1 contact says so at once instead of ringing back for 30 s", async () => {
    const ws = fakeWs();
    connectedDm(50);
    dmStore.setState((prev) => ({
      channels: prev.channels.map((c) => ({
        ...c,
        recipient: { ...c.recipient, status: "offline" },
        participants: c.participants.map((p) => ({ ...p, status: "offline" })),
      })),
    }));
    m.page = await mountSettled(m.container, ws);
    vi.mocked(startRingback).mockClear();

    startCall();
    finishCallJoin();
    const panel = callPanelEl();
    expect(panel.dataset.state).toBe("unanswered");
    expect(panel.querySelector('[data-testid="dcp-caption"]')!.textContent).toBe("bob is offline");
    expect(startRingback).not.toHaveBeenCalled();
    // Still rung: an invisible contact is shown offline but can still answer.
    expect(ws.send).toHaveBeenCalledWith({ type: "call_ring", payload: { channel_id: 50 } });
    m.page.destroy?.();
  });

  describe("ringing the callee", () => {
    const rings = (ws: FakeWsClient): unknown[] =>
      vi.mocked(ws.send).mock.calls.filter(([m]) => (m as { type: string }).type === "call_ring");

    function ringTwiceWithinWindow(): void {
      const start = mockCreateChatArea.mock.calls[0]![0].onStartCall;
      start();
      finishCallJoin();
      vi.advanceTimersByTime(1000);
      start();
    }

    async function mountCaller(): Promise<{ ws: FakeWsClient; panel: HTMLElement }> {
      const ws = fakeWs();
      connectedDm(50);
      m.page = await mountSettled(m.container, ws);
      return { ws, panel: callPanelEl() };
    }

    it("rings only once the caller's join has left joining, and keeps the join", async () => {
      const { ws } = await mountCaller();
      startCall();
      expect(voiceStore.getState().voiceStatus).toBe("joining");
      expect(rings(ws)).toHaveLength(0);

      finishCallJoin();
      expect(rings(ws)).toHaveLength(1);
      expect(voiceStore.getState().currentChannelId).toBe(50);
      m.page.destroy?.();
    });

    it("does not ring while the join is still securing or connecting", async () => {
      const { ws } = await mountCaller();
      startCall();
      voiceStore.setState((prev) => ({ ...prev, voiceStatus: "securing" as const }));
      voiceStore.flush();
      expect(rings(ws)).toHaveLength(0);

      finishCallJoin();
      expect(rings(ws)).toHaveLength(1);
      m.page.destroy?.();
    });

    it("drops a delayed Ring again when the caller leaves the call", async () => {
      await withFakeTimers(async () => {
        const { ws } = await mountCaller();
        startCall();
        finishCallJoin();
        vi.advanceTimersByTime(1000);
        // The callee declines; Ring again inside the spacing window.
        callDeclined(ws);
        (document.querySelector('[data-testid="dcp-ring-again"]') as HTMLElement).click();
        leaveVoice();

        vi.advanceTimersByTime(5000);
        expect(rings(ws)).toHaveLength(1);
        m.page.destroy?.();
      });
    });

    it("sends no ring and shows no Calling… when the join is refused", async () => {
      const { ws, panel } = await mountCaller();
      startCall();
      // The dispatcher's join rollback.
      leaveVoice();

      expect(rings(ws)).toHaveLength(0);
      expect(panel.dataset.state).not.toBe("outgoing");
      m.page.destroy?.();
    });

    it("a second Call 1 s after a ring waits for the server's 3 s window", async () => {
      await withFakeTimers(async () => {
        const { ws, panel } = await mountCaller();
        const start = mockCreateChatArea.mock.calls[0]![0].onStartCall;
        start();
        finishCallJoin();
        expect(rings(ws)).toHaveLength(1);

        vi.advanceTimersByTime(1000);
        start();
        expect(rings(ws)).toHaveLength(1);

        // Held back the server's 3 s window plus transport slack.
        vi.advanceTimersByTime(2249);
        expect(rings(ws)).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(rings(ws)).toHaveLength(2);
        expect(panel.dataset.state).toBe("outgoing");
        m.page.destroy?.();
      });
    });

    it("drops a waiting ring when the socket drops before it fires", async () => {
      await withFakeTimers(async () => {
        const { ws } = await mountCaller();
        ringTwiceWithinWindow();
        // An unplanned drop keeps the voice channel, so only the status says so.
        uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));

        vi.advanceTimersByTime(5000);
        expect(rings(ws)).toHaveLength(1);
        m.page.destroy?.();
      });
    });

    it("drops a waiting ring across a drop that reconnects before it fires", async () => {
      await withFakeTimers(async () => {
        const { ws } = await mountCaller();
        ringTwiceWithinWindow();
        uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
        uiStore.flush();
        uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
        uiStore.flush();

        vi.advanceTimersByTime(5000);
        expect(rings(ws)).toHaveLength(1);
        m.page.destroy?.();
      });
    });

    it("keeps a margin over the server's 3 s window for transport jitter", async () => {
      await withFakeTimers(async () => {
        const { ws } = await mountCaller();
        ringTwiceWithinWindow();

        vi.advanceTimersByTime(2000);
        expect(rings(ws)).toHaveLength(1);
        vi.advanceTimersByTime(500);
        expect(rings(ws)).toHaveLength(2);
        m.page.destroy?.();
      });
    });

    it("a ring the server rate-limits ends the outgoing call", async () => {
      const { ws, panel } = await mountCaller();
      vi.mocked(ws.send).mockImplementation((m) =>
        (m as { type: string }).type === "call_ring" ? "ring-id" : "id",
      );
      startCall();
      finishCallJoin();
      expect(panel.dataset.state).toBe("outgoing");

      ws.emit("error", { code: "RATE_LIMITED", message: "too many call attempts" }, "other-id");
      expect(panel.dataset.state).toBe("outgoing");
      ws.emit("error", { code: "RATE_LIMITED", message: "too many call attempts" }, "ring-id");
      expect(panel.dataset.state).not.toBe("outgoing");
      m.page.destroy?.();
    });

    it("drops a waiting ring when the caller leaves before it fires", async () => {
      await withFakeTimers(async () => {
        const { ws } = await mountCaller();
        ringTwiceWithinWindow();
        leaveVoice();

        vi.advanceTimersByTime(5000);
        expect(rings(ws)).toHaveLength(1);
        m.page.destroy?.();
      });
    });
  });

  /** Mounts with a connected DM, starts a call and returns its panel, ringing; the socket is left in `ringWs`. */
  async function mountRinging(): Promise<HTMLElement> {
    const ws = fakeWs();
    connectedDm(50);
    m.page = await mountSettled(m.container, ws);
    vi.mocked(stopRingback).mockClear();
    vi.mocked(ws.send).mockImplementation((m) =>
      (m as { type: string }).type === "call_ring" ? "ring-id" : "id",
    );
    startCall();
    finishCallJoin();
    const panel = callPanelEl();
    expect(panel.dataset.state).toBe("outgoing");
    ringWs = ws;
    return panel;
  }
  let ringWs: ReturnType<typeof fakeWs>;

  it("a ring refused because the callee has not accepted ends the outgoing call at once", async () => {
    const panel = await mountRinging();
    const ws = ringWs;

    const refusal = {
      code: "CALL_REQUIRES_ACCEPTANCE",
      message: "calls work after the other person accepts your message request",
    };
    // A refusal answering an earlier ring (another envelope id) leaves this
    // newer outgoing call alone.
    ws.emit("error", refusal, "an-earlier-ring");
    expect(stopRingback).not.toHaveBeenCalled();
    expect(panel.dataset.state).toBe("outgoing");

    ws.emit("error", refusal, "ring-id");

    expect(stopRingback).toHaveBeenCalledTimes(1);
    expect(panel.dataset.state).not.toBe("outgoing");
    expect(panel.dataset.state).not.toBe("unanswered");
    m.page.destroy?.();
  });

  describe("any error answering the ring ends the outgoing call", () => {
    it.each(["FORBIDDEN", "TIMED_OUT", "VOICE_ERROR", "INTERNAL"])(
      "%s answering the ring stops the ringback and clears Calling",
      async (code) => {
        const panel = await mountRinging();

        ringWs.emit("error", { code, message: "refused" }, "ring-id");

        expect(stopRingback).toHaveBeenCalledTimes(1);
        expect(panel.dataset.state).not.toBe("outgoing");
        expect(panel.dataset.state).not.toBe("unanswered");
        m.page.destroy?.();
      },
    );

    it("a FORBIDDEN error answering another envelope leaves the call alone", async () => {
      const panel = await mountRinging();

      ringWs.emit("error", { code: "FORBIDDEN", message: "refused" }, "other-id");

      expect(stopRingback).not.toHaveBeenCalled();
      expect(panel.dataset.state).toBe("outgoing");
      m.page.destroy?.();
    });
  });

  it("a callee's decline while the caller is on another channel shows one toast", async () => {
    const ws = fakeWs();
    connectedDm(50);
    m.page = await mountSettled(m.container, ws);
    vi.mocked(startRingback).mockClear();
    vi.mocked(stopRingback).mockClear();

    startCall();
    finishCallJoin();
    expect(startRingback).toHaveBeenCalledTimes(1);
    // The caller moves on to another channel while the callee decides.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 7 }));
    channelsStore.flush();

    callDeclined(ws);

    expect(stopRingback).toHaveBeenCalledTimes(1);
    const toasts = m.container.querySelectorAll('[data-testid="toast"]');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain("bob declined");

    m.page.destroy?.();
  });

  it("an unanswered ring while the caller is on another channel shows one 'No answer' toast", async () => {
    const ws = fakeWs();
    connectedDm(50);
    m.page = await mountSettled(m.container, ws);

    // Catch the outgoing call's own 30s window and run it by hand.
    const realSetTimeout = globalThis.setTimeout;
    let ringTimeout: (() => void) | null = null;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms !== 30_000) return realSetTimeout(fn, ms);
      ringTimeout = fn;
      return 0;
    }) as unknown as typeof setTimeout);
    startCall();
    finishCallJoin();
    timers.mockRestore();

    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 7 }));
    channelsStore.flush();

    expect(ringTimeout).not.toBeNull();
    ringTimeout!();

    expect(stopRingback).toHaveBeenCalled();
    const toasts = m.container.querySelectorAll('[data-testid="toast"]');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain("No answer");

    m.page.destroy?.();
  });

  it("redialing from inside a live call rings but leaves no outgoing ring behind", async () => {
    const ws = fakeWs();
    connectedDm(50);
    const alice = voiceUser(1, { username: "alice" });
    const bob = voiceUser(10, { username: "bob" });
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceUsers: roster(50, [alice, bob]),
    }));
    voiceStore.flush();
    m.page = await mountSettled(m.container, ws);

    startCall();
    expect(ws.send).toHaveBeenCalledWith({ type: "call_ring", payload: { channel_id: 50 } });
    const panel = callPanelEl();
    expect(panel.dataset.state).toBe("connected");

    // Bob hangs up before any other voice change: the panel must not start
    // "Calling bob…" about someone who was just in the call.
    voiceStore.setState((prev) => ({ ...prev, voiceUsers: roster(50, [alice]) }));
    voiceStore.flush();
    expect(panel.dataset.state).toBe("connected");

    m.page.destroy?.();
  });

  it("shows the caller's nickname on the incoming-call banner, not the raw username", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    membersStore.setState(() => ({
      members: new Map([
        [
          10,
          {
            id: 10,
            username: "alice_1998",
            avatar: null,
            role: "member",
            status: "online" as const,
            displayName: "Ali",
          },
        ],
      ]),
      typingUsers: new Map(),
      roleRevision: 0,
    }));

    m.page = mountPage(m.container, ws);

    // Alice (10) has set a nickname of "Ali" -- every other identity surface
    // (voice roster, member list, DM header) resolves through it, so the
    // ring must too instead of showing the raw handle.
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice_1998" });

    const title = document.querySelector('[data-testid="incoming-call-title"]') as HTMLElement;
    expect(title.textContent).toBe("Ali is calling");
  });

  it("falls back to the raw username on the incoming-call banner when the caller isn't in the members store", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    m.page = mountPage(m.container, ws);

    ws.emit("call_incoming", { channel_id: 50, from_user: 999, username: "stranger" });

    const title = document.querySelector('[data-testid="incoming-call-title"]') as HTMLElement;
    expect(title.textContent).toBe("stranger is calling");
  });

  it("does not cancel an incoming ring when a fellow group-DM callee declines, only when the actual ringer does", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    m.page = mountPage(m.container, ws);

    // Alice (10) rings a group DM; this client is a third participant.
    incomingCall(ws);

    const banner = incomingBannerEl();
    expect(banner.style.display).not.toBe("none");

    // Bob (11), a different callee in the same group DM, declines. The
    // server addresses call_declined to every other participant (not just
    // the caller — it holds no call state to target with), so this client
    // receives it too, but it must not silence a ring it is still deciding
    // on: Bob declining is not Alice hanging up.
    ws.emit("call_declined", { channel_id: 50, from_user: 11, username: "bob" });

    expect(banner.style.display).not.toBe("none");

    // The actual ringer's own call_declined (e.g. a glare decline) still
    // cancels it.
    ws.emit("call_declined", { channel_id: 50, from_user: 10, username: "alice" });

    expect(banner.style.display).toBe("none");
  });

  it("does not cancel an incoming ring on a voice_leave for a different channel from the ringer", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    m.page = mountPage(m.container, ws);

    // Alice (10) rings this client's DM (channel 50).
    incomingCall(ws);

    vi.mocked(alertMissedCall).mockClear();
    const banner = incomingBannerEl();
    expect(banner.style.display).not.toBe("none");

    // Alice also happens to be sitting in an unrelated server voice channel
    // (99) and leaves it. Same user, wrong channel: this must not silence
    // the DM ring — only a voice_leave for the ring's own channel (50) may.
    ws.emit("voice_leave", { channel_id: 99, user_id: 10 });

    expect(banner.style.display).not.toBe("none");

    // Alice leaving the ring's own channel (the DM she was calling from)
    // still cancels it.
    ws.emit("voice_leave", { channel_id: 50, user_id: 10 });

    expect(banner.style.display).toBe("none");
    // The ringer hanging up first is a missed call, same notice as a timeout (D-07).
    await vi.waitFor(() => expect(alertMissedCall).toHaveBeenCalledTimes(1));
    expect(vi.mocked(alertMissedCall).mock.calls[0]![0]).toMatchObject({ channelId: 50 });
  });

  it("does not cancel a group-DM ring when the ringer leaves voice but another callee is still in the call", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    m.page = mountPage(m.container, ws);

    // Alice (10) rings a group DM (channel 50); this client is a third
    // participant (C).
    incomingCall(ws);

    const banner = incomingBannerEl();
    expect(banner.style.display).not.toBe("none");

    // Bob (11) already accepted and is sitting in the DM's voice channel.
    // The dispatcher's own voice_leave handler may already have removed
    // Alice from the roster by the time this fires (order-independent), so
    // her entry is absent here too — only Bob remains.
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: roster(50, [voiceUser(11, { username: "bob" })]),
    }));
    voiceStore.flush();

    // Alice, the ringer, hangs up. The call is still live — Bob is in it —
    // so this client's own one-click Accept must not disappear.
    ws.emit("voice_leave", { channel_id: 50, user_id: 10 });

    expect(banner.style.display).not.toBe("none");
  });

  it("stops a group ring when the last person leaves after the ringer did", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    m.page = mountPage(m.container, ws);
    incomingCall(ws);
    const banner = incomingBannerEl();

    const carol = voiceUser(11, { username: "carol" });
    const setRoster = (users: (typeof carol)[]) => {
      voiceStore.setState((prev) => ({
        ...prev,
        voiceUsers: new Map([[50, new Map(users.map((u) => [u.userId, u]))]]),
      }));
      voiceStore.flush();
    };
    // alice leaves while carol stays: the ring stays (OC-0235).
    setRoster([carol]);
    ws.emit("voice_leave", { channel_id: 50, user_id: 10 });
    expect(banner.style.display).not.toBe("none");

    // carol, not the ringer, empties the room: the ring is over.
    setRoster([]);
    ws.emit("voice_leave", { channel_id: 50, user_id: 11 });
    expect(banner.style.display).toBe("none");
  });

  it("silently ends an incoming ring once this client is in the ringing channel by any path", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    m.page = mountPage(m.container, ws);

    incomingCall(ws);
    const banner = incomingBannerEl();
    expect(banner.style.display).not.toBe("none");

    // Joined without Accept (the header's call button, the Join strip, the
    // sidebar): being in the room answers the ring.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50 }));
    voiceStore.flush();

    expect(banner.style.display).toBe("none");
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "call_decline" }));
  });

  it("a ring raises one call alert, and a redial of the same ring none", async () => {
    const ws = fakeWs();
    m.page = mountPage(m.container, ws);
    vi.mocked(alertIncomingCall).mockClear();

    incomingCall(ws);
    incomingCall(ws);

    await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(1));
    expect(vi.mocked(alertIncomingCall).mock.calls[0]![0]).toMatchObject({
      channelId: 50,
      fromUserId: 10,
    });
  });

  it("a ring that times out reports one missed call; one the ringer cancelled reports none", async () => {
    const ws = fakeWs();
    m.page = mountPage(m.container, ws);
    vi.mocked(alertMissedCall).mockClear();
    vi.mocked(alertIncomingCall).mockClear();

    // The ringer hangs up first: not a missed call.
    incomingCall(ws);
    await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(1));
    ws.emit("call_declined", { channel_id: 50, from_user: 10 });
    // Catch the ring's 30s timer and run it by hand: fake timers would also
    // stall the dynamic import that loads the alert chunk.
    const realSetTimeout = globalThis.setTimeout;
    let ringTimeout: (() => void) | null = null;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms !== 30_000) return realSetTimeout(fn, ms);
      ringTimeout = fn;
      return 0;
    }) as unknown as typeof setTimeout);
    incomingCall(ws);
    timers.mockRestore();
    expect(ringTimeout).not.toBeNull();
    // Let this ring's own alert land first: a mocked module imported again
    // while that import is still in flight resolves to the real one here.
    await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(2));
    ringTimeout!();

    await vi.waitFor(() => expect(alertMissedCall).toHaveBeenCalledTimes(1));
    expect(vi.mocked(alertMissedCall).mock.calls[0]![0]).toMatchObject({ channelId: 50 });
    const banner = incomingBannerEl();
    expect(banner.style.display).toBe("none");
  });

  describe("a ring for a group the user loses", () => {
    const groupRow = (channelId: number) => ({
      channelId,
      recipient: { id: 10, username: "alice", avatar: "", status: "online" },
      participants: [
        { id: 10, username: "alice", avatar: "", status: "online" },
        { id: 11, username: "bob", avatar: "", status: "online" },
      ],
      name: "Group Chat",
      isGroup: true,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    });
    const banner = () => incomingBannerEl();

    it("is cancelled with no missed call when the group leaves dmStore", async () => {
      const ws = fakeWs();
      dmStore.setState(() => ({ channels: [groupRow(50)] }));
      m.page = mountPage(m.container, ws);
      vi.mocked(alertMissedCall).mockClear();
      vi.mocked(alertIncomingCall).mockClear();

      incomingCall(ws);
      await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(1));
      expect(banner().style.display).not.toBe("none");

      // Left, or removed by the owner: the group drops out of the store.
      dmStore.setState(() => ({ channels: [] }));
      dmStore.flush();

      expect(banner().style.display).toBe("none");
      expect(alertMissedCall).not.toHaveBeenCalled();
    });

    it("is not cancelled by dmStore changes while its channel was never listed", async () => {
      const ws = fakeWs();
      dmStore.setState(() => ({ channels: [groupRow(60)] }));
      m.page = mountPage(m.container, ws);
      vi.mocked(alertIncomingCall).mockClear();

      // The ring beats its dm_channel_open: channel 50 is not in dmStore yet.
      incomingCall(ws);
      await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(1));

      // An unrelated group goes away, then another DM changes.
      dmStore.setState(() => ({ channels: [] }));
      dmStore.flush();
      dmStore.setState(() => ({ channels: [groupRow(61)] }));
      dmStore.flush();

      expect(banner().style.display).not.toBe("none");
    });
  });

  // OC-0037 / OC-0204: DND silences the tone and the popup (call-alerts.test.ts),
  // never the banner — it is the one way left to answer.
  it("DND keeps the banner", () => {
    saveUserStatus("dnd");
    try {
      const ws = fakeWs();
      m.page = mountPage(m.container, ws);

      incomingCall(ws);

      const banner = incomingBannerEl();
      expect(banner.style.display).not.toBe("none");
    } finally {
      saveUserStatus("online");
    }
  });

  it("does not ring for the channel this client is already in", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50 }));
    voiceStore.flush();

    m.page = mountPage(m.container, ws);
    vi.mocked(startRingChime).mockClear();

    // Someone else in the call redials the DM: the server rings everyone
    // else in it, this client included.
    incomingCall(ws);

    const banner = incomingBannerEl();
    expect(banner.style.display).toBe("none");
    expect(startRingChime).not.toHaveBeenCalled();
  });

  it("clears settingsOpen on destroy so the next page (e.g. ConnectPage after logout) doesn't inherit a stale open overlay", () => {
    m.page = mountPage(m.container);

    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));

    m.page.destroy?.();

    expect(uiStore.getState().settingsOpen).toBe(false);
  });

  it("scopes per-user volume prefs to the connected host, like channel mutes and the NSFW gate", () => {
    m.page = mountPage(m.container);

    expect(mockSetAudioVolumeHost).toHaveBeenCalledWith("");
  });

  it("closes an open image lightbox on destroy so it doesn't survive onto the next page", () => {
    m.page = mountPage(m.container);

    openImageLightbox("https://example.com/pic.png", "pic");
    expect(document.body.querySelector(".image-lightbox")).not.toBeNull();

    m.page.destroy?.();

    expect(document.body.querySelector(".image-lightbox")).toBeNull();
  });
});
