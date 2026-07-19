package ws

import (
	"encoding/json"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// TestChannelCanSend locks the composer-gating rule the client relies on:
// it must mirror MessageService.checkSendPermission for non-DM channels.
func TestChannelCanSend(t *testing.T) {
	admin := &db.Role{Permissions: permissions.Administrator}
	member := &db.Role{Permissions: permissions.ReadMessages | permissions.SendMessages}
	reader := &db.Role{Permissions: permissions.ReadMessages}
	mod := &db.Role{Permissions: permissions.ReadMessages | permissions.SendMessages | permissions.ManageMessages}
	none := db.ChannelOverride{}

	cases := []struct {
		name  string
		role  *db.Role
		o     db.ChannelOverride
		ctype string
		want  bool
	}{
		{"nil role fails closed", nil, none, "text", false},
		{"admin bypasses on text", admin, none, "text", true},
		{"admin bypasses on announcement", admin, none, "announcement", true},
		{"member can post in text", member, none, "text", true},
		{"reader without SEND cannot post", reader, none, "text", false},
		{"member without MANAGE cannot post in announcement", member, none, "announcement", false},
		{"moderator can post in announcement", mod, none, "announcement", true},
		{"override deny SEND blocks text", member, db.ChannelOverride{Deny: permissions.SendMessages}, "text", false},
		{"override allow MANAGE enables announcement", member, db.ChannelOverride{Allow: permissions.ManageMessages}, "announcement", true},
	}
	for _, c := range cases {
		if got := channelCanSend(c.role, c.o, c.ctype); got != c.want {
			t.Errorf("%s: channelCanSend = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestBuildErrorMsgWithID echoes the request id so the client can correlate a
// failure with the specific command it sent; an empty id omits the field.
func TestBuildErrorMsgWithID(t *testing.T) {
	withID := buildErrorMsgWithID(ErrCodeSlowMode, "slow down", "req-42")
	var env struct {
		Type    string `json:"type"`
		ID      string `json:"id"`
		Payload struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(withID, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.ID != "req-42" {
		t.Errorf("id = %q, want req-42", env.ID)
	}
	if env.Payload.Code != ErrCodeSlowMode {
		t.Errorf("code = %q, want %q", env.Payload.Code, ErrCodeSlowMode)
	}

	// Empty request id falls back to the id-less envelope.
	noID := buildErrorMsgWithID(ErrCodeSlowMode, "slow down", "")
	var raw map[string]any
	if err := json.Unmarshal(noID, &raw); err != nil {
		t.Fatalf("unmarshal noID: %v", err)
	}
	if _, present := raw["id"]; present {
		t.Error("empty reqID should omit the id field")
	}
}
