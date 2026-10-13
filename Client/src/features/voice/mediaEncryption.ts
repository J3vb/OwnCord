// Remote media must be end-to-end encrypted to be played. LiveKit reads each
// remote track's encryption from the server's TrackInfo and, for NONE, hands
// the frames to the decoder unchanged, so a publication that says NONE is
// never subscribed or attached. A missing TrackInfo is not NONE: the E2EE
// worker then has no state for the track and drops its frames.
import type { TrackPublication } from "livekit-client";

/** `Encryption_Type.NONE`, inlined so modules that mock livekit-client keep working. */
const ENCRYPTION_NONE = 0;

export function isUnencryptedPublication(publication: TrackPublication): boolean {
  return publication.trackInfo?.encryption === ENCRYPTION_NONE;
}
