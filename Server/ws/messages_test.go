package ws

import (
	"encoding/json"
	"testing"

	"github.com/owncord/server/db"
)

func TestBuildServerRestartMsg(t *testing.T) {
	msg := buildServerRestartMsg("update", 5)
	var env struct {
		Type    string `json:"type"`
		Payload struct {
			Reason       string `json:"reason"`
			DelaySeconds int    `json:"delay_seconds"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "server_restart" {
		t.Errorf("type = %q, want server_restart", env.Type)
	}
	if env.Payload.Reason != "update" {
		t.Errorf("reason = %q, want update", env.Payload.Reason)
	}
	if env.Payload.DelaySeconds != 5 {
		t.Errorf("delay_seconds = %d, want 5", env.Payload.DelaySeconds)
	}
}

// ─── channel CRUD message builders ───────────────────────────────────────────

// channelPayload is the common shape expected in channel_create/update payloads.
type channelPayload struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Category string `json:"category"`
	Topic    string `json:"topic"`
	Position int    `json:"position"`
}

func sampleChannel() *db.Channel {
	return &db.Channel{
		ID:       42,
		Name:     "general",
		Type:     "text",
		Category: "Main",
		Topic:    "All chat",
		Position: 3,
	}
}

func TestBuildChannelCreate_Type(t *testing.T) {
	msg := buildChannelCreate(sampleChannel())
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "channel_create" {
		t.Errorf("type = %q, want channel_create", env.Type)
	}
}

func TestBuildChannelCreate_Payload(t *testing.T) {
	ch := sampleChannel()
	msg := buildChannelCreate(ch)
	var env struct {
		Type    string         `json:"type"`
		Payload channelPayload `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	p := env.Payload
	if p.ID != ch.ID {
		t.Errorf("payload.id = %d, want %d", p.ID, ch.ID)
	}
	if p.Name != ch.Name {
		t.Errorf("payload.name = %q, want %q", p.Name, ch.Name)
	}
	if p.Type != ch.Type {
		t.Errorf("payload.type = %q, want %q", p.Type, ch.Type)
	}
	if p.Category != ch.Category {
		t.Errorf("payload.category = %q, want %q", p.Category, ch.Category)
	}
	if p.Topic != ch.Topic {
		t.Errorf("payload.topic = %q, want %q", p.Topic, ch.Topic)
	}
	if p.Position != ch.Position {
		t.Errorf("payload.position = %d, want %d", p.Position, ch.Position)
	}
}

func TestBuildChannelUpdate_Type(t *testing.T) {
	msg := buildChannelUpdate(sampleChannel())
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "channel_update" {
		t.Errorf("type = %q, want channel_update", env.Type)
	}
}

func TestBuildChannelUpdate_Payload(t *testing.T) {
	ch := sampleChannel()
	msg := buildChannelUpdate(ch)
	var env struct {
		Payload channelPayload `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	p := env.Payload
	if p.ID != ch.ID {
		t.Errorf("payload.id = %d, want %d", p.ID, ch.ID)
	}
	if p.Name != ch.Name {
		t.Errorf("payload.name = %q, want %q", p.Name, ch.Name)
	}
}

func TestBuildChannelDelete_Type(t *testing.T) {
	msg := buildChannelDelete(99)
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "channel_delete" {
		t.Errorf("type = %q, want channel_delete", env.Type)
	}
}

func TestBuildChannelDelete_Payload(t *testing.T) {
	msg := buildChannelDelete(99)
	var env struct {
		Payload struct {
			ID int64 `json:"id"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.ID != 99 {
		t.Errorf("payload.id = %d, want 99", env.Payload.ID)
	}
}

// TestBuildChannelCreate_ValidJSON verifies the output is always valid JSON.
func TestBuildChannelCreate_ValidJSON(t *testing.T) {
	msg := buildChannelCreate(sampleChannel())
	if !json.Valid(msg) {
		t.Errorf("buildChannelCreate output is not valid JSON: %s", msg)
	}
}

// TestBuildChannelUpdate_ValidJSON verifies the output is always valid JSON.
func TestBuildChannelUpdate_ValidJSON(t *testing.T) {
	msg := buildChannelUpdate(sampleChannel())
	if !json.Valid(msg) {
		t.Errorf("buildChannelUpdate output is not valid JSON: %s", msg)
	}
}

// TestBuildChannelDelete_ValidJSON verifies the output is always valid JSON.
func TestBuildChannelDelete_ValidJSON(t *testing.T) {
	msg := buildChannelDelete(1)
	if !json.Valid(msg) {
		t.Errorf("buildChannelDelete output is not valid JSON: %s", msg)
	}
}
