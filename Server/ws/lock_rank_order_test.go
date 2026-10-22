package ws

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// TestRank_TableOrder: the rank types, listed outermost first as lock_order.go
// documents them, carry strictly increasing ranks. It runs in every build, so
// a rank renumbered out of order fails without the deadlock tag.
func TestRank_TableOrder(t *testing.T) {
	ranks := []syncutil.LockRank{
		lockRankVoiceMember{}, lockRankVoiceMod{}, lockRankSerialiser{}, lockRankFeed{},
		lockRankSeq{}, lockRankHubCache{}, lockRankHub{}, lockRankPubSub{}, lockRankLeaf{},
	}
	for i := 1; i < len(ranks); i++ {
		if prev, cur := ranks[i-1].Rank(), ranks[i].Rank(); cur <= prev {
			t.Errorf("%T rank %d is not after %T rank %d", ranks[i], cur, ranks[i-1], prev)
		}
	}
}
