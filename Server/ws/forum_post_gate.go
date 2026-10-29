package ws

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// Forum posts and clients without the forums feature. A client
// that never declared "forums" is sent no forum (client_features.go), and so
// must not be sent anything for a forum's posts either: not a thread_changed
// on the forum's topic, not a chat_message on a post's topic, not the unread
// hints and badges that name a post. A post is a thread whose parent is a
// forum, told apart by the parent's type, never by the missing starter.
//
// Subscriptions are the first line: a socket without the feature cannot hold a
// forum's topic (channel_focus) or a post's (thread_focus), so nothing sent to
// those topics reaches it. The targeted frames that do not ride a topic
// (channel_activity, mention_count) and reconnect replay check it directly.

// channelGetter is the one lookup these checks need.
type channelGetter interface {
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
}

// isForumPost reports whether ch is a post. A parent that cannot be read counts
// as a forum: the callers only use the answer to withhold, so a failed read
// withholds rather than leaks.
func isForumPost(ctx context.Context, g channelGetter, ch *db.Channel) bool {
	if ch == nil || !ch.IsThread() {
		return false
	}
	parent, err := g.GetChannel(ctx, ch.Thread.ParentID)
	if err != nil {
		slog.Warn("ws: forum post check could not read the parent, withholding", "thread_id", ch.ID, "err", err)
		return true
	}
	return parent == nil || parent.Type == channelTypeForum
}

// isForumScoped reports whether ch is a forum or one of its posts: the
// channels a socket without the forums feature is sent nothing about. It is the
// channel-level half of withholdsForumPost, for a loop over many recipients to
// decide once per channel (a failed parent read counts as a post, as in
// isForumPost, and costs one lookup rather than one per recipient).
func isForumScoped(ctx context.Context, g channelGetter, ch *db.Channel) bool {
	return ch != nil && (ch.Type == channelTypeForum || isForumPost(ctx, g, ch))
}

// lacksForums reports whether c is a live socket that never declared forums.
func lacksForums(c *Client) bool { return c != nil && !c.features.forums }

// withholdsForumPost reports whether a socket with c's features must not be
// sent frames for ch because ch is a forum or one of its posts. A client that
// declared the feature costs no lookup.
func withholdsForumPost(ctx context.Context, g channelGetter, c *Client, ch *db.Channel) bool {
	if c == nil || c.features.forums || ch == nil {
		return false
	}
	return ch.Type == channelTypeForum || isForumPost(ctx, g, ch)
}

// refusesForumTopic reports, before a topic is subscribed, whether c must not
// hold topic id: c did not declare the feature and id is a forum or one of its
// posts. Checking first leaves no window in which the socket is subscribed and a
// frame can be delivered to it; the post-subscribe re-validation in the apply
// functions stays as the backstop. A failed channel read answers false (the
// apply functions' own re-validation then decides), because refusing on a
// transient error would silently kill an old client's message stream.
func (h *Hub) refusesForumTopic(c *Client, id int64) bool {
	if c.features.forums {
		return false
	}
	ch, err := h.readers.Dispatch.GetChannel(c.ctx, id)
	if err != nil || ch == nil {
		return false
	}
	return withholdsForumPost(c.ctx, h.readers.Dispatch, c, ch)
}

// dropForumChannels removes every forum from the replay sets of a socket that
// did not declare the feature, so a reconnect replays no thread_changed that
// was sequenced on a forum's topic. Posts are not listed in the sets (a post
// is admitted only through the socket's held slot, which refuses them).
func (h *Hub) dropForumChannels(ctx context.Context, database VisibilityReader, c *Client, sets ...map[int64]bool) error {
	if c.features.forums {
		return nil
	}
	channels, err := database.ListChannels(ctx)
	if err != nil {
		return err
	}
	for i := range channels {
		if channels[i].Type != channelTypeForum {
			continue
		}
		for _, set := range sets {
			delete(set, channels[i].ID)
		}
	}
	return nil
}
