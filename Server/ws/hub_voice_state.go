package ws

import (
	"github.com/J3vb/OwnCord/Server/livekitproc"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/voicestate"
)

// hubVoice groups the hub's voice registry, reconciler, rejoin blocks,
// key-holder map, per-user moderation locks and the LiveKit process. It holds
// ranked locks, keyHolderMu and mod (see lock_order.go), and must never be
// copied.
type hubVoice struct {
	reconcile voicestate.ReconcileMisses // polling reconciler (voice_reconcile.go)
	reg       voiceRegistry              // voice membership lock and grace window (voice_registry.go)

	rejoinBlocks voicestate.RejoinBlocks // voice_rejoin_block.go

	// defaultQuality is the operator-configured voice.quality
	// (HubOptions.VoiceQuality), used by voiceJoinComplete. Always one of
	// voiceQualities' keys (NewHub normalizes it). Set once, never mutated
	// (voice.quality is startup-only), so no mutex guards it.
	defaultQuality string

	// mod is the per-target-user lock serializing a voice-moderation DB
	// transition with its paired LiveKit call (voicestate/userlocks.go). Always non-nil (made in
	// NewHub): without it the timeout path and the manual voice-mute endpoint could
	// interleave.
	mod *voicestate.UserLocks[lockRankVoiceMod]

	// keyHolders maps channelID to the current key holder (the connected
	// participant with the lowest userID). Protected by keyHolderMu.
	keyHolderMu syncutil.RankedRW[lockRankHubCache]
	keyHolders  map[int64]int64

	lkProcess *livekitproc.Process
}
