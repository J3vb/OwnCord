package ws

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// SeedSessionToken creates a session for userID and returns its bearer token.
func SeedSessionToken(t *testing.T, database *db.DB, userID int64) string {
	t.Helper()
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

// requireClientErrorCode asserts err is a ClientError carrying code; missing
// is the failure message used when err is nil.
func requireClientErrorCode(t *testing.T, err error, code, missing string) {
	t.Helper()
	if err == nil && missing != "" {
		t.Fatal(missing)
	}
	var ce ClientError
	if !errors.As(err, &ce) {
		t.Fatalf("expected ClientError, got %T", err)
	}
	if ce.Code != code {
		t.Errorf("expected code %q, got %q", code, ce.Code)
	}
}

// MustCreateUser inserts a user holding roleID and returns its ID.
func MustCreateUser(t testing.TB, database *db.DB, username string, roleID int) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), username, "hash", roleID)
	if err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	return id
}

// MustJoinVoice records userID's voice_states row in chID.
func MustJoinVoice(t testing.TB, database *db.DB, userID, chID int64) {
	t.Helper()
	if err := database.JoinVoiceChannel(context.Background(), userID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel(user=%d, channel=%d): %v", userID, chID, err)
	}
}

// MustCreateChannel creates a channel of the given type ("text", "voice").
func MustCreateChannel(t testing.TB, database *db.DB, name, kind string) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), name, kind, "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(%s, %s): %v", name, kind, err)
	}
	return id
}

// MustExec runs a statement the test needs applied, failing the test if not.
func MustExec(t testing.TB, database *db.DB, query string, args ...any) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

// MustGetUser loads a user row by ID.
func MustGetUser(t testing.TB, database *db.DB, userID int64) *db.User {
	t.Helper()
	user, err := database.GetUserByID(context.Background(), userID)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID(%d): user=%v err=%v", userID, user, err)
	}
	return user
}

// MustCreateMessage inserts a message and returns its ID.
func MustCreateMessage(t testing.TB, database *db.DB, channelID, userID int64, content string) int64 {
	t.Helper()
	id, err := database.CreateMessage(context.Background(), channelID, userID, content, nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return id
}

// Unexported spellings for the internal tests; ws_test reaches the same
// implementations through the exported names.
var (
	mustCreateUser    = MustCreateUser
	mustJoinVoice     = MustJoinVoice
	mustCreateChannel = MustCreateChannel
	mustExec          = MustExec
	mustGetUser       = MustGetUser
	mustCreateMessage = MustCreateMessage
	seedSessionToken  = SeedSessionToken
)
