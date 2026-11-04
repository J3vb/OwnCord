// Package lockrank holds the rank types of the ws lock order, one per rank of
// the table in ws/lock_order.go. Each is the R of the syncutil.Ranked[R] or
// RankedRW[R] that declares a lock of that rank, so ws and its subpackages
// share one set of ranks without importing ws. The lock-rank invariant reads
// the literal each Rank method returns, so keep it a literal.
package lockrank

type (
	VoiceMember struct{} // userLockEntry.mu of voiceRegistry.voiceMember
	VoiceMod    struct{} // userLockEntry.mu of hubVoice.mod
	Serialiser  struct{} // the rank-3 serialisers
	Feed        struct{} // timeoutViewState.mu, presenceFeedState.mu
	Seq         struct{} // Hub.seqMu
	HubCache    struct{} // hubVoice.keyHolderMu, hubSettings.mu
	Hub         struct{} // Hub.mu
	PubSub      struct{} // PubSub.mu
	Leaf        struct{} // the leaves
)

func (VoiceMember) Rank() int { return 1 }
func (VoiceMod) Rank() int    { return 2 }
func (Serialiser) Rank() int  { return 3 }
func (Feed) Rank() int        { return 4 }
func (Seq) Rank() int         { return 5 }
func (HubCache) Rank() int    { return 6 }
func (Hub) Rank() int         { return 7 }
func (PubSub) Rank() int      { return 8 }
func (Leaf) Rank() int        { return 9 }
