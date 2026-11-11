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

// topicFor builds "<prefix><id>" via strconv.AppendInt: topics are built on every broadcast, so it skips
// fmt.Sprintf.
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

// channelTopicID is the inverse of ChannelTopic: the channel ID in t, or 0.
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

// PubSub provides topic-based publish/subscribe routing at O(subscribers) per broadcast.
// Subscribers are connections (*Client), not users: one account may hold several. Safe for
// concurrent use.
type PubSub struct {
	mu syncutil.RankedRW[lockRankPubSub]

	topics map[Topic]map[*Client]struct{}

	clients map[*Client]map[Topic]struct{}
}

// NewPubSub creates an empty PubSub ready for use.
func NewPubSub() *PubSub {
	return &PubSub{
		topics:  make(map[Topic]map[*Client]struct{}),
		clients: make(map[*Client]map[Topic]struct{}),
	}
}

// Subscribe registers client for topic; a no-op if already subscribed.
func (ps *PubSub) Subscribe(client *Client, topic Topic) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// A dying connection must not (re-)take a topic: registerNow closes the old client's send
	// BEFORE stripping it under this lock, so a late Subscribe is refused here or removed by the
	// subsequent UnsubscribeAll; otherwise the dead connection keeps a subscription for good.
	if client.isSendClosed() {
		return
	}

	subs, ok := ps.topics[topic]
	if !ok {
		subs = make(map[*Client]struct{})
		ps.topics[topic] = subs
	}
	subs[client] = struct{}{}

	ts, ok := ps.clients[client]
	if !ok {
		ts = make(map[Topic]struct{})
		ps.clients[client] = ts
	}
	ts[topic] = struct{}{}
}

// Unsubscribe removes client from the given topic; a no-op if not subscribed.
func (ps *PubSub) Unsubscribe(client *Client, topic Topic) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.unsubscribeLocked(client, topic)
}

// unsubscribeLocked removes client from topic; the caller holds ps.mu (write). Entries are
// per connection, so another device of the same user only strips its own.
func (ps *PubSub) unsubscribeLocked(client *Client, topic Topic) {
	if subs, ok := ps.topics[topic]; ok {
		delete(subs, client)
		if len(subs) == 0 {
			delete(ps.topics, topic)
		}
	}

	if ts, ok := ps.clients[client]; ok {
		delete(ts, topic)
		if len(ts) == 0 {
			delete(ps.clients, client)
		}
	}
}

// UnsubscribeAll removes client from every topic, on disconnect.
func (ps *PubSub) UnsubscribeAll(client *Client) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	for topic := range ps.clients[client] {
		ps.unsubscribeLocked(client, topic)
	}
}

// Priority levels for pub/sub delivery. DMs and direct mentions bypass PubSub (Hub.SendToUserHigh), so there
// is no PriorityHigh.
const (
	PriorityNormal = 1 // chat messages, reactions, channel events
	PriorityLow    = 2 // typing indicators — dropped on overflow
	// PriorityPresence rides the normal queue but drops instead of disconnecting on overflow.
	PriorityPresence = 3
)

// Publish sends msg to all subscribers of topic at normal priority; a client with a full buffer is
// disconnected.
func (ps *PubSub) Publish(topic Topic, msg []byte, excludeUserID int64) int {
	return ps.publishWithPriority(topic, msg, excludeUserID, PriorityNormal, nil)
}

// PublishFiltered is Publish narrowed to subscribers allow approves (the NSFW gate). The
// subscriber list is read fresh under the caller's lock, never resolved earlier: it would go
// stale across a concurrent reconnect.
func (ps *PubSub) PublishFiltered(topic Topic, msg []byte, allow func(userID int64) bool) int {
	return ps.publishWithPriority(topic, msg, 0, PriorityNormal, allow)
}

// PublishLow sends msg at low priority (typing, presence); a full buffer drops it silently.
func (ps *PubSub) PublishLow(topic Topic, msg []byte, excludeUserID int64) int {
	return ps.publishWithPriority(topic, msg, excludeUserID, PriorityLow, nil)
}

// PublishGlobal sends msg to every client on the "global" topic at normal priority.
func (ps *PubSub) PublishGlobal(msg []byte) int {
	return ps.Publish(TopicGlobal, msg, 0)
}

// publishWithPriority routes to the client send method for priority; allow, when non-nil, drops subscribers
// it rejects.
func (ps *PubSub) publishWithPriority(topic Topic, msg []byte, excludeUserID int64, priority int, allow func(userID int64) bool) int {
	ps.mu.RLock()
	subs := ps.topics[topic]
	// Snapshot under the read lock: sendMsg takes the client's own mutex.
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

// TopicsForUser returns the union of topics every connection of userID is subscribed to. A full scan: tests
// and debugging only.
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

// TopicsForClient returns the topics a client is subscribed to; debugging and tests.
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
