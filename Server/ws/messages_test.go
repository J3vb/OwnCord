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

// ─── buildAuthError ───────────────────────────────────────────────────────────

func TestBuildAuthError_Type(t *testing.T) {
	msg := buildAuthError("invalid token")
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "auth_error" {
		t.Errorf("type = %q, want auth_error", env.Type)
	}
}

func TestBuildAuthError_Payload(t *testing.T) {
	msg := buildAuthError("session expired")
	var env struct {
		Payload struct {
			Message string `json:"message"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.Message != "session expired" {
		t.Errorf("payload.message = %q, want session expired", env.Payload.Message)
	}
}

func TestBuildAuthError_ValidJSON(t *testing.T) {
	msg := buildAuthError("bad token")
	if !json.Valid(msg) {
		t.Errorf("buildAuthError output is not valid JSON: %s", msg)
	}
}

// ─── buildMemberJoin ──────────────────────────────────────────────────────────

func TestBuildMemberJoin_Type(t *testing.T) {
	user := &db.User{ID: 1, Username: "alice"}
	msg := buildMemberJoin(user, "member")
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "member_join" {
		t.Errorf("type = %q, want member_join", env.Type)
	}
}

func TestBuildMemberJoin_Payload(t *testing.T) {
	user := &db.User{ID: 42, Username: "alice"}
	msg := buildMemberJoin(user, "admin")
	var env struct {
		Payload struct {
			User struct {
				ID       int64  `json:"id"`
				Username string `json:"username"`
				Role     string `json:"role"`
			} `json:"user"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	u := env.Payload.User
	if u.ID != 42 {
		t.Errorf("user.id = %d, want 42", u.ID)
	}
	if u.Username != "alice" {
		t.Errorf("user.username = %q, want alice", u.Username)
	}
	if u.Role != "admin" {
		t.Errorf("user.role = %q, want admin", u.Role)
	}
}

func TestBuildMemberJoin_NilAvatar(t *testing.T) {
	user := &db.User{ID: 1, Username: "noavatar", Avatar: nil}
	msg := buildMemberJoin(user, "member")
	var env struct {
		Payload struct {
			User struct {
				Avatar any `json:"avatar"`
			} `json:"user"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.User.Avatar != nil {
		t.Errorf("avatar = %v, want nil for nil avatar", env.Payload.User.Avatar)
	}
}

func TestBuildMemberJoin_NonNilAvatar(t *testing.T) {
	avatarURL := "https://example.com/avatar.png"
	user := &db.User{ID: 1, Username: "withavatar", Avatar: &avatarURL}
	msg := buildMemberJoin(user, "member")
	var env struct {
		Payload struct {
			User struct {
				Avatar string `json:"avatar"`
			} `json:"user"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.User.Avatar != avatarURL {
		t.Errorf("avatar = %q, want %q", env.Payload.User.Avatar, avatarURL)
	}
}

// ─── buildMemberUpdate ────────────────────────────────────────────────────────

func TestBuildMemberUpdate_Type(t *testing.T) {
	msg := buildMemberUpdate(7, "moderator")
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "member_update" {
		t.Errorf("type = %q, want member_update", env.Type)
	}
}

func TestBuildMemberUpdate_Payload(t *testing.T) {
	msg := buildMemberUpdate(7, "moderator")
	var env struct {
		Payload struct {
			UserID int64  `json:"user_id"`
			Role   string `json:"role"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.UserID != 7 {
		t.Errorf("payload.user_id = %d, want 7", env.Payload.UserID)
	}
	if env.Payload.Role != "moderator" {
		t.Errorf("payload.role = %q, want moderator", env.Payload.Role)
	}
}

// ─── buildMemberBan ───────────────────────────────────────────────────────────

func TestBuildMemberBan_Type(t *testing.T) {
	msg := buildMemberBan(55)
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "member_ban" {
		t.Errorf("type = %q, want member_ban", env.Type)
	}
}

func TestBuildMemberBan_Payload(t *testing.T) {
	msg := buildMemberBan(55)
	var env struct {
		Payload struct {
			UserID int64 `json:"user_id"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.UserID != 55 {
		t.Errorf("payload.user_id = %d, want 55", env.Payload.UserID)
	}
}

func TestBuildMemberBan_ValidJSON(t *testing.T) {
	if !json.Valid(buildMemberBan(1)) {
		t.Error("buildMemberBan output is not valid JSON")
	}
}

// ─── buildChatEdited ──────────────────────────────────────────────────────────

func TestBuildChatEdited_Type(t *testing.T) {
	msg := buildChatEdited(10, 20, "new content", "2024-01-01T00:00:00Z")
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "chat_edited" {
		t.Errorf("type = %q, want chat_edited", env.Type)
	}
}

func TestBuildChatEdited_Payload(t *testing.T) {
	msg := buildChatEdited(10, 20, "new content", "2024-01-01T00:00:00Z")
	var env struct {
		Payload struct {
			MessageID int64  `json:"message_id"`
			ChannelID int64  `json:"channel_id"`
			Content   string `json:"content"`
			EditedAt  string `json:"edited_at"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	p := env.Payload
	if p.MessageID != 10 {
		t.Errorf("payload.message_id = %d, want 10", p.MessageID)
	}
	if p.ChannelID != 20 {
		t.Errorf("payload.channel_id = %d, want 20", p.ChannelID)
	}
	if p.Content != "new content" {
		t.Errorf("payload.content = %q, want new content", p.Content)
	}
	if p.EditedAt != "2024-01-01T00:00:00Z" {
		t.Errorf("payload.edited_at = %q, want 2024-01-01T00:00:00Z", p.EditedAt)
	}
}

// ─── buildChatDeleted ─────────────────────────────────────────────────────────

func TestBuildChatDeleted_Type(t *testing.T) {
	msg := buildChatDeleted(11, 22)
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "chat_deleted" {
		t.Errorf("type = %q, want chat_deleted", env.Type)
	}
}

func TestBuildChatDeleted_Payload(t *testing.T) {
	msg := buildChatDeleted(11, 22)
	var env struct {
		Payload struct {
			MessageID int64 `json:"message_id"`
			ChannelID int64 `json:"channel_id"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.MessageID != 11 {
		t.Errorf("payload.message_id = %d, want 11", env.Payload.MessageID)
	}
	if env.Payload.ChannelID != 22 {
		t.Errorf("payload.channel_id = %d, want 22", env.Payload.ChannelID)
	}
}

func TestBuildChatDeleted_ValidJSON(t *testing.T) {
	if !json.Valid(buildChatDeleted(1, 2)) {
		t.Error("buildChatDeleted output is not valid JSON")
	}
}

// ─── buildReactionUpdate ──────────────────────────────────────────────────────

func TestBuildReactionUpdate_Type(t *testing.T) {
	msg := buildReactionUpdate(1, 2, 3, "👍", "add")
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "reaction_update" {
		t.Errorf("type = %q, want reaction_update", env.Type)
	}
}

func TestBuildReactionUpdate_Payload(t *testing.T) {
	msg := buildReactionUpdate(100, 200, 300, "❤️", "remove")
	var env struct {
		Payload struct {
			MessageID int64  `json:"message_id"`
			ChannelID int64  `json:"channel_id"`
			UserID    int64  `json:"user_id"`
			Emoji     string `json:"emoji"`
			Action    string `json:"action"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	p := env.Payload
	if p.MessageID != 100 {
		t.Errorf("payload.message_id = %d, want 100", p.MessageID)
	}
	if p.ChannelID != 200 {
		t.Errorf("payload.channel_id = %d, want 200", p.ChannelID)
	}
	if p.UserID != 300 {
		t.Errorf("payload.user_id = %d, want 300", p.UserID)
	}
	if p.Emoji != "❤️" {
		t.Errorf("payload.emoji = %q, want ❤️", p.Emoji)
	}
	if p.Action != "remove" {
		t.Errorf("payload.action = %q, want remove", p.Action)
	}
}

func TestBuildReactionUpdate_ValidJSON(t *testing.T) {
	if !json.Valid(buildReactionUpdate(1, 2, 3, "😀", "add")) {
		t.Error("buildReactionUpdate output is not valid JSON")
	}
}

// ─── buildTypingMsg ───────────────────────────────────────────────────────────

func TestBuildTypingMsg_Type(t *testing.T) {
	msg := buildTypingMsg(5, 10, "alice")
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "typing" {
		t.Errorf("type = %q, want typing", env.Type)
	}
}

func TestBuildTypingMsg_Payload(t *testing.T) {
	msg := buildTypingMsg(5, 10, "alice")
	var env struct {
		Payload struct {
			ChannelID int64  `json:"channel_id"`
			UserID    int64  `json:"user_id"`
			Username  string `json:"username"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	p := env.Payload
	if p.ChannelID != 5 {
		t.Errorf("payload.channel_id = %d, want 5", p.ChannelID)
	}
	if p.UserID != 10 {
		t.Errorf("payload.user_id = %d, want 10", p.UserID)
	}
	if p.Username != "alice" {
		t.Errorf("payload.username = %q, want alice", p.Username)
	}
}

func TestBuildTypingMsg_ValidJSON(t *testing.T) {
	if !json.Valid(buildTypingMsg(1, 2, "user")) {
		t.Error("buildTypingMsg output is not valid JSON")
	}
}

// ─── buildVoiceToken ──────────────────────────────────────────────────────────

func TestBuildVoiceToken_Type(t *testing.T) {
	msg := buildVoiceToken(99, "jwt-token", "/livekit", "ws://localhost:7880")
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "voice_token" {
		t.Errorf("type = %q, want voice_token", env.Type)
	}
}

func TestBuildVoiceToken_Payload(t *testing.T) {
	msg := buildVoiceToken(99, "jwt-token", "/livekit", "ws://localhost:7880")
	var env struct {
		Payload struct {
			ChannelID int64  `json:"channel_id"`
			Token     string `json:"token"`
			URL       string `json:"url"`
			DirectURL string `json:"direct_url"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.ChannelID != 99 {
		t.Errorf("payload.channel_id = %d, want 99", env.Payload.ChannelID)
	}
	if env.Payload.Token != "jwt-token" {
		t.Errorf("payload.token = %q, want jwt-token", env.Payload.Token)
	}
	if env.Payload.URL != "/livekit" {
		t.Errorf("payload.url = %q, want /livekit", env.Payload.URL)
	}
	if env.Payload.DirectURL != "ws://localhost:7880" {
		t.Errorf("payload.direct_url = %q, want ws://localhost:7880", env.Payload.DirectURL)
	}
}

func TestBuildVoiceToken_ValidJSON(t *testing.T) {
	if !json.Valid(buildVoiceToken(1, "t", "/livekit", "ws://a")) {
		t.Error("buildVoiceToken output is not valid JSON")
	}
}
