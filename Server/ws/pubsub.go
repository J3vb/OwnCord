package ws

import (
	"fmt"
	"log/slog"
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

// Publish sends msg to all subscribers of topic, except the client identified
// by excludeUserID (pass 0 to exclude nobody). Returns the number of clients
// the message was delivered to.
func (ps *PubSub) Publish(topic Topic, msg []byte, excludeUserID int64) int {
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

	for _, c := range clients {
		c.sendMsg(msg)
	}
	return len(clients)
}

// PublishGlobal sends msg to every client subscribed to the "global" topic.
// This is equivalent to Publish(TopicGlobal, msg, 0) but makes intent explicit.
func (ps *PubSub) PublishGlobal(msg []byte) int {
	return ps.Publish(TopicGlobal, msg, 0)
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

// debugDump logs the current subscription state. For development use only.
func (ps *PubSub) debugDump() {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	for topic, subs := range ps.topics {
		ids := make([]int64, 0, len(subs))
		for uid := range subs {
			ids = append(ids, uid)
		}
		slog.Debug("pubsub: topic", "topic", string(topic), "subscribers", ids)
	}
}
