package ws

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// Forum posts and clients without the forums feature: a client that never
// declared "forums" is sent nothing for a forum's posts either (thread_changed,
// chat_message, unread hints and badges). A post is a thread whose parent is a
// forum, told apart by the parent's type.
// Subscriptions are the first line (such a socket cannot hold a forum or post
// topic); the targeted frames that ride no topic (channel_activity,
// mention_count) and reconnect replay check directly.

type channelGetter interface {
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
}

// isForumPost reports whether ch is a post. An unreadable parent counts as a
// forum: callers only withhold, so a failed read withholds rather than leaks.
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

// isForumScoped reports whether ch is a forum or one of its posts, the channel-
// level half of withholdsForumPost for loops that decide once per channel.
func isForumScoped(ctx context.Context, g channelGetter, ch *db.Channel) bool {
	return ch != nil && (ch.Type == channelTypeForum || isForumPost(ctx, g, ch))
}

func lacksForums(c *Client) bool { return c != nil && !c.features.forums }

func withholdsForumPost(ctx context.Context, g channelGetter, c *Client, ch *db.Channel) bool {
	if c == nil || c.features.forums || ch == nil {
		return false
	}
	return ch.Type == channelTypeForum || isForumPost(ctx, g, ch)
}

// refusesForumTopic reports, before subscribing, whether c must not hold topic
// id. Checking first leaves no window where the socket is subscribed and a frame
// can reach it; the post-subscribe re-validation stays as the backstop. A failed
// read answers false, since refusing on a transient error would silently kill an
// old client's stream.
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

// dropForumChannels removes forums from a featureless socket's replay sets so a
// reconnect replays no forum thread_changed. Posts are not listed (admitted only
// through the held slot, which refuses them).
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
