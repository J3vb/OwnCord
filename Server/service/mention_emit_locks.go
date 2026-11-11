package service

import "github.com/J3vb/OwnCord/Server/syncutil"

// mentionEmitStripes is how many locks mention_count and read-pointer writes spread over;
// channels sharing a stripe wait on each other, rare at 64, without a map to grow and shrink.
const mentionEmitStripes = 64

// mentionEmitLocks orders each mention_count write and read-pointer move with its frame,
// per channel (badge frames must arrive in commit order), so mark_read on one channel
// never waits for a flush on another. A holder takes exactly one stripe: no lock order among stripes.
type mentionEmitLocks struct {
	stripes [mentionEmitStripes]syncutil.Mutex
}

func (l *mentionEmitLocks) forChannel(channelID int64) *syncutil.Mutex {
	i := channelID % mentionEmitStripes
	if i < 0 {
		i = -i
	}
	return &l.stripes[i]
}
