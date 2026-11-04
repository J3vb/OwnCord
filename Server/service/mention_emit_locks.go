package service

import "github.com/J3vb/OwnCord/Server/syncutil"

// mentionEmitStripes is how many locks the mention_count and read-pointer
// writes spread over. Channels that share a stripe still wait on each other;
// 64 keeps that rare without a map that must grow and shrink with the channel
// list.
const mentionEmitStripes = 64

// mentionEmitLocks orders each mention_count write and read-pointer move with
// the frame it sends, per channel. The ordering a reader needs is per channel
// (a channel's badge frames must arrive in commit order), so a mark_read on one
// channel never waits for a mention flush on another. A holder takes exactly
// one stripe and never a second, so stripes have no order among themselves.
type mentionEmitLocks struct {
	stripes [mentionEmitStripes]syncutil.Mutex
}

// forChannel returns the lock that orders channelID's writes and frames.
func (l *mentionEmitLocks) forChannel(channelID int64) *syncutil.Mutex {
	i := channelID % mentionEmitStripes
	if i < 0 {
		i = -i
	}
	return &l.stripes[i]
}
