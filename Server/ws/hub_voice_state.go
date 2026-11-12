package ws

import (
	"github.com/J3vb/OwnCord/Server/livekitproc"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/voicestate"
)

// hubVoice groups the voice registry, reconciler, rejoin blocks, key-holder map, per-user
// moderation locks and the LiveKit process. It holds ranked locks (lock_order.go); never copy it.
type hubVoice struct {
	reconcile voicestate.ReconcileMisses // polling reconciler (voice_reconcile.go)
	reg       voiceRegistry              // voice membership lock and grace window (voice_registry.go)

	rejoinBlocks voicestate.RejoinBlocks // voice_rejoin_block.go

	// defaultQuality is the operator-configured voice.quality used by voiceJoinComplete, always a
	// voiceQualities key (NewHub normalizes). Startup-only, so no mutex.
	defaultQuality string

	// mod is the per-target-user lock serializing a voice-moderation DB transition with its paired
	// LiveKit call (voicestate/userlocks.go). Always non-nil; without it the timeout path and the
	// manual mute endpoint could interleave.
	mod *voicestate.UserLocks[lockRankVoiceMod]

	// keyHolders maps channelID to the connected participant with the lowest userID; protected by
	// keyHolderMu.
	keyHolderMu syncutil.RankedRW[lockRankHubCache]
	keyHolders  map[int64]int64

	lkProcess *livekitproc.Process
}
