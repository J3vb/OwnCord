package ws_test

import (
	"encoding/json"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// ─── schema used by serve tests ───────────────────────────────────────────────

// serveTestSchema extends hubTestSchema with voice_states so that
// collectAllVoiceStates can be exercised via buildReady.
var serveTestSchema = append(hubTestSchema, []byte(`
CREATE TABLE IF NOT EXISTS voice_states (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted       INTEGER NOT NULL DEFAULT 0,
    deafened    INTEGER NOT NULL DEFAULT 0,
    speaking    INTEGER NOT NULL DEFAULT 0,
    camera      INTEGER NOT NULL DEFAULT 0,
    screenshare INTEGER NOT NULL DEFAULT 0,
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_states_channel_serve ON voice_states(channel_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL REFERENCES users(id),
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
`)...)

func openServeTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: serveTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

func newServeHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

// seedServeUser inserts an Owner-role user and returns the full *db.User.
func seedServeUser(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(username, "hash", 1)
	if err != nil {
		t.Fatalf("seedServeUser: %v", err)
	}
	user, err := database.GetUserByUsername(username)
	if err != nil || user == nil {
		t.Fatalf("seedServeUser GetUserByUsername: %v", err)
	}
	return user
}

// ownerRole fetches the Owner role (ID=1) for permission-aware buildReady calls.
func ownerRole(t *testing.T, database *db.DB) *db.Role {
	t.Helper()
	role, err := database.GetRoleByID(1)
	if err != nil || role == nil {
		t.Fatalf("ownerRole: %v", err)
	}
	return role
}

// ─── buildAuthOK ─────────────────────────────────────────────────────────────

func TestBuildAuthOK_Type(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "authok-user1")

	msg := hub.BuildAuthOKForTest(user, "admin")
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "auth_ok" {
		t.Errorf("type = %q, want auth_ok", env.Type)
	}
}

func TestBuildAuthOK_UserPayload(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "authok-user2")

	msg := hub.BuildAuthOKForTest(user, "member")
	var env struct {
		Payload struct {
			User struct {
				ID       int64  `json:"id"`
				Username string `json:"username"`
				Role     string `json:"role"`
			} `json:"user"`
			ServerName string `json:"server_name"`
			MOTD       string `json:"motd"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.User.ID != user.ID {
		t.Errorf("payload.user.id = %d, want %d", env.Payload.User.ID, user.ID)
	}
	if env.Payload.User.Username != user.Username {
		t.Errorf("payload.user.username = %q, want %q", env.Payload.User.Username, user.Username)
	}
	if env.Payload.User.Role != "member" {
		t.Errorf("payload.user.role = %q, want member", env.Payload.User.Role)
	}
}

func TestBuildAuthOK_ContainsServerName(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "authok-user3")

	msg := hub.BuildAuthOKForTest(user, "owner")
	var env struct {
		Payload struct {
			ServerName string `json:"server_name"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// server_name is seeded from settings table; must be non-empty.
	if env.Payload.ServerName == "" {
		t.Error("payload.server_name must not be empty")
	}
}

func TestBuildAuthOK_NilAvatar(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "authok-noavatar")
	// Avatar is nil by default after insert.

	msg := hub.BuildAuthOKForTest(user, "member")
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
		t.Errorf("payload.user.avatar = %v, want nil", env.Payload.User.Avatar)
	}
}

func TestBuildAuthOK_ValidJSON(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "authok-validjson")
	msg := hub.BuildAuthOKForTest(user, "member")
	if !json.Valid(msg) {
		t.Errorf("buildAuthOK output is not valid JSON: %s", msg)
	}
}

// ─── buildReady ───────────────────────────────────────────────────────────────

func TestBuildReady_Type(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "ready-user1")

	msg, err := hub.BuildReadyForTest(database, user.ID)
	if err != nil {
		t.Fatalf("BuildReadyForTest: %v", err)
	}
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Type != "ready" {
		t.Errorf("type = %q, want ready", env.Type)
	}
}

func TestBuildReady_ContainsRequiredFields(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "ready-user2")

	msg, err := hub.BuildReadyForTest(database, user.ID)
	if err != nil {
		t.Fatalf("BuildReadyForTest: %v", err)
	}

	var env struct {
		Payload struct {
			Channels    []any  `json:"channels"`
			Members     []any  `json:"members"`
			VoiceStates []any  `json:"voice_states"`
			Roles       []any  `json:"roles"`
			ServerName  string `json:"server_name"`
			MOTD        string `json:"motd"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// channels, members, voice_states, roles must all be present (even if empty slices).
	if env.Payload.Channels == nil {
		t.Error("payload.channels must not be nil")
	}
	if env.Payload.Members == nil {
		t.Error("payload.members must not be nil")
	}
	if env.Payload.VoiceStates == nil {
		t.Error("payload.voice_states must not be nil")
	}
	if env.Payload.Roles == nil {
		t.Error("payload.roles must not be nil")
	}
	if env.Payload.ServerName == "" {
		t.Error("payload.server_name must not be empty")
	}
}

func TestBuildReady_IncludesSeededChannel(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "ready-user3")
	role := ownerRole(t, database)

	// Seed a text channel.
	chID, err := database.CreateChannel("general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}

	var env struct {
		Payload struct {
			Channels []struct {
				ID   float64 `json:"id"`
				Name string  `json:"name"`
				Type string  `json:"type"`
			} `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	found := false
	for _, ch := range env.Payload.Channels {
		if int64(ch.ID) == chID && ch.Name == "general" && ch.Type == "text" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("ready payload does not include seeded channel (id=%d)", chID)
	}
}

func TestBuildReady_TextChannelHasUnreadCount(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "ready-user4")
	role := ownerRole(t, database)

	_, err := database.CreateChannel("unread-chan", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}

	var env struct {
		Payload struct {
			Channels []map[string]any `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	for _, ch := range env.Payload.Channels {
		if ch["type"] == "text" {
			if _, ok := ch["unread_count"]; !ok {
				t.Error("text channel missing unread_count field")
			}
			if _, ok := ch["last_message_id"]; !ok {
				t.Error("text channel missing last_message_id field")
			}
		}
	}
}

func TestBuildReady_ValidJSON(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "ready-validjson")
	msg, err := hub.BuildReadyForTest(database, user.ID)
	if err != nil {
		t.Fatalf("BuildReadyForTest: %v", err)
	}
	if !json.Valid(msg) {
		t.Errorf("buildReady output is not valid JSON: %s", msg)
	}
}

// ─── collectAllVoiceStates ────────────────────────────────────────────────────

func TestCollectAllVoiceStates_EmptyChannels(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "collect-empty-user")

	// No channels exist — ready should return empty voice_states.
	msg, err := hub.BuildReadyForTest(database, user.ID)
	if err != nil {
		t.Fatalf("BuildReadyForTest: %v", err)
	}
	var env struct {
		Payload struct {
			VoiceStates []any `json:"voice_states"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Payload.VoiceStates) != 0 {
		t.Errorf("voice_states = %d entries, want 0 with no channels", len(env.Payload.VoiceStates))
	}
}

func TestCollectAllVoiceStates_SkipsTextChannels(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "collect-text-user")

	// Only text channels — no voice states should be collected.
	_, err := database.CreateChannel("text-only", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	msg, err := hub.BuildReadyForTest(database, user.ID)
	if err != nil {
		t.Fatalf("BuildReadyForTest: %v", err)
	}
	var env struct {
		Payload struct {
			VoiceStates []any `json:"voice_states"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Payload.VoiceStates) != 0 {
		t.Errorf("voice_states = %d entries, want 0 for text-only channels", len(env.Payload.VoiceStates))
	}
}

func TestCollectAllVoiceStates_IncludesVoiceParticipants(t *testing.T) {
	hub, database := newServeHub(t)
	role := ownerRole(t, database)

	user1 := seedServeUser(t, database, "collect-voice-u1")
	user2 := seedServeUser(t, database, "collect-voice-u2")
	requester := seedServeUser(t, database, "collect-voice-req")

	chID, err := database.CreateChannel("voice-room", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	// Insert voice states for user1 and user2.
	if err := database.JoinVoiceChannel(user1.ID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel user1: %v", err)
	}
	if err := database.JoinVoiceChannel(user2.ID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel user2: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, requester.ID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}
	var env struct {
		Payload struct {
			VoiceStates []struct {
				ChannelID int64 `json:"channel_id"`
				UserID    int64 `json:"user_id"`
			} `json:"voice_states"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Payload.VoiceStates) != 2 {
		t.Errorf("voice_states count = %d, want 2", len(env.Payload.VoiceStates))
	}
	for _, vs := range env.Payload.VoiceStates {
		if vs.ChannelID != chID {
			t.Errorf("voice_state channel_id = %d, want %d", vs.ChannelID, chID)
		}
	}
}

// ─── Voice state filtering by channel visibility (BUG-095) ───────────────────

func TestBuildReady_VoiceStatesFilteredByVisibility(t *testing.T) {
	hub, database := newServeHub(t)

	// Create a member user (role 4, permissions=1635, includes ReadMessages).
	_, err := database.CreateUser("vs-member", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	member, err := database.GetUserByUsername("vs-member")
	if err != nil || member == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	memberRole, err := database.GetRoleByID(4)
	if err != nil || memberRole == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	// Create two voice channels: one visible, one denied.
	visibleCh, err := database.CreateChannel("public-voice", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel visible: %v", err)
	}
	hiddenCh, err := database.CreateChannel("hidden-voice", "voice", "", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel hidden: %v", err)
	}

	// Deny READ_MESSAGES on the hidden channel for Member role (role 4).
	_, err = database.Exec(
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 2)`,
		hiddenCh,
	)
	if err != nil {
		t.Fatalf("insert channel_override: %v", err)
	}

	// Create users in both voice channels.
	u1 := seedServeUser(t, database, "vs-visible-user")
	u2 := seedServeUser(t, database, "vs-hidden-user")
	if err := database.JoinVoiceChannel(u1.ID, visibleCh); err != nil {
		t.Fatalf("JoinVoiceChannel visible: %v", err)
	}
	if err := database.JoinVoiceChannel(u2.ID, hiddenCh); err != nil {
		t.Fatalf("JoinVoiceChannel hidden: %v", err)
	}

	// Build ready for the member — should only see voice states for visible channel.
	msg, err := hub.BuildReadyWithRoleForTest(database, member.ID, memberRole)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}

	var env struct {
		Payload struct {
			VoiceStates []struct {
				ChannelID int64 `json:"channel_id"`
			} `json:"voice_states"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Payload.VoiceStates) != 1 {
		t.Fatalf("voice_states count = %d, want 1 (only visible channel)", len(env.Payload.VoiceStates))
	}
	if env.Payload.VoiceStates[0].ChannelID != visibleCh {
		t.Errorf("voice_state channel_id = %d, want %d (visible)", env.Payload.VoiceStates[0].ChannelID, visibleCh)
	}
}

// ─── getCachedSettings ────────────────────────────────────────────────────────

func TestGetCachedSettings_CacheHit(t *testing.T) {
	hub, _ := newServeHub(t)

	// Call twice in quick succession; second call must return the same values
	// (cache hit path, no DB re-read within TTL).
	name1, motd1 := hub.GetCachedSettingsForTest()
	name2, motd2 := hub.GetCachedSettingsForTest()

	if name1 != name2 {
		t.Errorf("server_name changed between calls: %q vs %q", name1, name2)
	}
	if motd1 != motd2 {
		t.Errorf("motd changed between calls: %q vs %q", motd1, motd2)
	}
}

func TestGetCachedSettings_ReturnsNonEmptyValues(t *testing.T) {
	hub, _ := newServeHub(t)
	name, motd := hub.GetCachedSettingsForTest()
	if name == "" {
		t.Error("server_name must not be empty after NewHub")
	}
	if motd == "" {
		t.Error("motd must not be empty after NewHub")
	}
}

func TestGetCachedSettings_ReflectsDBValues(t *testing.T) {
	_, database := newServeHub(t)

	// Verify the default settings were loaded correctly from the seeded DB.
	var name string
	if err := database.QueryRow("SELECT value FROM settings WHERE key='server_name'").Scan(&name); err != nil {
		t.Fatalf("query server_name: %v", err)
	}
	if name != "OwnCord Server" {
		t.Errorf("DB server_name = %q, want OwnCord Server", name)
	}
}

// ─── Broadcast* hub methods ───────────────────────────────────────────────────

func TestHub_BroadcastServerRestart_DeliversToAllClients(t *testing.T) {
	hub, database := newServeHub(t)

	u1 := seedTestUser(t, database, "restart-u1")
	u2 := seedTestUser(t, database, "restart-u2")
	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, u1, s1))
	hub.Register(ws.NewTestClient(hub, u2, s2))
	time.Sleep(20 * time.Millisecond)

	hub.BroadcastServerRestart("update", 5)
	time.Sleep(20 * time.Millisecond)

	for _, s := range []chan []byte{s1, s2} {
		select {
		case msg := <-s:
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
				t.Errorf("payload.reason = %q, want update", env.Payload.Reason)
			}
			if env.Payload.DelaySeconds != 5 {
				t.Errorf("payload.delay_seconds = %d, want 5", env.Payload.DelaySeconds)
			}
		case <-time.After(500 * time.Millisecond):
			t.Error("client did not receive server_restart within timeout")
		}
	}
}

func TestHub_BroadcastServerRestart_NoClients_NoPanic(t *testing.T) {
	hub, _ := newServeHub(t)
	// Must not panic with no clients connected.
	hub.BroadcastServerRestart("maintenance", 30)
}

func TestHub_BroadcastChannelCreate_DeliversToAllClients(t *testing.T) {
	hub, database := newServeHub(t)

	u1 := seedTestUser(t, database, "chcreate-u1")
	s1 := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, u1, s1))
	time.Sleep(20 * time.Millisecond)

	ch := &db.Channel{ID: 77, Name: "announcements", Type: "text", Category: "News", Position: 1}
	hub.BroadcastChannelCreate(ch)
	time.Sleep(20 * time.Millisecond)

	select {
	case msg := <-s1:
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				ID   float64 `json:"id"`
				Name string  `json:"name"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env.Type != "channel_create" {
			t.Errorf("type = %q, want channel_create", env.Type)
		}
		if int64(env.Payload.ID) != ch.ID {
			t.Errorf("payload.id = %d, want %d", int64(env.Payload.ID), ch.ID)
		}
		if env.Payload.Name != ch.Name {
			t.Errorf("payload.name = %q, want %q", env.Payload.Name, ch.Name)
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("client did not receive channel_create within timeout")
	}
}

func TestHub_BroadcastChannelUpdate_DeliversToAllClients(t *testing.T) {
	hub, database := newServeHub(t)

	u1 := seedTestUser(t, database, "chupdate-u1")
	s1 := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, u1, s1))
	time.Sleep(20 * time.Millisecond)

	ch := &db.Channel{ID: 88, Name: "updated-channel", Type: "text", Category: "General", Position: 2}
	hub.BroadcastChannelUpdate(ch)
	time.Sleep(20 * time.Millisecond)

	select {
	case msg := <-s1:
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				ID   float64 `json:"id"`
				Name string  `json:"name"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env.Type != "channel_update" {
			t.Errorf("type = %q, want channel_update", env.Type)
		}
		if int64(env.Payload.ID) != ch.ID {
			t.Errorf("payload.id = %d, want %d", int64(env.Payload.ID), ch.ID)
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("client did not receive channel_update within timeout")
	}
}

func TestHub_BroadcastChannelDelete_DeliversToAllClients(t *testing.T) {
	hub, database := newServeHub(t)

	u1 := seedTestUser(t, database, "chdel-u1")
	s1 := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, u1, s1))
	time.Sleep(20 * time.Millisecond)

	hub.BroadcastChannelDelete(123)
	time.Sleep(20 * time.Millisecond)

	select {
	case msg := <-s1:
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				ID float64 `json:"id"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env.Type != "channel_delete" {
			t.Errorf("type = %q, want channel_delete", env.Type)
		}
		if int64(env.Payload.ID) != 123 {
			t.Errorf("payload.id = %d, want 123", int64(env.Payload.ID))
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("client did not receive channel_delete within timeout")
	}
}

func TestHub_BroadcastMemberBan_DeliversToAllClients(t *testing.T) {
	hub, database := newServeHub(t)

	u1 := seedTestUser(t, database, "ban-u1")
	s1 := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, u1, s1))
	time.Sleep(20 * time.Millisecond)

	hub.BroadcastMemberBan(999)
	time.Sleep(20 * time.Millisecond)

	select {
	case msg := <-s1:
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				UserID float64 `json:"user_id"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env.Type != "member_ban" {
			t.Errorf("type = %q, want member_ban", env.Type)
		}
		if int64(env.Payload.UserID) != 999 {
			t.Errorf("payload.user_id = %d, want 999", int64(env.Payload.UserID))
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("client did not receive member_ban within timeout")
	}
}

func TestHub_BroadcastMemberUpdate_DeliversToAllClients(t *testing.T) {
	hub, database := newServeHub(t)

	u1 := seedTestUser(t, database, "memupdate-u1")
	s1 := make(chan []byte, 4)
	hub.Register(ws.NewTestClient(hub, u1, s1))
	time.Sleep(20 * time.Millisecond)

	hub.BroadcastMemberUpdate(888, "moderator")
	time.Sleep(20 * time.Millisecond)

	select {
	case msg := <-s1:
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				UserID float64 `json:"user_id"`
				Role   string  `json:"role"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env.Type != "member_update" {
			t.Errorf("type = %q, want member_update", env.Type)
		}
		if int64(env.Payload.UserID) != 888 {
			t.Errorf("payload.user_id = %d, want 888", int64(env.Payload.UserID))
		}
		if env.Payload.Role != "moderator" {
			t.Errorf("payload.role = %q, want moderator", env.Payload.Role)
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("client did not receive member_update within timeout")
	}
}

func TestHub_BroadcastMemberBan_NoClients_NoPanic(t *testing.T) {
	hub, _ := newServeHub(t)
	hub.BroadcastMemberBan(1)
}

func TestHub_BroadcastMemberUpdate_NoClients_NoPanic(t *testing.T) {
	hub, _ := newServeHub(t)
	hub.BroadcastMemberUpdate(1, "member")
}

func TestHub_BroadcastChannelCreate_NoClients_NoPanic(t *testing.T) {
	hub, _ := newServeHub(t)
	hub.BroadcastChannelCreate(&db.Channel{ID: 1, Name: "x", Type: "text"})
}

func TestHub_BroadcastChannelUpdate_NoClients_NoPanic(t *testing.T) {
	hub, _ := newServeHub(t)
	hub.BroadcastChannelUpdate(&db.Channel{ID: 1, Name: "x", Type: "text"})
}

func TestHub_BroadcastChannelDelete_NoClients_NoPanic(t *testing.T) {
	hub, _ := newServeHub(t)
	hub.BroadcastChannelDelete(1)
}

// ─── getCachedSettings — cache expiry path ────────────────────────────────────

func TestGetCachedSettings_CacheMiss_RefreshesFromDB(t *testing.T) {
	hub, database := newServeHub(t)

	// Update the DB settings value so we can detect a refresh.
	_, err := database.Exec("UPDATE settings SET value='Refreshed Server' WHERE key='server_name'")
	if err != nil {
		t.Fatalf("UPDATE settings: %v", err)
	}

	// Force the cache to appear stale.
	hub.ExpireSettingsCacheForTest()

	// Next call must re-read from the DB and return the updated value.
	name, _ := hub.GetCachedSettingsForTest()
	if name != "Refreshed Server" {
		t.Errorf("server_name after cache miss = %q, want Refreshed Server", name)
	}
}

func TestGetCachedSettings_CacheMiss_DoubleCheck(t *testing.T) {
	// Expire the cache and call twice rapidly to exercise the double-check
	// (write-lock re-check) branch inside getCachedSettings.
	hub, _ := newServeHub(t)
	hub.ExpireSettingsCacheForTest()

	name1, _ := hub.GetCachedSettingsForTest()
	// Second call should hit the cache (now warm).
	name2, _ := hub.GetCachedSettingsForTest()
	if name1 != name2 {
		t.Errorf("server_name changed after refresh: %q vs %q", name1, name2)
	}
}

// ─── parseChannelID error paths ───────────────────────────────────────────────

func TestParseChannelID_ValidPayload(t *testing.T) {
	raw := json.RawMessage(`{"channel_id": 42}`)
	id, err := ws.ParseChannelIDForTest(raw)
	if err != nil {
		t.Fatalf("ParseChannelIDForTest: %v", err)
	}
	if id != 42 {
		t.Errorf("channel_id = %d, want 42", id)
	}
}

func TestParseChannelID_InvalidJSON(t *testing.T) {
	raw := json.RawMessage(`NOT JSON`)
	_, err := ws.ParseChannelIDForTest(raw)
	if err == nil {
		t.Error("expected error for invalid JSON, got nil")
	}
}

func TestParseChannelID_NonIntegerChannelID(t *testing.T) {
	raw := json.RawMessage(`{"channel_id": "not-a-number"}`)
	_, err := ws.ParseChannelIDForTest(raw)
	if err == nil {
		t.Error("expected error for non-integer channel_id, got nil")
	}
}

func TestParseChannelID_MissingField(t *testing.T) {
	// Missing channel_id field — json.Number.Int64 on zero value returns 0, no error.
	raw := json.RawMessage(`{}`)
	id, err := ws.ParseChannelIDForTest(raw)
	if err == nil && id != 0 {
		t.Errorf("expected id=0 for missing channel_id, got %d", id)
	}
}

// ─── buildJSON error fallback path ────────────────────────────────────────────

func TestBuildJSON_ValidValue_ReturnsJSON(t *testing.T) {
	// Normal path: marshalable value produces valid JSON.
	out := ws.BuildJSONForTest(map[string]string{"type": "test"})
	if !json.Valid(out) {
		t.Errorf("BuildJSONForTest output is not valid JSON: %s", out)
	}
}

// ─── buildReady error path (nil members fallback) ─────────────────────────────

func TestBuildReady_NoVoiceChannels_EmptyVoiceStates(t *testing.T) {
	hub, database := newServeHub(t)
	user := seedServeUser(t, database, "ready-novch")

	// Create only a text channel — voice_states list must still be non-nil.
	_, err := database.CreateChannel("text-chan", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	msg, err := hub.BuildReadyForTest(database, user.ID)
	if err != nil {
		t.Fatalf("BuildReadyForTest: %v", err)
	}
	var env struct {
		Payload struct {
			VoiceStates []any `json:"voice_states"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// collectAllVoiceStates returns []db.VoiceState{} (not nil) when no voice channels exist.
	if env.Payload.VoiceStates == nil {
		t.Error("voice_states must be a non-null JSON array even when empty")
	}
}
