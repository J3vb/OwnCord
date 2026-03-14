---
name: websocket-protocol
description: Patterns for implementing the WebSocket hub, client connections, message routing, and real-time features. Use this skill when working on the WebSocket server (ws/ package), client-side WebSocket connection, message broadcasting, typing indicators, presence tracking, reconnection logic, or any real-time messaging feature. Trigger when the user mentions WebSocket, hub, broadcast, real-time, typing, presence, reconnect, or message delivery. Also use when debugging message delivery issues or connection drops.
---

# WebSocket Hub Patterns

## Server Hub Architecture

```
                    ┌─────────────┐
                    │     Hub     │
                    │  (1 per     │
                    │   server)   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴─────┐ ┌───┴─────┐
        │ Client A  │ │Client B │ │Client C │
        │ (2 gorout)│ │         │ │         │
        │ read|write│ │         │ │         │
        └───────────┘ └─────────┘ └─────────┘
```

Each WebSocket connection gets:
- 1 read goroutine (reads messages from client, sends to hub)
- 1 write goroutine (reads from a channel, writes to WebSocket)

The Hub is the central router. It holds all connections and their channel subscriptions.

## Hub Implementation (Go)

```go
type Hub struct {
    clients    map[int]*Client         // user_id -> client
    channels   map[int]map[int]bool    // channel_id -> set of user_ids
    register   chan *Client
    unregister chan *Client
    broadcast  chan BroadcastMsg
    db         *db.DB
    mu         sync.RWMutex
}

type Client struct {
    UserID     int
    Conn       *websocket.Conn
    Send       chan []byte    // buffered channel, write goroutine reads from this
    Hub        *Hub
    Channels   map[int]bool  // channels this client is subscribed to
}

type BroadcastMsg struct {
    ChannelID int             // 0 = broadcast to all
    Exclude   int             // user_id to exclude (sender)
    Data      []byte
}

func (h *Hub) Run() {
    for {
        select {
        case client := <-h.register:
            h.mu.Lock()
            h.clients[client.UserID] = client
            h.mu.Unlock()
            h.broadcastPresence(client.UserID, "online")

        case client := <-h.unregister:
            h.mu.Lock()
            delete(h.clients, client.UserID)
            h.mu.Unlock()
            close(client.Send)
            h.broadcastPresence(client.UserID, "offline")

        case msg := <-h.broadcast:
            h.mu.RLock()
            if msg.ChannelID == 0 {
                // Broadcast to all connected clients
                for uid, client := range h.clients {
                    if uid != msg.Exclude {
                        select {
                        case client.Send <- msg.Data:
                        default:
                            // Client send buffer full, drop message
                        }
                    }
                }
            } else {
                // Broadcast to channel subscribers
                for uid := range h.channels[msg.ChannelID] {
                    if uid != msg.Exclude {
                        if client, ok := h.clients[uid]; ok {
                            select {
                            case client.Send <- msg.Data:
                            default:
                            }
                        }
                    }
                }
            }
            h.mu.RUnlock()
        }
    }
}
```

## Client Read/Write Goroutines

```go
// Read goroutine: reads from WebSocket, dispatches to handler
func (c *Client) ReadPump() {
    defer func() {
        c.Hub.unregister <- c
        c.Conn.Close()
    }()
    c.Conn.SetReadLimit(maxMessageSize) // 64KB
    c.Conn.SetReadDeadline(time.Now().Add(pongWait))
    c.Conn.SetPongHandler(func(string) error {
        c.Conn.SetReadDeadline(time.Now().Add(pongWait))
        return nil
    })
    for {
        _, message, err := c.Conn.ReadMessage()
        if err != nil {
            break
        }
        c.Hub.handleMessage(c, message)
    }
}

// Write goroutine: reads from Send channel, writes to WebSocket
func (c *Client) WritePump() {
    ticker := time.NewTicker(pingPeriod) // 30 seconds
    defer func() {
        ticker.Stop()
        c.Conn.Close()
    }()
    for {
        select {
        case message, ok := <-c.Send:
            if !ok {
                c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }
            c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
            c.Conn.WriteMessage(websocket.TextMessage, message)

        case <-ticker.C:
            c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
            c.Conn.WriteMessage(websocket.PingMessage, nil)
        }
    }
}
```

## Message Routing

```go
func (h *Hub) handleMessage(client *Client, raw []byte) {
    var msg struct {
        Type    string          `json:"type"`
        ID      string          `json:"id"`
        Payload json.RawMessage `json:"payload"`
    }
    if err := json.Unmarshal(raw, &msg); err != nil {
        client.sendError(msg.ID, "INVALID_INPUT", "Invalid JSON")
        return
    }

    // Rate limiting per message type
    if !h.rateLimiter.Allow(client.UserID, msg.Type) {
        client.sendError(msg.ID, "RATE_LIMITED", "Slow down")
        return
    }

    switch msg.Type {
    case "chat_send":
        h.handleChatSend(client, msg.ID, msg.Payload)
    case "chat_edit":
        h.handleChatEdit(client, msg.ID, msg.Payload)
    case "chat_delete":
        h.handleChatDelete(client, msg.ID, msg.Payload)
    case "typing_start":
        h.handleTyping(client, msg.Payload)
    case "presence_update":
        h.handlePresence(client, msg.Payload)
    case "reaction_add", "reaction_remove":
        h.handleReaction(client, msg.ID, msg.Type, msg.Payload)
    case "voice_join":
        h.handleVoiceJoin(client, msg.Payload)
    case "voice_leave":
        h.handleVoiceLeave(client)
    case "voice_offer", "voice_answer", "voice_ice":
        h.handleVoiceSignal(client, msg.Type, msg.Payload)
    case "voice_mute", "voice_deafen":
        h.handleVoiceControl(client, msg.Type, msg.Payload)
    case "soundboard_play":
        h.handleSoundboard(client, msg.Payload)
    default:
        client.sendError(msg.ID, "INVALID_INPUT", "Unknown message type")
    }
}
```

## Chat Send Handler (example)

```go
func (h *Hub) handleChatSend(client *Client, reqID string, payload json.RawMessage) {
    var input struct {
        ChannelID   int      `json:"channel_id"`
        Content     string   `json:"content"`
        ReplyTo     *int     `json:"reply_to"`
        Attachments []string `json:"attachments"`
    }
    json.Unmarshal(payload, &input)

    // 1. Permission check
    if !client.User.HasChannelPermission(input.ChannelID, PermSendMessages, h.db) {
        client.sendError(reqID, "FORBIDDEN", "Cannot send messages here")
        return
    }

    // 2. Sanitize
    input.Content = sanitize(input.Content)
    if len(input.Content) == 0 && len(input.Attachments) == 0 {
        client.sendError(reqID, "INVALID_INPUT", "Message cannot be empty")
        return
    }
    if len(input.Content) > 2000 {
        client.sendError(reqID, "INVALID_INPUT", "Message too long")
        return
    }

    // 3. Store in database
    msg, err := h.db.CreateMessage(input.ChannelID, client.UserID, input.Content, input.ReplyTo, input.Attachments)
    if err != nil {
        client.sendError(reqID, "SERVER_ERROR", "Failed to save message")
        return
    }

    // 4. Send ack to sender
    client.sendJSON(map[string]interface{}{
        "type": "chat_send_ok", "id": reqID,
        "payload": map[string]interface{}{"message_id": msg.ID, "timestamp": msg.Timestamp},
    })

    // 5. Broadcast to channel (excluding sender)
    h.broadcastToChannel(input.ChannelID, client.UserID, map[string]interface{}{
        "type": "chat_message", "payload": msg,
    })

    // 6. Update read states and mention counts
    h.db.UpdateReadStates(input.ChannelID, msg.ID, input.Content)
}
```

## Client Reconnection (client-side)

```
State machine:
  CONNECTED → (connection lost) → RECONNECTING → (success) → CONNECTED
                                        ↓ (failure)
                                  RECONNECTING (retry with backoff)
                                        ↓ (max retries or auth expired)
                                  DISCONNECTED (show login)

Backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s...
On reconnect success:
  1. Re-authenticate with stored token
  2. Server sends new "ready" payload with current state
  3. Client requests missed messages: GET /api/channels/{id}/messages?after={last_id}
  4. Client merges missed messages into local scrollback
  5. Update presence and unread counts

Track last_received_message_id per channel to know what was missed.
```

## Rate Limits (enforced server-side)

```
chat_send:       10 per second per user
typing_start:    1 per 3 seconds per user per channel
presence_update: 1 per 10 seconds per user
reaction_*:      5 per second per user
voice_*:         20 per second per user (signaling can be bursty)
soundboard_play: 1 per 3 seconds per user

Implementation: token bucket per (user_id, message_type).
On limit hit: send error with retry_after seconds, don't process the message.
```

## Constants

```go
const (
    maxMessageSize = 65536     // 64KB max WebSocket message
    writeWait      = 10 * time.Second
    pongWait       = 60 * time.Second
    pingPeriod     = 30 * time.Second  // must be < pongWait
    maxChatLength  = 2000              // characters
    sendBufferSize = 256               // messages in client Send channel
)
```
