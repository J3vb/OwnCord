package db

// ChannelThread is the thread half of a Channel (migration 073). A channel
// whose ParentID is 0 is not a thread. A thread row's slow mode, archive and
// NSFW fields already carry its parent's values (the channel queries merge
// them), so callers that only read those see the parent without asking.
type ChannelThread struct {
	ParentID int64
	// Archived is the thread's own idle state, not Channel.Archived: an
	// archived thread stays readable and a new message reopens it.
	Archived bool
	// Locked lets only members with MANAGE_MESSAGES post, react or pin.
	Locked bool
}

// IsThread reports whether the channel is a thread under a text channel.
func (c *Channel) IsThread() bool { return c.Thread.ParentID != 0 }

// AuthorityID is the channel whose permission overrides, NSFW consent and
// archive state govern this one: the parent for a thread, itself otherwise.
func (c *Channel) AuthorityID() int64 {
	if c.Thread.ParentID != 0 {
		return c.Thread.ParentID
	}
	return c.ID
}
