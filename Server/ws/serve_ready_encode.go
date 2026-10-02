package ws

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/J3vb/OwnCord/Server/db"
)

// readyFields is everything one viewer's ready carries, every read done.
type readyFields struct {
	head     readyHead
	tail     readyTail
	roster   *memberRoster
	viewerID int64
}

// readyPayload is one viewer's ready frame: the fields either side of members
// already encoded, and the shared roster that writeReady splices this
// viewer's presence into (P5-O01). Encoding first means a failure can only
// come before the first byte reaches the socket.
type readyPayload struct {
	head, tail []byte
	roster     *memberRoster
	viewerID   int64
}

// readyHead and readyTail are the payload fields before and after members,
// declared in sorted key order: ready used to be json.Marshal of a map, which
// sorts its keys, and the bytes must not change.
type readyHead struct {
	Capabilities map[string]any     `json:"capabilities"`
	Channels     []map[string]any   `json:"channels"`
	DMChannels   []db.DMChannelInfo `json:"dm_channels"`
}

type readyTail struct {
	MOTD        string               `json:"motd"`
	Notices     []readyNoticePayload `json:"notices"`
	Roles       []*db.Role           `json:"roles"`
	ServerName  string               `json:"server_name"`
	VoiceStates []db.VoiceState      `json:"voice_states"`
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
func (h *Hub) buildReady(ctx context.Context, database ReadySnapshotReader, userID int64, role *db.Role) (*readyPayload, error) {
	f, err := h.readReady(ctx, database, userID, role)
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
		head:     append(append([]byte(`{"payload":`), head[:len(head)-1]...), `,"members":`...),
		tail:     append(append([]byte{','}, tail[1:len(tail)-1]...), `},"type":"`+MsgTypeReady+`"}`...),
		roster:   f.roster,
		viewerID: f.viewerID,
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
