// Tests for src/lib/voice/roomEventHandlers.ts, continued from tracks.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/roomEventHandlersMocks";
import { DisconnectReason, Encryption_Type, RoomEvent, Track } from "livekit-client";
import type { LocalTrackPublication, Participant, Room } from "livekit-client";
import { onRoom } from "../../../src/features/voice/releaseRoom";
import { beginJoinAttempt, finishJoinAttempt, voiceJoinSnapshot } from "@lib/voice/voiceJoinTrace";
import type { RoomEventDeps } from "@lib/voice/roomEventHandlers";
import { voiceStore, setEncryptionDegraded, joinVoiceChannel } from "@stores/voice.store";
import { expectConsole } from "../../helpers/console";
import { captureLogs } from "../../helpers/log-capture";
import {
  Harness,
  build,
  audioTrack,
  videoTrack,
  pub,
  participant,
  remotePub,
  withEncryption,
  useRoomEventHandlersHarness,
} from "../../helpers/roomEventHandlersHarness";

vi.mock("@stores/voice.store", (importOriginal) => mocks.voiceStoreMock(importOriginal));

useRoomEventHandlersHarness();

describe("remote publications without end-to-end encryption", () => {
  it("never subscribes one and marks the call not secured", () => {
    const h = build();
    const mic = withEncryption(remotePub(Track.Source.Microphone), Encryption_Type.NONE);

    h.handlers.handleTrackPublished(mic, participant("user-7:tok"));
    expectConsole("warn", /without end-to-end encryption/);

    expect(mic.setSubscribed).toHaveBeenCalledWith(false);
    expect(mic.setSubscribed).not.toHaveBeenCalledWith(true);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  it("subscribes an encrypted voice as before and leaves the call secured", () => {
    const h = build();
    const mic = withEncryption(remotePub(Track.Source.Microphone), Encryption_Type.GCM);

    h.handlers.handleTrackPublished(mic, participant("user-7:tok"));

    expect(mic.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(voiceStore.getState().encryptionDegraded).toBe(false);
  });

  it("applies to everyone already in the room on connect", () => {
    const h = build();
    h.spies.isWatched.mockReturnValue(true);
    const camera = withEncryption(remotePub(Track.Source.Camera), Encryption_Type.NONE);
    const mic = withEncryption(remotePub(Track.Source.Microphone), Encryption_Type.GCM);
    const room = {
      remoteParticipants: new Map([
        [
          "user-7:tok",
          {
            identity: "user-7:tok",
            trackPublications: new Map([
              ["c", camera],
              ["m", mic],
            ]),
          },
        ],
      ]),
    } as unknown as Room;

    h.handlers.handleConnected(room);
    expectConsole("warn", /without end-to-end encryption/);

    expect(camera.setSubscribed).toHaveBeenCalledWith(false);
    expect(camera.setSubscribed).not.toHaveBeenCalledWith(true);
    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
    expect(mic.setSubscribed).toHaveBeenCalledWith(true);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  it("drops a subscription that arrives anyway, without attaching it", () => {
    const h = build();
    const mic = withEncryption(remotePub(Track.Source.Microphone), Encryption_Type.NONE);

    h.handlers.handleTrackSubscribed(audioTrack(), mic, participant("user-7:tok"));
    expectConsole("warn", /without end-to-end encryption/);

    expect(mic.setSubscribed).toHaveBeenCalledWith(false);
    expect(h.audioElements.handleTrackSubscribedAudio).not.toHaveBeenCalled();
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  it("subscribes the same participant again once they republish encrypted", () => {
    const h = build();
    h.handlers.handleTrackPublished(
      withEncryption(remotePub(Track.Source.Microphone), Encryption_Type.NONE),
      participant("user-7:tok"),
    );
    expectConsole("warn", /without end-to-end encryption/);
    const republished = withEncryption(remotePub(Track.Source.Microphone), Encryption_Type.GCM);

    h.handlers.handleTrackPublished(republished, participant("user-7:tok"));

    expect(republished.setSubscribed).toHaveBeenLastCalledWith(true);
    // The call already carried unprotected media this session: it stays flagged.
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  it("treats a publication with no track info as encrypted (the worker drops its frames)", () => {
    const h = build();
    const mic = remotePub(Track.Source.Microphone);

    h.handlers.handleTrackPublished(mic, participant("user-7:tok"));

    expect(mic.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(voiceStore.getState().encryptionDegraded).toBe(false);
  });
});

// ── handleEncryptionError (OC-0002) ────────────────────────────────────────
//
// livekit-client's E2eeManager emits RoomEvent.EncryptionError when the
// per-room E2EE worker dies (onWorkerError) — the ECDH/HKDF key exchange can
// still succeed while the worker that actually encrypts frames is dead. With
// nothing subscribed to this event, that failure was invisible: voiceStatus
// still reaches "connected" and the widget's Secured badge lit up regardless.

describe("handleEncryptionError", () => {
  it("marks encryption degraded in the voice store so the Secured badge can react", () => {
    const h = build();
    expect(voiceStore.getState().encryptionDegraded).toBe(false);

    h.handlers.handleEncryptionError(new Error("worker crashed"));

    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  it("SRE-M2: counts every receive-side decrypt failure, tolerated or not", () => {
    const h = build();
    const bob = { identity: "bob", isLocal: false } as Participant;
    const before = voiceJoinSnapshot().decryptErrorCount;

    h.handlers.handleEncryptionError(
      new Error("InvalidKey: Decryption failed: operation-specific"),
      bob,
    );

    expectConsole("warn", /receive-side decrypt failure/);
    expect(voiceJoinSnapshot().decryptErrorCount).toBe(before + 1);
  });

  it("SRE-M2: counts a native decrypt failure from a remote participant", () => {
    const h = build();
    const bob = { identity: "bob", isLocal: false } as Participant;
    const before = voiceJoinSnapshot().decryptErrorCount;

    h.handlers.handleEncryptionError(new Error("native decrypt failure"), bob);

    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expect(voiceJoinSnapshot().decryptErrorCount).toBe(before + 1);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  it("SRE-M2: does not count an error with no remote participant as a decrypt failure", () => {
    const h = build();
    const before = voiceJoinSnapshot().decryptErrorCount;

    h.handlers.handleEncryptionError(new Error("worker crashed"));
    h.handlers.handleEncryptionError(new Error("InvalidKey: local"), {
      identity: "me",
      isLocal: true,
    } as Participant);

    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expect(voiceJoinSnapshot().decryptErrorCount).toBe(before);
  });

  it("marks encryption degraded even when no participant is attributed", () => {
    const h = build();

    h.handlers.handleEncryptionError(new Error("worker crashed"), undefined);

    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  // OC-0452: every key rotation installs the new room key at index 0 before
  // the peer has it, so for a moment one side's frames fail AES-GCM with a
  // key present — the worker reports `InvalidKey: Decryption failed` for the
  // REMOTE sender. Those frames are dropped, never played in clear, and the
  // failures stop once the offer lands. Only a streak that outlasts the grace
  // window is a real failure.
  describe("receive-side decrypt failures", () => {
    const bob = { identity: "bob", isLocal: false } as Participant;
    const decryptFailed = () =>
      new Error(
        "InvalidKey: Decryption failed: The operation failed for an operation-specific reason",
      );

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not degrade on a transient InvalidKey from a remote participant at join", () => {
      const h = build();

      h.handlers.handleEncryptionError(decryptFailed(), bob);
      vi.advanceTimersByTime(1000);
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("degrades when decrypt failures from the same participant persist past the grace window", () => {
      const h = build();

      // The worker throttles to one error per second: a key that never lands
      // keeps reporting at that cadence.
      for (let i = 0; i < 3; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        expectConsole("warn", /receive-side decrypt failure/);
        vi.advanceTimersByTime(1000);
      }
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("clears the degraded badge again once a stalled peer's decrypts resume", () => {
      const h = build();

      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);

      // The key finally lands: the worker stops reporting, so a quiet gap
      // longer than livekit's 60 s error-rate window clears the latch instead
      // of leaving "Unsecured" for the rest of the call.
      vi.advanceTimersByTime(30_000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
      vi.advanceTimersByTime(40_000);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("clears a native room's stall as soon as its unthrottled reports stop", () => {
      // The native room re-reports every second until the peer decrypts
      // again, so a gap past the streak reset already means recovery.
      const h = build({ isNativeRoom: () => true });

      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);

      vi.advanceTimersByTime(3000);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("stays degraded while a failing peer's reports are held back by livekit's rate limiter", () => {
      const h = build();
      // livekit-client's ErrorRateLimiter: one report a second, at most 5 per
      // window, and a new window only once 60 s have passed since the last
      // report, so a peer that never decrypts again reports in bursts about
      // 66 s apart with just over 60 s of silence between them.
      const reportFor = (seconds: number): void => {
        for (let s = 0; s < seconds; s++) {
          if (s % 66 <= 5) h.handlers.handleEncryptionError(decryptFailed(), bob);
          vi.advanceTimersByTime(1000);
          expect(voiceStore.getState().encryptionDegraded).toBe(s >= 3);
        }
      };

      reportFor(180);
      // Three bursts, one streak: no key install between them, so only the
      // first burst's first 3 reports are tolerated.
      for (let i = 0; i < 3; i++) expectConsole("warn", /receive-side decrypt failure/);
      for (let i = 0; i < 15; i++) {
        expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      }
    });

    it("keeps the badge degraded when the worker dies while a decrypt recovery is pending", () => {
      const h = build();

      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      // The worker dies: no more decrypt reports arrive, and the quiet gap
      // that follows must not read as the peer's decrypts resuming.
      h.handlers.handleEncryptionError(new Error("E2EE worker crashed"));
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      vi.advanceTimersByTime(5000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);

      // A later decrypt streak (after a fresh key install) and its quiet gap
      // do not clear it either.
      h.handlers.noteRoomKeyInstalled();
      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      vi.advanceTimersByTime(5000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("does not let a pending recovery from a left call touch the next one", () => {
      const h = build();

      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      // Leave; the next call starts clean and is degraded by its own cause,
      // which the left call's quiet-gap timer must not clear.
      h.handlers.resetEncryptionRecovery();
      setEncryptionDegraded(false);
      setEncryptionDegraded(true);
      vi.advanceTimersByTime(5000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("tolerates separate transient races a few seconds apart", () => {
      const h = build();

      h.handlers.handleEncryptionError(decryptFailed(), bob);
      vi.advanceTimersByTime(5000);
      // Each rotation race comes with its own key install.
      h.handlers.noteRoomKeyInstalled();
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("tolerates separate transient races that are far apart", () => {
      const h = build();

      h.handlers.handleEncryptionError(decryptFailed(), bob);
      vi.advanceTimersByTime(5 * 60_000);
      h.handlers.noteRoomKeyInstalled();
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("intermittent bursts with a wrong key degrade the call", () => {
      const h = build();

      // Bursts shorter than the grace window, separated by a quiet gap: the
      // gap is not evidence the peer's frames decrypt again.
      // Errors at t = 0, 1, 2 s, silence, then t = 5, 6 s.
      for (let i = 0; i < 3; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      for (let i = 0; i < 3; i++) expectConsole("warn", /receive-side decrypt failure/);
      vi.advanceTimersByTime(2000);
      h.handlers.handleEncryptionError(decryptFailed(), bob);
      vi.advanceTimersByTime(1000);
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("a key install starts a fresh grace window", () => {
      const h = build();

      for (let i = 0; i < 3; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      vi.advanceTimersByTime(7000);
      h.handlers.noteRoomKeyInstalled();
      for (let i = 0; i < 3; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }

      for (let i = 0; i < 6; i++) expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("a key install in the same millisecond as the last failure still starts a fresh window", () => {
      const h = build();

      // A streak already past the grace window.
      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      h.handlers.handleEncryptionError(decryptFailed(), bob);
      for (let i = 0; i < 3; i++) expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      setEncryptionDegraded(false);

      // The next rotation installs its key without the clock moving.
      h.handlers.noteRoomKeyInstalled();
      vi.advanceTimersByTime(1000);
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("degrades immediately on a sender-side missing key, even with a participant attributed", () => {
      const h = build();
      const me = { identity: "me", isLocal: true } as Participant;

      h.handlers.handleEncryptionError(
        new Error("MissingKey: encryption key missing for encoding"),
        me,
      );

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("degrades immediately on an InvalidKey attributed to the local participant", () => {
      const h = build();
      const me = { identity: "me", isLocal: true } as Participant;

      h.handlers.handleEncryptionError(decryptFailed(), me);

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("degrades immediately on an InvalidKey with no participant attributed", () => {
      const h = build();

      h.handlers.handleEncryptionError(decryptFailed(), undefined);

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("degrades immediately on a native-backend encryption failure", () => {
      const h = build();

      h.handlers.handleEncryptionError(new Error("native E2EE not active"));

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });
  });
});

// ── handleDisconnected ─────────────────────────────────────────────────────

describe("handleDisconnected", () => {
  it("defers to the retry loop while still connecting", () => {
    const h = build({ isConnecting: () => true });

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
  });

  // The bundled livekit-client emits RoomEvent.Disconnected (synchronously,
  // before rejecting) on EVERY failed reconnect attempt inside the retry
  // loop's own room.connect() call — including while the active reconnect
  // loop is still running with the attempt room's listeners attached. Without
  // this guard that re-entrant Disconnected starts a SECOND, uncancellable
  // attemptAutoReconnect loop whose AbortController is stored nowhere.
  it("defers to the active reconnect loop while already reconnecting", () => {
    const h = build({ isConnecting: () => false, isReconnecting: () => true });

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
    expect(h.spies.teardownForReconnect).not.toHaveBeenCalled();
  });

  it("auto-reconnects on an unexpected disconnect", () => {
    const h = build();
    onRoom(h.room as unknown as Room, RoomEvent.Disconnected, h.handlers.handleDisconnected);

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.teardownForReconnect).toHaveBeenCalled();
    expect(h.audioElements.cleanupAllAudioElements).toHaveBeenCalled();
    expect(h.spies.setRoom).toHaveBeenCalledWith(null);
    expect(h.spies.syncModuleRooms).toHaveBeenCalled();
    // Only the app's own listener goes; livekit's disconnect cleanups stay.
    expect(h.room.off).toHaveBeenCalledWith(RoomEvent.Disconnected, h.handlers.handleDisconnected);
    expect(h.room.disconnect).toHaveBeenCalled();
    expect(h.spies.setReconnectAc).toHaveBeenCalledWith(expect.any(AbortController));
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalledWith(
      "tok",
      "wss://lk.example",
      12,
      undefined,
      expect.any(AbortSignal),
    );
    // A reconnect must not surface an error toast or leave the channel.
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
    expect(h.spies.onError).not.toHaveBeenCalled();
  });

  it("passes the direct URL through to the reconnect attempt", () => {
    const h = build({ getLastDirectUrl: () => "wss://direct.example" });

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.attemptAutoReconnect).toHaveBeenCalledWith(
      "tok",
      "wss://lk.example",
      12,
      "wss://direct.example",
      expect.any(AbortSignal),
    );
  });

  it("leaves voice cleanly on a client-initiated disconnect", () => {
    const h = build();

    h.handlers.handleDisconnected(DisconnectReason.CLIENT_INITIATED);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).toHaveBeenCalledWith(false);
    // The user asked to leave, so no error is reported.
    expect(h.spies.onError).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", { getLatestToken: () => null }],
    ["no channel", { getCurrentChannelId: () => null }],
    ["no url", { getLastUrl: () => null }],
  ])("reports an error when it cannot reconnect (%s)", (_label, over) => {
    const h = build(over as Partial<RoomEventDeps>);

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).toHaveBeenCalledWith(false);
    expect(h.spies.onError).toHaveBeenCalledWith("Voice connection lost — disconnected");
  });

  it("treats an undefined reason as unexpected", () => {
    const h = build();

    h.handlers.handleDisconnected(undefined);

    expect(h.spies.attemptAutoReconnect).toHaveBeenCalled();
  });

  it("tolerates the room already being gone", () => {
    const h = build({ getRoom: () => null });

    expect(() => {
      h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);
    }).not.toThrow();
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalled();
  });

  it("swallows a failing disconnect on the stale room", async () => {
    const h = build();
    h.room.disconnect.mockRejectedValue(new Error("already closed"));

    expect(() => {
      h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(h.room.disconnect).toHaveBeenCalled();
    });
    expectConsole("warn", /\[roomEventHandlers\] Failed to disconnect stale room/);
  });

  it("tolerates a missing error callback", () => {
    const h = build({ getLatestToken: () => null, getOnErrorCallback: () => null });

    expect(() => {
      h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);
    }).not.toThrow();
  });
});

// ── handleSdkReconnecting / handleSdkReconnected (RT-9) ────────────────────

// livekit-client retries a dropped signal socket on its own before it ever
// emits Disconnected (an SFU restart spends most of its window here), so the
// widget must read "reconnecting" during that phase, not "connected".
describe("handleSdkReconnecting / handleSdkReconnected", () => {
  function setStatus(voiceStatus: "securing" | "connected" | "reconnecting"): void {
    voiceStore.setState((prev) => ({ ...prev, voiceStatus }));
  }

  it("shows reconnecting while the SDK retries a connected room, then connected once it recovers", () => {
    const h = build();
    setStatus("connected");

    h.handlers.handleSdkReconnecting();
    expect(voiceStore.getState().voiceStatus).toBe("reconnecting");

    h.handlers.handleSdkReconnected();
    expect(voiceStore.getState().voiceStatus).toBe("connected");
  });

  it("leaves a join that is still securing alone", () => {
    const h = build();
    setStatus("securing");

    h.handlers.handleSdkReconnecting();
    h.handlers.handleSdkReconnected();

    expect(voiceStore.getState().voiceStatus).toBe("securing");
  });

  it("ignores events from a room that is not the connected session room", () => {
    const h = build({ getRoom: () => null, isReconnecting: () => true });
    setStatus("reconnecting");

    h.handlers.handleSdkReconnected();

    expect(voiceStore.getState().voiceStatus).toBe("reconnecting");
  });
});

// ── stalled signal resume ──────────────────────────────────────────────────

// livekit-client resumes a cut signal socket up to 10 times, each allowed 15 s
// to open, before it emits Disconnected, so a cut the SFU never answers leaves
// the badge on "reconnecting" and every stream frozen for minutes while a
// manual rejoin takes ~150 ms. The widget gives the SDK a short budget, then
// abandons that room and runs its own reconnect loop.
describe("a stalled signal resume", () => {
  const BUDGET_MS = 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the stuck room and starts the reconnect loop once the budget is spent", () => {
    const h = build();
    onRoom(h.room as unknown as Room, RoomEvent.Disconnected, h.handlers.handleDisconnected);

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS - 1);
    expect(h.room.disconnect).not.toHaveBeenCalled();
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expectConsole("warn", /LiveKit resume stalled/);
    expect(h.spies.teardownForReconnect).toHaveBeenCalled();
    expect(h.spies.setRoom).toHaveBeenCalledWith(null);
    expect(h.room.off).toHaveBeenCalledWith(RoomEvent.Disconnected, h.handlers.handleDisconnected);
    expect(h.room.disconnect).toHaveBeenCalled();
    expect(h.spies.setReconnectAc).toHaveBeenCalledWith(expect.any(AbortController));
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalledWith(
      "tok",
      "wss://lk.example",
      12,
      undefined,
      expect.any(AbortSignal),
    );
    // A recovery, not a leave: no error toast and the channel is kept.
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
    expect(h.spies.onError).not.toHaveBeenCalled();
  });

  it("does nothing when the SDK reconnects within the budget", () => {
    const h = build();

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS - 1);
    h.handlers.handleSdkReconnected();
    vi.advanceTimersByTime(BUDGET_MS);

    expect(h.room.disconnect).not.toHaveBeenCalled();
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
  });

  it("does nothing when the SDK gives up on its own within the budget", () => {
    const h = build();

    h.handlers.handleSdkReconnecting();
    h.handlers.handleDisconnected(DisconnectReason.CLIENT_INITIATED);
    vi.advanceTimersByTime(BUDGET_MS * 2);

    expect(h.room.disconnect).not.toHaveBeenCalled();
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
  });

  it("counts the budget from the first event when Reconnecting follows SignalReconnecting", () => {
    const h = build();

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS / 2);
    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS / 2);

    expectConsole("warn", /LiveKit resume stalled/);
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalledTimes(1);
  });

  it("leaves a room that is no longer the connected session room alone", () => {
    let current: Room | null = {} as Room;
    const h = build({ getRoom: () => current });

    h.handlers.handleSdkReconnecting();
    current = null; // the user left, or another attempt replaced the room
    vi.advanceTimersByTime(BUDGET_MS);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.setRoom).not.toHaveBeenCalled();
  });

  it("re-arms for a rejoined room when a stale timer from the left room is pending", () => {
    let current: Room = {} as Room;
    const h = build({ getRoom: () => current });

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(3000);
    current = h.room as unknown as Room; // left, then rejoined into a new room
    vi.advanceTimersByTime(2000);
    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS - 1);
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expectConsole("warn", /LiveKit resume stalled/);
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalled();
  });

  it("stays out of the way when there is no token to reconnect with", () => {
    const h = build({ getLatestToken: () => null });

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS);

    expectConsole("warn", /LiveKit resume stalled/);
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.room.disconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
  });
});

// ── join timing marks ──────────────────────────────────────────────────────

describe("join timing marks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the first local track publication on the active join", () => {
    const h = build();
    const id = beginJoinAttempt(12);
    vi.advanceTimersByTime(30);

    h.handlers.handleLocalTrackPublished({
      source: Track.Source.Camera,
    } as LocalTrackPublication);
    finishJoinAttempt(id);

    expect(voiceJoinSnapshot().lastJoins[0]?.timings.localTrackMs).toBe(30);
  });

  it("stamps the first remote track subscription on the active join", () => {
    const h = build();
    const id = beginJoinAttempt(12);
    vi.advanceTimersByTime(55);

    h.handlers.handleTrackSubscribed(
      audioTrack(),
      remotePub(Track.Source.Microphone),
      participant("user-7:tok"),
    );
    finishJoinAttempt(id);

    expect(voiceJoinSnapshot().lastJoins[0]?.timings.remoteTrackMs).toBe(55);
  });
});

// ── disconnect, reconnect and stall edge cases ─────────────────────────────

describe("disconnect and reconnect state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the voice channel from the store on a client-initiated disconnect", () => {
    const h = build();
    joinVoiceChannel(12);
    expect(voiceStore.getState().currentChannelId).toBe(12);

    h.handlers.handleDisconnected(DisconnectReason.CLIENT_INITIATED);

    expect(h.spies.leaveVoice).toHaveBeenCalledWith(false);
    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("leaves a join that is still securing without a stall timer", () => {
    const h = build();
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "securing" }));

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(30_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(voiceStore.getState().voiceStatus).toBe("securing");
  });

  it("does not abandon a rejoined room whose SDK reconnected after a stale timer fired", () => {
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));
    let current: Room = {} as Room;
    const h = build({ getRoom: () => current });

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(5000);
    current = h.room as unknown as Room;
    h.handlers.handleSdkReconnecting();
    // The first room's budget passes; the rejoined room is not the one that stalled.
    vi.advanceTimersByTime(6000);
    h.handlers.handleSdkReconnected();
    vi.advanceTimersByTime(30_000);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.room.disconnect).not.toHaveBeenCalled();
  });
});

// ── encryption recovery timers ─────────────────────────────────────────────

describe("encryption recovery timers", () => {
  const bob = { identity: "bob", isLocal: false } as Participant;
  const decryptFailed = () =>
    new Error(
      "InvalidKey: Decryption failed: The operation failed for an operation-specific reason",
    );

  /** A peer failing past the grace window: degraded, quiet-gap recovery pending. */
  function degradeByDecrypt(h: Harness): void {
    for (let i = 0; i < 4; i++) {
      h.handlers.handleEncryptionError(decryptFailed(), bob);
      vi.advanceTimersByTime(1000);
    }
    expectConsole("warn", /receive-side decrypt failure/);
    expectConsole("warn", /receive-side decrypt failure/);
    expectConsole("warn", /receive-side decrypt failure/);
    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules no recovery for a tolerated failure while the call is not degraded", () => {
    const h = build();

    h.handlers.handleEncryptionError(decryptFailed(), bob);
    expectConsole("warn", /receive-side decrypt failure/);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("pushes the recovery back while a degraded peer keeps failing after a key install", () => {
    const h = build();
    degradeByDecrypt(h);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);

    vi.advanceTimersByTime(60_000);
    h.handlers.noteRoomKeyInstalled();
    h.handlers.handleEncryptionError(decryptFailed(), bob);
    expectConsole("warn", /receive-side decrypt failure/);

    // The original deadline (65 s after the last failure) passes with no recovery.
    vi.advanceTimersByTime(6000);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
    // 65 s of quiet after the latest failure clears it.
    vi.advanceTimersByTime(60_000);
    expect(voiceStore.getState().encryptionDegraded).toBe(false);
  });

  it("does not let decrypt recovery clear a degradation something else caused first", () => {
    const h = build();
    h.handlers.handleEncryptionError(new Error("E2EE worker crashed"));
    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);

    degradeByDecrypt(h);
    vi.advanceTimersByTime(120_000);

    expect(voiceStore.getState().encryptionDegraded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending recovery when another error degrades the call", () => {
    const h = build();
    degradeByDecrypt(h);
    expect(vi.getTimerCount()).toBe(1);

    h.handlers.handleEncryptionError(new Error("E2EE worker crashed"));
    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending recovery when an unencrypted track is refused", () => {
    const h = build();
    degradeByDecrypt(h);
    expect(vi.getTimerCount()).toBe(1);

    h.handlers.handleTrackPublished(
      withEncryption(remotePub(Track.Source.Microphone), Encryption_Type.NONE),
      participant("user-7:tok"),
    );
    expectConsole("warn", /without end-to-end encryption/);

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  it("cancels a pending recovery when the session resets", () => {
    const h = build();
    degradeByDecrypt(h);
    expect(vi.getTimerCount()).toBe(1);

    h.handlers.resetEncryptionRecovery();

    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── log lines ──────────────────────────────────────────────────────────────

describe("room event log lines", () => {
  const COMPONENT = "roomEventHandlers";

  it("records which sender and source a refused unencrypted track came from", () => {
    const logs = captureLogs();
    const h = build();
    const mic = withEncryption(remotePub(Track.Source.Microphone), Encryption_Type.NONE);

    h.handlers.handleTrackPublished(mic, participant("user-7:tok"));
    expectConsole("warn", /without end-to-end encryption/);

    expect(
      logs.find("Refusing a remote track published without end-to-end encryption"),
    ).toMatchObject([
      { level: "warn", component: COMPONENT, data: { userId: 7, source: Track.Source.Microphone } },
    ]);
  });

  it("records that a mute was re-applied to a newly published microphone", () => {
    const logs = captureLogs();
    const h = build();
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));

    h.handlers.handleLocalTrackPublished({
      source: Track.Source.Microphone,
    } as LocalTrackPublication);

    expect(logs.find("LocalTrackPublished: re-applied mute to mic track")).toMatchObject([
      { level: "debug", component: COMPONENT },
    ]);
  });

  it("records a remote video track subscribed and unsubscribed, with user and track", () => {
    const logs = captureLogs();
    const h = build();
    h.spies.isWatched.mockReturnValue(true);
    const track = videoTrack();

    h.handlers.handleTrackSubscribed(track, pub(Track.Source.Camera), participant("user-7:tok"));
    h.handlers.handleTrackUnsubscribed(track, pub(Track.Source.Camera), participant("user-7:tok"));

    expect(logs.find("Remote video track subscribed")).toMatchObject([
      { level: "debug", component: COMPONENT, data: { userId: 7, trackSid: "VT_1" } },
    ]);
    expect(logs.find("Remote video track unsubscribed")).toMatchObject([
      { level: "debug", component: COMPONENT, data: { userId: 7, trackSid: "VT_1" } },
    ]);
  });

  it("records when audio playback is allowed", () => {
    const logs = captureLogs();
    const h = build();
    h.room.canPlaybackAudio = true;

    h.handlers.handleAudioPlaybackChanged();

    expect(logs.find("Audio playback is now allowed")).toMatchObject([
      { level: "info", component: COMPONENT },
    ]);
  });

  it("records the unlock only after the browser accepts the gesture", async () => {
    const logs = captureLogs();
    const h = build();
    h.room.canPlaybackAudio = false;
    let accept: () => void = () => {};
    h.room.startAudio.mockReturnValue(new Promise<void>((resolve) => (accept = resolve)));
    h.handlers.handleAudioPlaybackChanged();
    expectConsole("warn", /Audio playback blocked by browser/);

    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(logs.find("Audio playback unlocked via user gesture")).toEqual([]);

    accept();
    await vi.waitFor(() =>
      expect(logs.find("Audio playback unlocked via user gesture")).toMatchObject([
        { level: "info", component: COMPONENT },
      ]),
    );
  });

  it("records a disconnect with its reason, and the deferral while a connect is under way", () => {
    const logs = captureLogs();
    const h = build({ isConnecting: () => true });

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(logs.find("LiveKit room disconnected")).toMatchObject([
      { level: "info", component: COMPONENT, data: { reason: DisconnectReason.SERVER_SHUTDOWN } },
    ]);
    expect(
      logs.find("Disconnect during connect/reconnect — deferring to retry loop"),
    ).toMatchObject([{ level: "info", component: COMPONENT }]);
  });

  it("records the budget a stalled resume spent", () => {
    vi.useFakeTimers();
    try {
      const logs = captureLogs();
      voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));
      const h = build();

      h.handlers.handleSdkReconnecting();
      vi.advanceTimersByTime(10_000);
      expectConsole("warn", /LiveKit resume stalled/);

      expect(
        logs.find("LiveKit resume stalled — abandoning room for the reconnect loop"),
      ).toMatchObject([{ level: "warn", component: COMPONENT, data: { budgetMs: 10_000 } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the sender and the error for a decrypt failure that is tolerated", () => {
    const logs = captureLogs();
    const h = build();
    const bob = { identity: "bob", isLocal: false } as Participant;

    h.handlers.handleEncryptionError(new Error("InvalidKey: Decryption failed"), bob);
    expectConsole("warn", /receive-side decrypt failure/);

    expect(
      logs.find("LiveKit E2EE receive-side decrypt failure — tolerating key rotation race"),
    ).toMatchObject([
      {
        level: "warn",
        component: COMPONENT,
        data: { participant: "bob", error: { error: "InvalidKey: Decryption failed" } },
      },
    ]);
  });

  it("names the sender and the error for an encryption failure that degrades the call", () => {
    const logs = captureLogs();
    const h = build();
    const bob = { identity: "bob", isLocal: false } as Participant;

    h.handlers.handleEncryptionError(new Error("native decrypt failure"), bob);
    expectConsole("error", /LiveKit E2EE encryption error/);

    expect(logs.find("LiveKit E2EE encryption error — call may not be secured")).toMatchObject([
      {
        level: "error",
        component: COMPONENT,
        data: { participant: "bob", error: { error: "native decrypt failure" } },
      },
    ]);
  });
});
