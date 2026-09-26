// Voice session state types and pure helpers — extracted from livekitSession.ts.
// A leaf module: it imports nothing at runtime, so the extracted voice modules
// (audioElements, livekitDiagnostics, roomEventHandlers) can depend on it
// without closing an import cycle through the livekitSession facade.
import type { Room } from "livekit-client";

/** Parse userId from LiveKit participant identity "user-{id}" or "user-{id}:{token}". Returns 0 if unparseable. */
export function parseUserId(identity: string): number {
  const match = identity.match(/^user-(\d+)(?::|$)/);
  if (match !== null && match[1] !== undefined) return parseInt(match[1], 10);
  return 0;
}

export type RemoteVideoCallback = (
  userId: number,
  stream: MediaStream,
  isScreenshare: boolean,
) => void;
export type RemoteVideoRemovedCallback = (userId: number, isScreenshare: boolean) => void;
export type PendingVoiceJoin = {
  readonly token: string;
  readonly url: string;
  readonly channelId: number;
  readonly directUrl?: string;
  readonly isKeyHolder?: boolean;
};

/** Discriminated-union session state. All connection-lifecycle fields live here.
 *  The "connecting" variant also carries the BUG-142 monotonic generation counter
 *  (joinGeneration) so superseded-join detection is co-located with the state. */
export type SessionState =
  | { readonly type: "idle" }
  | {
      readonly type: "connecting";
      readonly pendingJoin: PendingVoiceJoin | null;
      readonly joinGeneration: number;
    }
  | {
      readonly type: "connected";
      readonly room: Room;
      readonly channelId: number;
      readonly latestToken: string;
      readonly lastUrl: string;
      readonly lastDirectUrl: string | undefined;
    }
  | {
      readonly type: "reconnecting";
      readonly channelId: number;
      readonly latestToken: string;
      readonly lastUrl: string;
      readonly lastDirectUrl: string | undefined;
      readonly ac: AbortController;
    };
