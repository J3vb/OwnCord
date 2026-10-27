package ws

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// readyFields is everything one viewer's ready carries, every read done.
type readyFields struct {
	head     readyHead
	tail     readyTail
	roster   *memberRoster
	viewerID int64
	// timeoutsFull: the ready carries every active timeout (a moderator's
	// view), not just the viewer's own; becomes Client.timeouts.full.
	timeoutsFull bool
}

// readyPayload is one viewer's ready frame: the fields either side of members
// already encoded, and the shared roster that writeReady splices this
// viewer's presence into (P5-O01). Encoding first means a failure can only
// come before the first byte reaches the socket.
type readyPayload struct {
	head, tail []byte
	roster     *memberRoster
	viewerID   int64
	// timeoutsFull: see readyFields.
	timeoutsFull bool
}

// readyHead and readyTail are the payload fields before and after members,
// declared in sorted key order: ready used to be json.Marshal of a map, which
// sorts its keys, and the bytes must not change.
type readyHead struct {
	// Activities (WP 8.3a) lists the games connected members are playing, as
	// the viewer may see them. Always present; "activities" sorts before
	// "capabilities", so it is the first head field and key order holds.
	Activities   []readyActivityPayload   `json:"activities"`
	Capabilities readyCapabilitiesPayload `json:"capabilities"`
	// Categories (WP 6.5a) is the full category list, present only for a
	// MANAGE_CHANNELS/Administrator holder (a pointer so an empty list still
	// encodes as [] for them while everyone else omits the key). "categories"
	// sorts between "capabilities" and "channels", so key order holds.
	Categories *[]channelCategoryPayload `json:"categories,omitempty"`
	Channels   []map[string]any          `json:"channels"`
	DMChannels []db.DMChannelInfo        `json:"dm_channels"`
	// Listening (WP 8.10a) lists the songs connected members are listening
	// to, as the viewer may see them. Always present; "listening" sorts
	// between "dm_channels" and "member_timeouts", so key order holds.
	Listening []readyListeningPayload `json:"listening"`
	// MemberTimeouts is the viewer's member_timeouts view (WP 3C-7c); "member_timeouts"
	// sorts before "members", so it is the last head field and key order holds.
	MemberTimeouts []memberTimeoutEntry `json:"member_timeouts"`
}

type readyTail struct {
	MOTD       string               `json:"motd"`
	Notices    []readyNoticePayload `json:"notices"`
	Roles      []*db.Role           `json:"roles"`
	ServerName string               `json:"server_name"`
	// Threads (WP 6.9c) is the viewer's followed open threads, present
	// whenever the server has the thread service (a pointer so an empty list
	// still encodes as [] there while a server without it omits the key).
	// "threads" sorts between "server_name" and "voice_states".
	Threads     *[]readyThreadPayload `json:"threads,omitempty"`
	VoiceStates []db.VoiceState       `json:"voice_states"`
}

// readyThreadPayload is one followed thread of ready.threads: the thread, the
// last message in it, and the viewer's read position and counts.
type readyThreadPayload struct {
	Thread            *service.ThreadInfo `json:"thread"`
	LastMessageID     int64               `json:"last_message_id"`
	LastReadMessageID int64               `json:"last_read_message_id"`
	UnreadCount       int64               `json:"unread_count"`
	MentionCount      int64               `json:"mention_count"`
}

// writeReady writes the ready frame to w and returns its length.
func (h *Hub) writeReady(w io.Writer, p *readyPayload) (int64, error) {
	cw := &countingWriter{w: w}
	bw := bufio.NewWriterSize(cw, 8<<10)
	_, _ = bw.Write(p.head)
	h.writeReadyMembers(bw, p.roster, p.viewerID)
	_, _ = bw.Write(p.tail)
	err := bw.Flush()
	return cw.n, err
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// buildReady reads and encodes the ready server→client message.
func (h *Hub) buildReady(ctx context.Context, database ReadySnapshotReader, userID int64, role *db.Role, feat clientFeatures) (*readyPayload, error) {
	f, err := h.readReady(ctx, database, userID, role, feat)
	if err != nil {
		return nil, err
	}
	head, err := json.Marshal(f.head)
	if err != nil {
		return nil, fmt.Errorf("buildReady encode: %w", err)
	}
	tail, err := json.Marshal(f.tail)
	if err != nil {
		return nil, fmt.Errorf("buildReady encode: %w", err)
	}
	// {"payload":{<head fields>,"members":[…],<tail fields>},"type":"ready"}
	return &readyPayload{
		head:         append(append([]byte(`{"payload":`), head[:len(head)-1]...), `,"members":`...),
		tail:         append(append([]byte{','}, tail[1:len(tail)-1]...), `},"type":"`+MsgTypeReady+`"}`...),
		roster:       f.roster,
		viewerID:     f.viewerID,
		timeoutsFull: f.timeoutsFull,
	}, nil
}

// writeReadyMembers writes the ready's members array for viewerID: each
// member's cached encoding with the status and custom_status
// presentableMembers decides spliced in. The bytes are json.Marshal of
// presentableMembers' output.
func (h *Hub) writeReadyMembers(w *bufio.Writer, roster *memberRoster, viewerID int64) {
	_ = w.WriteByte('[')
	for i, m := range h.presentableMembers(roster.members, viewerID) {
		if i > 0 {
			_ = w.WriteByte(',')
		}
		enc := &roster.enc[i]
		_, _ = w.Write(enc.head)
		if db.ValidStatuses[m.Status] { // plain lowercase: nothing to escape
			_ = w.WriteByte('"')
			_, _ = w.WriteString(m.Status)
			_ = w.WriteByte('"')
		} else {
			b, _ := json.Marshal(m.Status)
			_, _ = w.Write(b)
		}
		_, _ = w.Write(enc.mid)
		if m.CustomStatus == nil {
			_, _ = w.WriteString("null")
		} else {
			_, _ = w.Write(enc.custom)
		}
		_ = w.WriteByte('}')
	}
	_ = w.WriteByte(']')
}

// buildFreshReady is handleFreshConnect's buildReady, called after
// registerNow: it reads timeoutView.gen before the build resolves the
// viewer's Subject and then records which member_timeouts list the ready
// carries (commitReadyTimeouts).
func (h *Hub) buildFreshReady(ctx context.Context, database ReadySnapshotReader, c *Client, role *db.Role) (*readyPayload, error) {
	gen := h.timeoutViewGenNow()
	ready, err := h.buildReady(ctx, database, c.userID, role, c.features)
	if ready != nil {
		h.commitReadyTimeouts(c, gen, ready.timeoutsFull)
	}
	return ready, err
}
