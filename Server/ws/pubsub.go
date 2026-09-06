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
//
// Thread-safe: all methods may be called from any goroutine.
type PubSub struct {
	mu syncutil.RWMutex

	// Forward index: topic → (userID → *Client)
	topics map[Topic]map[int64]*Client

	// Reverse index: userID → set of topics (for efficient UnsubscribeAll)
	clients map[int64]map[Topic]struct{}
}

// NewPubSub creates an empty PubSub ready for use.
func NewPubSub() *PubSub {
	return &PubSub{
		topics:  make(map[Topic]map[int64]*Client),
		clients: make(map[int64]map[Topic]struct{}),
	}
}

// Subscribe registers client for messages on the given topic.
// If the client is already subscribed, this is a no-op.
func (ps *PubSub) Subscribe(client *Client, topic Topic) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// A dying connection must not (re-)take a topic: its replacement's own
	// unsubscribes would skip the entry (unsubscribeLocked's identity guard)
	// and publishes would go to the closed connection. registerNow closes the
	// old client's send BEFORE stripping it under this same lock, so a late
	// Subscribe either sees sendClosed here and is refused, or slipped in
	// earlier and is removed by the subsequent UnsubscribeAll.
	if client.isSendClosed() {
		return
	}

	// Forward index
	subs, ok := ps.topics[topic]
	if !ok {
		subs = make(map[int64]*Client)
		ps.topics[topic] = subs
	}
	subs[client.userID] = client

	// Reverse index
	ts, ok := ps.clients[client.userID]
	if !ok {
		ts = make(map[Topic]struct{})
		ps.clients[client.userID] = ts
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
// Both indexes are keyed by userID, but a reconnect registers a *new* *Client
// under that same userID. Unsubscribing a client that has already been replaced
// must be a no-op: the replacement stays in h.clients and keeps answering
// ping/pong, so if its subscriptions were stripped it would never reconnect —
// it would just silently stop receiving every broadcast.
func (ps *PubSub) unsubscribeLocked(client *Client, topic Topic) {
	// Forward index
	if subs, ok := ps.topics[topic]; ok {
		if cur, ok := subs[client.userID]; ok && cur != client {
			return // replaced by a newer connection; leave it alone
		}
		delete(subs, client.userID)
		if len(subs) == 0 {
			delete(ps.topics, topic)
		}
	}

	// Reverse index
	if ts, ok := ps.clients[client.userID]; ok {
		delete(ts, topic)
		if len(ts) == 0 {
			delete(ps.clients, client.userID)
		}
	}
}

// UnsubscribeAll removes client from every topic it is subscribed to.
// Called when a client disconnects.
//
// Topics already taken over by a newer connection for the same user are left
// in place — see unsubscribeLocked. Deleting a key during range is defined, and
// unsubscribeLocked drops the reverse-index entry once the last topic goes.
func (ps *PubSub) UnsubscribeAll(client *Client) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	for topic := range ps.clients[client.userID] {
		ps.unsubscribeLocked(client, topic)
	}
}

// Priority levels for pub/sub delivery.
const (
	PriorityHigh   = 0 // DMs, direct mentions — drained first by writePump
	PriorityNormal = 1 // chat messages, reactions, channel events
	PriorityLow    = 2 // typing indicators, presence updates — dropped on overflow
)

// Publish sends msg to all subscribers of topic at normal priority.
// If a client's buffer is full, it is disconnected.
func (ps *PubSub) Publish(topic Topic, msg []byte, excludeUserID int64) int {
	return ps.publishWithPriority(topic, msg, excludeUserID, PriorityNormal)
}

// PublishHigh sends msg at high priority (DMs, mentions).
// High-priority messages are drained before normal/low by writePump.
func (ps *PubSub) PublishHigh(topic Topic, msg []byte, excludeUserID int64) int {
	return ps.publishWithPriority(topic, msg, excludeUserID, PriorityHigh)
}

// PublishLow sends msg at low priority (typing, presence).
// If a client's buffer is full the message is silently dropped.
func (ps *PubSub) PublishLow(topic Topic, msg []byte, excludeUserID int64) int {
	return ps.publishWithPriority(topic, msg, excludeUserID, PriorityLow)
}

// PublishGlobal sends msg to every client subscribed to the "global" topic
// at normal priority.
func (ps *PubSub) PublishGlobal(msg []byte) int {
	return ps.Publish(TopicGlobal, msg, 0)
}

// PublishGlobalLow sends msg to all global subscribers at low priority.
func (ps *PubSub) PublishGlobalLow(msg []byte) int {
	return ps.PublishLow(TopicGlobal, msg, 0)
}

// publishWithPriority is the core publish method routing to the appropriate
// client send method based on priority level.
func (ps *PubSub) publishWithPriority(topic Topic, msg []byte, excludeUserID int64, priority int) int {
	ps.mu.RLock()
	subs := ps.topics[topic]
	// Snapshot the subscriber slice under read lock to avoid holding the lock
	// while calling sendMsg (which acquires the client's own mutex).
	clients := make([]*Client, 0, len(subs))
	for uid, c := range subs {
		if uid != excludeUserID {
			clients = append(clients, c)
		}
	}
	ps.mu.RUnlock()

	delivered := 0
	for _, c := range clients {
		switch priority {
		case PriorityHigh:
			c.sendHighMsg(msg)
			delivered++
		case PriorityLow:
			c.sendLowMsg(msg)
			delivered++ // count attempt, even if dropped
		default:
			c.sendMsg(msg)
			delivered++
		}
	}
	return delivered
}

// SubscriberCount returns the number of subscribers for a topic.
func (ps *PubSub) SubscriberCount(topic Topic) int {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	return len(ps.topics[topic])
}

// SubscriberIDs returns the user ids currently subscribed to topic. Used by
// B5-7's content-audience resolution (ws/hub_visibility.go), which narrows a
// content-bearing broadcast to the same live audience Publish would already
// reach — never wider — before filtering it by CanReadContent.
func (ps *PubSub) SubscriberIDs(topic Topic) []int64 {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	subs := ps.topics[topic]
	ids := make([]int64, 0, len(subs))
	for uid := range subs {
		ids = append(ids, uid)
	}
	return ids
}

// TopicsForClient returns the set of topics a client is subscribed to.
// Intended for debugging and tests.
func (ps *PubSub) TopicsForClient(userID int64) []Topic {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	ts := ps.clients[userID]
	result := make([]Topic, 0, len(ts))
	for t := range ts {
		result = append(result, t)
	}
	return result
}
