package ws

import (
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Topic is a named pub/sub channel that clients can subscribe to.
// Naming convention:
//
//	"global"       – all clients, subscribed on connect
//	"channel:42"   – text channel messages
//	"voice:7"      – voice channel events
//	"user:123"     – per-user direct events (DMs, mentions)
type Topic string

// TopicGlobal is the well-known topic every client subscribes to on connect.
const TopicGlobal Topic = "global"

// topicFor builds "<prefix><id>" via strconv.AppendInt — topics are built on
// every broadcast and subscription change, so skip fmt.Sprintf's overhead.
func topicFor(prefix string, id int64) Topic {
	b := make([]byte, 0, len(prefix)+20)
	b = append(b, prefix...)
	b = strconv.AppendInt(b, id, 10)
	return Topic(b)
}

// ChannelTopic returns the topic for a text channel.
func ChannelTopic(channelID int64) Topic {
	return topicFor("channel:", channelID)
}

// channelTopicID is the inverse of ChannelTopic: it returns the channel ID
// encoded in t, or 0 if t is not a text-channel topic.
func channelTopicID(t Topic) int64 {
	rest, ok := strings.CutPrefix(string(t), "channel:")
	if !ok {
		return 0
	}
	id, err := strconv.ParseInt(rest, 10, 64)
	if err != nil {
		return 0
	}
	return id
}

// VoiceTopic returns the topic for a voice channel.
func VoiceTopic(channelID int64) Topic {
	return topicFor("voice:", channelID)
}

// UserTopic returns the per-user topic for DMs and mentions.
func UserTopic(userID int64) Topic {
	return topicFor("user:", userID)
}

// PubSub provides topic-based publish/subscribe routing for WebSocket clients.
// Broadcasting to a topic costs O(subscribers) instead of O(all connections).
// Subscribers are connections (*Client), not users: one account may hold
// several (one per device session), and each is subscribed on its own.
//
// Thread-safe: all methods may be called from any goroutine.
type PubSub struct {
	mu syncutil.RankedRW[lockRankPubSub]

	// Forward index: topic → set of subscribed connections
	topics map[Topic]map[*Client]struct{}

	// Reverse index: connection → set of topics (for efficient UnsubscribeAll)
	clients map[*Client]map[Topic]struct{}
}

// NewPubSub creates an empty PubSub ready for use.
func NewPubSub() *PubSub {
	return &PubSub{
		topics:  make(map[Topic]map[*Client]struct{}),
		clients: make(map[*Client]map[Topic]struct{}),
	}
}

// Subscribe registers client for messages on the given topic.
// If the client is already subscribed, this is a no-op.
func (ps *PubSub) Subscribe(client *Client, topic Topic) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// A dying connection must not (re-)take a topic: registerNow closes the
	// old client's send BEFORE stripping it under this same lock, so a late
	// Subscribe either sees sendClosed here and is refused, or slipped in
	// earlier and is removed by the subsequent UnsubscribeAll. Without the
	// refusal the dead connection would keep a subscription (and its entry in
	// both indexes) for good.
	if client.isSendClosed() {
		return
	}

	// Forward index
	subs, ok := ps.topics[topic]
	if !ok {
		subs = make(map[*Client]struct{})
		ps.topics[topic] = subs
	}
	subs[client] = struct{}{}

	// Reverse index
	ts, ok := ps.clients[client]
	if !ok {
		ts = make(map[Topic]struct{})
		ps.clients[client] = ts
	}
	ts[topic] = struct{}{}
}

// Unsubscribe removes client from the given topic.
// No-op if the client is not subscribed.
func (ps *PubSub) Unsubscribe(client *Client, topic Topic) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.unsubscribeLocked(client, topic)
}

// unsubscribeLocked removes client from topic. Caller must hold ps.mu (write).
//
// Subscribers are keyed by connection, so a client that has already been
// replaced (same session, newer socket) or is a different device of the same
// user can only ever strip its own entries; the other connections of the user
// keep theirs.
func (ps *PubSub) unsubscribeLocked(client *Client, topic Topic) {
	// Forward index
	if subs, ok := ps.topics[topic]; ok {
		delete(subs, client)
		if len(subs) == 0 {
			delete(ps.topics, topic)
		}
	}

	// Reverse index
	if ts, ok := ps.clients[client]; ok {
		delete(ts, topic)
		if len(ts) == 0 {
			delete(ps.clients, client)
		}
	}
}

// UnsubscribeAll removes client from every topic it is subscribed to.
// Called when a client disconnects. Deleting a key during range is defined, and
// unsubscribeLocked drops the reverse-index entry once the last topic goes.
func (ps *PubSub) UnsubscribeAll(client *Client) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	for topic := range ps.clients[client] {
		ps.unsubscribeLocked(client, topic)
	}
}

// Priority levels for pub/sub delivery. DMs and direct mentions go through
// Hub.SendToUserHigh -> Client.sendHighMsg directly, not through PubSub, so
// there is no PriorityHigh here.
const (
	PriorityNormal = 1 // chat messages, reactions, channel events
	PriorityLow    = 2 // typing indicators — dropped on overflow
	// PriorityPresence rides the normal queue but drops instead of
	// disconnecting on overflow (Client.sendPresenceMsg).
	PriorityPresence = 3
)

// Publish sends msg to all subscribers of topic at normal priority.
// If a client's buffer is full, it is disconnected.
func (ps *PubSub) Publish(topic Topic, msg []byte, excludeUserID int64) int {
	return ps.publishWithPriority(topic, msg, excludeUserID, PriorityNormal, nil)
}

// PublishFiltered is Publish narrowed to subscribers allow approves (B5-7's
// NSFW gate): the subscriber list is read fresh, right here, under whatever
// lock the caller already holds — never a list resolved earlier and handed
// in, which is exactly what would go stale across a concurrent reconnect.
func (ps *PubSub) PublishFiltered(topic Topic, msg []byte, allow func(userID int64) bool) int {
	return ps.publishWithPriority(topic, msg, 0, PriorityNormal, allow)
}

// PublishLow sends msg at low priority (typing, presence).
// If a client's buffer is full the message is silently dropped.
func (ps *PubSub) PublishLow(topic Topic, msg []byte, excludeUserID int64) int {
	return ps.publishWithPriority(topic, msg, excludeUserID, PriorityLow, nil)
}

// PublishGlobal sends msg to every client subscribed to the "global" topic
// at normal priority.
func (ps *PubSub) PublishGlobal(msg []byte) int {
	return ps.Publish(TopicGlobal, msg, 0)
}

// publishWithPriority is the core publish method routing to the appropriate
// client send method based on priority level. allow, when non-nil, drops any
// subscriber it returns false for (PublishFiltered); nil means unfiltered.
func (ps *PubSub) publishWithPriority(topic Topic, msg []byte, excludeUserID int64, priority int, allow func(userID int64) bool) int {
	ps.mu.RLock()
	subs := ps.topics[topic]
	// Snapshot the subscriber slice under read lock to avoid holding the lock
	// while calling sendMsg (which acquires the client's own mutex).
	clients := make([]*Client, 0, len(subs))
	for c := range subs {
		if c.userID == excludeUserID {
			continue
		}
		if allow != nil && !allow(c.userID) {
			continue
		}
		clients = append(clients, c)
	}
	ps.mu.RUnlock()

	delivered := 0
	for _, c := range clients {
		switch priority {
		case PriorityLow:
			c.sendLowMsg(msg)
			delivered++ // count attempt, even if dropped
		case PriorityPresence:
			c.sendPresenceMsg(msg)
			delivered++
		default:
			c.sendMsg(msg)
			delivered++
		}
	}
	return delivered
}

// subscribers snapshots topic's subscribers, minus excludeUserID.
func (ps *PubSub) subscribers(topic Topic, excludeUserID int64) []*Client {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	clients := make([]*Client, 0, len(ps.topics[topic]))
	for c := range ps.topics[topic] {
		if c.userID != excludeUserID {
			clients = append(clients, c)
		}
	}
	return clients
}

// SubscriberCount returns the number of subscribed connections for a topic.
func (ps *PubSub) SubscriberCount(topic Topic) int {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	return len(ps.topics[topic])
}

// TopicsForUser returns the union of the topics every connection of userID is
// subscribed to, each once. A scan over all subscriptions: for tests and
// debugging, not a hot path.
func (ps *PubSub) TopicsForUser(userID int64) []Topic {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	seen := map[Topic]struct{}{}
	for c, ts := range ps.clients {
		if c.userID != userID {
			continue
		}
		for t := range ts {
			seen[t] = struct{}{}
		}
	}
	result := make([]Topic, 0, len(seen))
	for t := range seen {
		result = append(result, t)
	}
	return result
}

// TopicsForClient returns the set of topics a client is subscribed to.
// Intended for debugging and tests.
func (ps *PubSub) TopicsForClient(client *Client) []Topic {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	ts := ps.clients[client]
	result := make([]Topic, 0, len(ts))
	for t := range ts {
		result = append(result, t)
	}
	return result
}
