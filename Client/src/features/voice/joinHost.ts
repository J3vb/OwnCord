// The collaborator surface JoinOrchestration reads from LiveKitSession. Split
// from joinOrchestration.ts so the join helper modules can share the type.
import type { Room } from "livekit-client";
import type { AudioPipeline } from "../../lib/voice/audioPipeline";
import type { AudioElements } from "../../lib/voice/audioElements";
import type { DeviceManager } from "../../lib/voice/deviceManager";
import type { E2EEManager } from "../../lib/voice/livekitE2EE";
import type { SessionState } from "./sessionState";

/** Everything the join orchestration needs from LiveKitSession. Collaborators
 *  are read through getters on every use, never captured, so the session (and
 *  the suites that reach into it) stay the single owner of each one. */
export interface JoinHost {
  getState(): SessionState;
  setState(next: SessionState): void;
  /** Draw the next value from the session's monotonic join-generation counter. */
  nextJoinGeneration(): number;
  getRoom(): Room | null;
  getE2EE(): Pick<
    E2EEManager,
    "clearState" | "setupKeyExchange" | "holdAnnouncesForQueuedJoin" | "releaseHeldAnnounces"
  >;
  getAudioPipeline(): AudioPipeline;
  getAudioElements(): AudioElements;
  getDeviceManager(): DeviceManager;
  getOnError(): ((message: string) => void) | null;
  createRoom(channelId: number): Promise<Room>;
  resolveLiveKitUrl(proxyPath: string, directUrl?: string): Promise<string>;
  restoreLocalVoiceState(mode: "join"): Promise<void>;
  reapplyMuteGain(): void;
  /** Tell the server our own mute/deafen: a fresh join writes its row clean. */
  restateSelfVoiceState(): void;
  startTokenRefreshTimer(): void;
  syncModuleRooms(): void;
  leaveVoice(sendWs: boolean, keepWatched?: boolean): void;
  /** Offer the adopted room's already-published streams (Watch stream tiles). */
  sweepPublications(room: Room): void;
  handleVoiceTokenRefresh(token: string): void;
  /** The session's own connectAndSetup, so the drain loop re-enters through it. */
  connectAndSetup(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
    isKeyHolder?: boolean,
  ): Promise<boolean | "superseded">;
}
