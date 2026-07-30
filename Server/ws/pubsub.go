package ws

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
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

// ChannelTopic returns the topic for a text channel.
func ChannelTopic(channelID int64) Topic {
	return Topic(fmt.Sprintf("channel:%d", channelID))
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
	return Topic(fmt.Sprintf("voice:%d", channelID))
}

// UserTopic returns the per-user topic for DMs and mentions.
func UserTopic(userID int64) Topic {
	return Topic(fmt.Sprintf("user:%d", userID))
}

// PubSub provides topic-based publish/subscribe routing for WebSocket clients.
// Broadcasting to a topic costs O(subscribers) instead of O(all connections).
//
// Thread-safe: all methods may be called from any goroutine.
type PubSub struct {
	mu sync.RWMutex

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
	ps.unsubscribeLocked(client.userID, topic)
}

// unsubscribeLocked removes userID from topic. Caller must hold ps.mu (write).
func (ps *PubSub) unsubscribeLocked(userID int64, topic Topic) {
	// Forward index
	if subs, ok := ps.topics[topic]; ok {
		delete(subs, userID)
		if len(subs) == 0 {
			delete(ps.topics, topic)
		}
	}

	// Reverse index
	if ts, ok := ps.clients[userID]; ok {
		delete(ts, topic)
		if len(ts) == 0 {
			delete(ps.clients, userID)
		}
	}
}

// UnsubscribeAll removes client from every topic it is subscribed to.
// Called when a client disconnects.
func (ps *PubSub) UnsubscribeAll(client *Client) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	ts, ok := ps.clients[client.userID]
	if !ok {
		return
	}

	// Remove from every topic's subscriber set.
	for topic := range ts {
		if subs, ok := ps.topics[topic]; ok {
			delete(subs, client.userID)
			if len(subs) == 0 {
				delete(ps.topics, topic)
			}
		}
	}

	// Remove the reverse-index entry entirely.
	delete(ps.clients, client.userID)
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
