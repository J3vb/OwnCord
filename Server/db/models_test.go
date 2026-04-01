package db_test

import (
	"encoding/json"
	"testing"

	"github.com/owncord/server/db"
)

// ─── Role JSON round-trip ────────────────────────────────────────────────────

func TestRole_JSONRoundTrip(t *testing.T) {
	color := "#ff0000"
	original := db.Role{
		ID:          1,
		Name:        "admin",
		Color:       &color,
		Permissions: 0x40000000,
		Position:    100,
		IsDefault:   false,
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded db.Role
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded.ID != original.ID {
		t.Errorf("ID = %d, want %d", decoded.ID, original.ID)
	}
	if decoded.Name != original.Name {
		t.Errorf("Name = %q, want %q", decoded.Name, original.Name)
	}
	if decoded.Color == nil || *decoded.Color != color {
		t.Errorf("Color = %v, want %q", decoded.Color, color)
	}
	if decoded.Permissions != original.Permissions {
		t.Errorf("Permissions = %d, want %d", decoded.Permissions, original.Permissions)
	}
	if decoded.Position != original.Position {
		t.Errorf("Position = %d, want %d", decoded.Position, original.Position)
	}
	if decoded.IsDefault != original.IsDefault {
		t.Errorf("IsDefault = %v, want %v", decoded.IsDefault, original.IsDefault)
	}
}

func TestRole_JSONKeys(t *testing.T) {
	role := db.Role{ID: 1, Name: "member", Permissions: 3, Position: 1, IsDefault: true}
	data, _ := json.Marshal(role)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal to map: %v", err)
	}

	expectedKeys := []string{"id", "name", "color", "permissions", "position", "is_default"}
	for _, k := range expectedKeys {
		if _, ok := raw[k]; !ok {
			t.Errorf("missing JSON key %q", k)
		}
	}
}

func TestRole_NilColor(t *testing.T) {
	role := db.Role{ID: 1, Name: "member"}
	data, _ := json.Marshal(role)

	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if raw["color"] != nil {
		t.Errorf("nil Color should serialize as null, got %v", raw["color"])
	}
}

// ─── Channel JSON round-trip ─────────────────────────────────────────────────

func TestChannel_JSONRoundTrip(t *testing.T) {
	quality := "high"
	threshold := 10
	original := db.Channel{
		ID:              42,
		Name:            "general",
		Type:            "text",
		Category:        "Main",
		Topic:           "General chat",
		Position:        0,
		SlowMode:        5,
		Archived:        false,
		CreatedAt:       "2026-01-01T00:00:00Z",
		VoiceMaxUsers:   25,
		VoiceQuality:    &quality,
		MixingThreshold: &threshold,
		VoiceMaxVideo:   4,
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded db.Channel
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded.ID != original.ID || decoded.Name != original.Name {
		t.Errorf("basic fields mismatch: got ID=%d Name=%q", decoded.ID, decoded.Name)
	}
	if decoded.VoiceQuality == nil || *decoded.VoiceQuality != quality {
		t.Errorf("VoiceQuality = %v, want %q", decoded.VoiceQuality, quality)
	}
	if decoded.MixingThreshold == nil || *decoded.MixingThreshold != threshold {
		t.Errorf("MixingThreshold = %v, want %d", decoded.MixingThreshold, threshold)
	}
}

func TestChannel_OmitEmptyFields(t *testing.T) {
	ch := db.Channel{ID: 1, Name: "voice-1", Type: "voice"}
	data, _ := json.Marshal(ch)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	// voice_quality and mixing_threshold have omitempty — should be absent when nil.
	if _, ok := raw["voice_quality"]; ok {
		t.Error("nil VoiceQuality should be omitted")
	}
	if _, ok := raw["mixing_threshold"]; ok {
		t.Error("nil MixingThreshold should be omitted")
	}
}

// ─── VoiceState JSON ─────────────────────────────────────────────────────────

func TestVoiceState_JoinedAtOmittedFromJSON(t *testing.T) {
	vs := db.VoiceState{
		UserID:    1,
		ChannelID: 2,
		Username:  "alice",
		JoinedAt:  "2026-01-01T00:00:00Z",
	}

	data, _ := json.Marshal(vs)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if _, ok := raw["JoinedAt"]; ok {
		t.Error("JoinedAt has json:\"-\" tag and should not appear in JSON output")
	}
	if _, ok := raw["joined_at"]; ok {
		t.Error("JoinedAt should not appear under any key in JSON output")
	}
}

func TestVoiceState_BoolDefaults(t *testing.T) {
	vs := db.VoiceState{UserID: 1, ChannelID: 2, Username: "bob"}
	data, _ := json.Marshal(vs)

	var decoded db.VoiceState
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded.Muted || decoded.Deafened || decoded.Speaking || decoded.Camera || decoded.Screenshare {
		t.Error("zero-value VoiceState bools should all be false")
	}
}

// ─── MessageAPIResponse JSON ─────────────────────────────────────────────────

func TestMessageAPIResponse_JSONKeys(t *testing.T) {
	resp := db.MessageAPIResponse{
		ID:          1,
		ChannelID:   2,
		User:        db.UserPublic{ID: 3, Username: "alice"},
		Content:     "hello",
		Attachments: []db.AttachmentInfo{},
		Reactions:   []db.ReactionInfo{},
		Timestamp:   "2026-01-01T00:00:00Z",
	}

	data, _ := json.Marshal(resp)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	required := []string{
		"id", "channel_id", "user", "content", "reply_to",
		"attachments", "reactions", "pinned", "edited_at", "deleted", "timestamp",
	}
	for _, k := range required {
		if _, ok := raw[k]; !ok {
			t.Errorf("missing required JSON key %q", k)
		}
	}
}

// ─── AttachmentInfo omitempty ─────────────────────────────────────────────────

func TestAttachmentInfo_OmitsNilDimensions(t *testing.T) {
	att := db.AttachmentInfo{
		ID: "abc", Filename: "doc.pdf", Size: 1024, Mime: "application/pdf", URL: "/files/abc",
	}
	data, _ := json.Marshal(att)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if _, ok := raw["width"]; ok {
		t.Error("nil Width should be omitted")
	}
	if _, ok := raw["height"]; ok {
		t.Error("nil Height should be omitted")
	}
}

func TestAttachmentInfo_IncludesDimensions(t *testing.T) {
	w, h := 1920, 1080
	att := db.AttachmentInfo{
		ID: "abc", Filename: "img.png", Size: 2048, Mime: "image/png",
		URL: "/files/abc", Width: &w, Height: &h,
	}
	data, _ := json.Marshal(att)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if _, ok := raw["width"]; !ok {
		t.Error("non-nil Width should be present")
	}
	if _, ok := raw["height"]; !ok {
		t.Error("non-nil Height should be present")
	}
}

// ─── UserPublic omitempty ────────────────────────────────────────────────────

func TestUserPublic_OmitsNilAvatar(t *testing.T) {
	u := db.UserPublic{ID: 1, Username: "alice"}
	data, _ := json.Marshal(u)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if _, ok := raw["avatar"]; ok {
		t.Error("nil Avatar should be omitted")
	}
}

func TestUserPublic_IncludesAvatar(t *testing.T) {
	av := "avatar.png"
	u := db.UserPublic{ID: 1, Username: "alice", Avatar: &av}
	data, _ := json.Marshal(u)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if _, ok := raw["avatar"]; !ok {
		t.Error("non-nil Avatar should be present")
	}
}

// ─── ServerStats JSON ────────────────────────────────────────────────────────

func TestServerStats_JSONRoundTrip(t *testing.T) {
	original := db.ServerStats{
		UserCount:    150,
		MessageCount: 50000,
		ChannelCount: 20,
		InviteCount:  5,
		DBSizeBytes:  1048576,
		OnlineCount:  42,
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded db.ServerStats
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if decoded != original {
		t.Errorf("round-trip mismatch:\n  got  %+v\n  want %+v", decoded, original)
	}
}

// ─── AuditEntry JSON ─────────────────────────────────────────────────────────

func TestAuditEntry_JSONKeys(t *testing.T) {
	entry := db.AuditEntry{
		ID: 1, ActorID: 2, ActorName: "admin", Action: "ban_user",
		TargetType: "user", TargetID: 3, Detail: "reason", CreatedAt: "2026-01-01",
	}

	data, _ := json.Marshal(entry)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	required := []string{"id", "actor_id", "actor_name", "action", "target_type", "target_id", "detail", "created_at"}
	for _, k := range required {
		if _, ok := raw[k]; !ok {
			t.Errorf("missing JSON key %q", k)
		}
	}
}
